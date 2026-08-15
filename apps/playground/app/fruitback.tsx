import { Button } from '@heroui/react';
import { canonicalizePageUrl, type SeedIssue } from '@fruitback/shared';
import {
  type CaptureHost,
  type CaptureTarget,
  type Composer,
  type Overlay,
  captureSeed,
  createCaptureHost,
  createComposer,
  createOverlay,
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

export function Fruitback() {
  const location = useLocation();
  const [status, setStatus] = useState('—');
  const widget = useRef<{ host: CaptureHost; overlay: Overlay; composer: Composer } | null>(null);
  const target = useRef<CaptureTarget | null>(null);

  useEffect(() => {
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
      ignore: (element) => element.closest('[data-fb-dev]') !== null,
    });

    const overlay = createOverlay({
      host: host.root,
      onSelect: (issue) => setStatus(`${issue.identifier} · ${issue.stateName}`),
      // The widget re-resolves by itself when the page changes (SKG-513). This only reports it: the
      // host never has to work out that it re-rendered.
      onResolve: (entries) => setStatus(`${entries.length} pin${entries.length > 1 ? 's' : ''}`),
    });

    const composer = createComposer({
      host: host.panel,
      onSubmit: async (note) => {
        const identifier = await plant(note, target.current, setStatus);
        if (identifier === null) return false;

        // Re-read first — that is what proves the read path answers — and let the confirmation have
        // the last word, or the status flips back to a pin count nobody asked for.
        await refresh(overlay, setStatus);
        setStatus(`planté · ${identifier}`);

        return true;
      },
    });

    widget.current = { host, overlay, composer };

    return () => {
      composer.destroy();
      overlay.destroy();
      host.destroy();
      widget.current = null;
    };
  }, []);

  // A pin belongs to a page: a client-side navigation changes the canonical URL, so it changes which
  // seeds belong on screen.
  useEffect(() => {
    const overlay = widget.current?.overlay;
    if (overlay !== undefined) void refresh(overlay, setStatus);
  }, [location.pathname, location.search]);

  return <DevToolbar status={status} onReload={() => void refresh(widget.current?.overlay, setStatus)} />;
}

/** The issue identifier when it was planted, `null` when the worker refused. */
async function plant(
  note: string,
  target: CaptureTarget | null,
  setStatus: (message: string) => void,
): Promise<string | null> {
  if (target === null) return null;

  const seed = captureSeed({
    element: target.element,
    note,
    client: { id: CLIENT_ID, name: 'Playground' },
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

async function refresh(overlay: Overlay | undefined, setStatus: (message: string) => void): Promise<void> {
  if (overlay === undefined) return;

  const url = canonicalizePageUrl(window.location.href);
  try {
    const response = await fetch(`${WORKER_ORIGIN}/feedback?url=${encodeURIComponent(url)}&client=${CLIENT_ID}`);
    if (!response.ok) {
      setStatus(`lecture impossible · ${response.status}`);

      return;
    }

    const { issues } = (await response.json()) as { issues: SeedIssue[] };
    overlay.render(issues);
    setStatus(`${issues.length} pin${issues.length > 1 ? 's' : ''}`);
  } catch {
    setStatus(`worker injoignable sur ${WORKER_ORIGIN}`);
  }
}

/** Dev-only chrome. Marked `data-fb-dev` so pointing at it never captures it. */
function DevToolbar({ status, onReload }: { status: string; onReload: () => void }) {
  return (
    <div
      data-fb-dev="toolbar"
      className="fixed bottom-4 left-4 z-[2147483001] flex items-center gap-2 rounded-xl bg-stone-900 px-4 py-3 text-sm text-stone-50 shadow-lg"
    >
      <strong>
        🌱 Fruitback <span className="rounded bg-red-600 px-1.5 py-0.5 font-semibold">playground</span>
      </strong>
      <Button data-fb-dev="reload" size="sm" variant="secondary" onPress={onReload}>
        Recharger les pins
      </Button>
      <Button data-fb-dev="redeploy" size="sm" variant="secondary" onPress={() => redeploy()}>
        Redéployer
      </Button>
      <Button data-fb-dev="remove-latte" size="sm" variant="secondary" onPress={() => removeCard('latte')}>
        Supprimer la carte Latte
      </Button>
      <span data-fb-dev="status" className="min-w-[150px] opacity-70">
        {status}
      </span>
    </div>
  );
}
