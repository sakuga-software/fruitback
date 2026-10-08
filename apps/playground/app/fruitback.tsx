import { Button } from '@heroui/react';
import { canonicalizePageUrl, type SeedIssue, type SeedReporter } from '@fruitback/shared';
import {
  type CaptureHost,
  type CaptureTarget,
  type Composer,
  type ConfigPanel,
  type ConfigStore,
  type Overlay,
  captureSeed,
  createCaptureHost,
  createComposer,
  createConfigPanel,
  createConfigStore,
  createOverlay,
  createTranslator,
  feedbackAsText,
  languageOf,
  placementOf,
} from '@fruitback/widget';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { redeploy, removeCard } from './site-state';

/**
 * The widget, mounted the way a client site would mount it — and the dev toolbar, which is not part
 * of the product.
 *
 * Three things are specific to a React host and were untestable on the static playground:
 *
 * - **It mounts in an effect**, so it arrives after hydration. Mounting during render would put the
 *   host in the DOM before React finished claiming it.
 * - **It re-reads on navigation.** A pin belongs to a URL, and on a client-rendered app nothing else
 *   announces that the page changed.
 * - **`source` finally has something to read.** `getElementContext` walks the React fiber, so a note
 *   captured here carries the component and the file it came from — the half of a seed that had
 *   never been exercised end to end.
 */

const CLIENT_ID = 'playground';
const WORKER_ORIGIN = import.meta.env.VITE_FRUITBACK_WORKER ?? 'http://localhost:8788';
/** A sentence for the toolbar of a deployed playground. Absent in the dev loop and in the E2E suite. */
const DEMO_NOTICE: string | undefined = import.meta.env.VITE_FRUITBACK_DEMO_NOTICE || undefined;

export function Fruitback() {
  const location = useLocation();
  const [status, setStatus] = useState('—');
  /**
   * The last identifier planted, kept apart from `status` on purpose.
   *
   * `status` has two writers: this component, and the widget reporting a re-resolution it decided on
   * by itself (FRU-21). They race — a confirmation would be overwritten by a pin count arriving a
   * hundred milliseconds later — so the one fact a test needs to synchronise on lives on its own.
   */
  const [planted, setPlanted] = useState('');
  const widget = useRef<{
    host: CaptureHost;
    overlay: Overlay;
    composer: Composer;
    panel: ConfigPanel;
    config: ConfigStore;
    refresh: () => Promise<void>;
  } | null>(null);
  const target = useRef<CaptureTarget | null>(null);

  useEffect(() => {
    // The reporter's own preferences, kept in this browser (FRU-14). The worker comes from
    // `VITE_FRUITBACK_WORKER`, never from here (FRU-89).
    const config = createConfigStore({
      // `screenshot` off: this harness gives the widget no way to capture one, so the toggle is not
      // even offered here — `e2e/screenshot.spec.ts` mounts the built bundle with a capture function
      // instead, which is what an embedder does.
      defaults: { hiddenStages: [], screenshot: false },
    });

    const host = createCaptureHost({
      onSelect: (selected) => {
        target.current = selected;
        const rect = selected.element.getBoundingClientRect();
        widget.current?.composer.open({
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY,
          right: rect.right + window.scrollX,
        });
        setStatus(selected.source?.component ? `cible : <${selected.source.component}>` : 'cible sélectionnée');
      },
      // The dev toolbar is the playground's, not the widget's and not the page's.
      ignore: (element) => element.closest('[data-fruitback-dev]') !== null,
      onConfigure: () => widget.current?.panel.toggle(),
    });

    const overlay = createOverlay({
      host: host.root,
      shouldShow: (issue) => !config.get().hiddenStages.includes(issue.stage),
      onSelect: (issue) => setStatus(`${issue.identifier} · ${issue.stateName}`),
      // The widget re-resolves by itself when the page changes (FRU-21). This only reports it: the
      // host never has to work out that it re-rendered.
      onResolve: (entries) => setStatus(`${entries.length} pin${entries.length > 1 ? 's' : ''}`),
    });

    const refresh = createRefresher(overlay, setStatus);

    const composer = createComposer({
      host: host.panel,
      memory: {
        get: () => config.get().reporterName,
        set: (name) => config.set({ reporterName: name }),
      },
      onSubmit: async (note, reporter) => {
        const identifier = await plant(note, target.current, setStatus, reporter);
        if (identifier === null) return false;

        // Re-read first — that is what proves the read path answers — and let the confirmation have
        // the last word, or the status flips back to a pin count nobody asked for.
        await refresh();
        setPlanted(identifier);
        setStatus(`planté · ${identifier}`);

        return true;
      },
    });

    const panel = createConfigPanel({
      host: host.root,
      store: config,
      exportText: () =>
        feedbackAsText(
          overlay.resolutions().map((resolution) => ({ issue: resolution.issue, placement: placementOf(resolution) })),
          {
            pageUrl: canonicalizePageUrl(window.location.href),
            translator: createTranslator({ language: languageOf(document) }),
          },
        ),
    });

    // A preference change redraws from the issues already held.
    const unsubscribe = config.subscribe(() => overlay.refilter());

    widget.current = { host, overlay, composer, panel, config, refresh };

    return () => {
      unsubscribe();
      panel.destroy();
      composer.destroy();
      overlay.destroy();
      host.destroy();
      widget.current = null;
    };
  }, []);

  // A pin belongs to a page: a client-side navigation changes the canonical URL, so it changes which
  // seeds belong on screen.
  useEffect(() => {
    const current = widget.current;
    if (current !== null) void current.refresh();
  }, [location.pathname, location.search]);

  return (
    <DevToolbar
      status={status}
      planted={planted}
      onReload={() => {
        const current = widget.current;
        if (current !== null) void current.refresh();
      }}
    />
  );
}

/** The issue identifier when it was planted, `null` when the worker refused. */
async function plant(
  note: string,
  target: CaptureTarget | null,
  setStatus: (message: string) => void,
  reporter: SeedReporter | undefined,
): Promise<string | null> {
  if (target === null) return null;

  const seed = captureSeed({
    element: target.element,
    note,
    client: { id: CLIENT_ID, name: 'Playground' },
    // What the visitor typed about themselves, and no more. The worker stores it as self-declared
    // and strips any `verified` flag — an identity would need a signed token this playground has no
    // reason to mint (FRU-9).
    reporter,
    // Straight from react-grab, through the host — and on this app there is a fiber to read.
    source: target.source,
  });

  const response = await fetch(`${WORKER_ORIGIN}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seed),
  });

  if (!response.ok) {
    setStatus(`le worker a répondu ${response.status}`);

    return null;
  }

  const { issue } = (await response.json()) as { issue: { identifier: string } };

  return issue.identifier;
}

/**
 * Reads that ignore their own stale answers.
 *
 * Two reads can be in flight — a note just planted, then a navigation — and nothing makes them
 * settle in the order they were sent. The late one would then render the pins of the old page over
 * the correct ones, or overwrite a good pin count with `worker injoignable`. Each call takes a generation, and only the newest is allowed to touch the
 * screen.
 */
function createRefresher(overlay: Overlay, setStatus: (message: string) => void): () => Promise<void> {
  let generation = 0;

  return async function refresh(): Promise<void> {
    const mine = ++generation;
    const current = () => mine === generation;
    const url = canonicalizePageUrl(window.location.href);

    try {
      const response = await fetch(`${WORKER_ORIGIN}/feedback?url=${encodeURIComponent(url)}&client=${CLIENT_ID}`);
      if (!current()) return;

      if (!response.ok) {
        setStatus(`lecture impossible · ${response.status}`);

        return;
      }

      const { issues } = (await response.json()) as { issues: SeedIssue[] };
      if (!current()) return;

      overlay.render(issues);
      setStatus(`${issues.length} pin${issues.length > 1 ? 's' : ''}`);
    } catch {
      if (!current()) return;

      setStatus(`worker injoignable sur ${WORKER_ORIGIN}`);
    }
  };
}

/** Dev-only chrome. Marked `data-fruitback-dev` so pointing at it never captures it. */
function DevToolbar({ status, planted, onReload }: { status: string; planted: string; onReload: () => void }) {
  return (
    <div
      data-fruitback-dev="toolbar"
      className="fixed bottom-4 left-4 z-[2147483001] flex max-w-[calc(100vw-18rem)] flex-wrap items-center gap-2 rounded-xl bg-stone-900 px-4 py-3 text-sm text-stone-50 shadow-lg"
    >
      <strong>
        Fruitback <span className="rounded bg-red-600 px-1.5 py-0.5 font-semibold">playground</span>
      </strong>
      <Button data-fruitback-dev="reload" size="sm" variant="secondary" onPress={onReload}>
        Recharger les pins
      </Button>
      <Button data-fruitback-dev="redeploy" size="sm" variant="secondary" onPress={() => redeploy()}>
        Redéployer
      </Button>
      <Button data-fruitback-dev="remove-latte" size="sm" variant="secondary" onPress={() => removeCard('latte')}>
        Supprimer la carte Latte
      </Button>
      {/* Written once per successful plant and never overwritten — see `planted` above. */}
      <span data-fruitback-dev="planted" hidden>
        {planted}
      </span>
      <span data-fruitback-dev="status" className="min-w-[150px] opacity-70">
        {status}
      </span>
      {/* The public demonstration (FRU-79): anybody can write here, so the page says what it is. */}
      {DEMO_NOTICE !== undefined ? (
        <span data-fruitback-dev="demo" className="basis-full opacity-90">
          {DEMO_NOTICE}
        </span>
      ) : null}
    </div>
  );
}
