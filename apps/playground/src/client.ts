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

/**
 * The playground's own chrome, and the wiring that feeds the widget.
 *
 * Almost nothing of the product is left in this file. Selection, the floating button, the hover
 * highlight and the style isolation are `createCaptureHost` (SKG-492); resolution, pins, positioning
 * and the thread are `createOverlay` (SKG-500). Both live in the widget's Shadow root, which is why
 * the composer below is mounted into `host.panel` rather than into the page.
 *
 * What remains is dev-only and deliberately **outside** the Shadow root, in the light DOM where the
 * page's own CSS can reach it: the toolbar that simulates a deploy, deletes a card, or reloads the
 * pins. It carries `data-fb-dev` and is handed to the host's `ignore`, so pointing at the toolbar
 * never captures the toolbar.
 *
 * Nothing of the product is left in this file. What it still decides is what belongs to whoever
 * embeds the widget: where the worker lives, and what a client id is.
 */

const CLIENT_ID = 'playground';
const workerOrigin = window.__FRUITBACK_PLAYGROUND__?.workerOrigin ?? 'http://localhost:8788';

let host: CaptureHost | null = null;
let overlay: Overlay | null = null;
let composer: Composer | null = null;
let target: CaptureTarget | null = null;

function main(): void {
  injectToolbarStyles();
  document.body.append(buildToolbar());

  host = createCaptureHost({
    onSelect: openComposer,
    // The dev toolbar is neither part of the page under test nor part of the widget.
    ignore: (element) => element.closest('[data-fb-dev]') !== null,
  });

  // The popover is the widget's now (SKG-493). This file only says how to send: the transport, the
  // client id and the worker's address are the embedder's business, not the widget's.
  composer = createComposer({ host: host.panel, onSubmit: plant });

  // Pins go in the widget's Shadow root too: that is the point of the host, and it is what finally
  // stops the client's CSS from reaching a pin.
  overlay = createOverlay({
    host: host.root,
    onSelect: (issue) => status(`${issue.identifier} · ${issue.stateName}`),
  });

  void plantPins();
}

// ── Selection → the widget's popover ──────────────────────────────────────────────────────────

function openComposer(selected: CaptureTarget): void {
  target = selected;
  const rect = selected.element.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  composer?.open({
    left: rect.left + scrollX,
    top: rect.top + scrollY,
    bottom: rect.bottom + scrollY,
    right: rect.right + scrollX,
  });
  status(selected.source?.component ? `cible : <${selected.source.component}>` : 'cible sélectionnée');
}

/** What the composer awaits. Resolving false is how it learns to keep the note and stay open. */
async function plant(note: string): Promise<boolean> {
  if (target === null) return false;

  const seed = captureSeed({
    element: target.element,
    note,
    client: { id: CLIENT_ID, name: 'Playground' },
    // Straight from react-grab, through the host — no fiber guessing on this path.
    source: target.source,
  });

  const response = await fetch(`${workerOrigin}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seed),
  });

  if (!response.ok) {
    status(`le worker a répondu ${response.status}`);
    return false;
  }

  const { issue } = (await response.json()) as { issue: { identifier: string } };
  // Re-read rather than draw what we just sent: this is what proves the read path answers.
  await plantPins();
  status(`planté · ${issue.identifier}`);

  return true;
}

// ── Pins ───────────────────────────────────────────────────────────────────────────────────────

async function plantPins(): Promise<void> {
  const url = canonicalizePageUrl(window.location.href);
  const query = `${workerOrigin}/feedback?url=${encodeURIComponent(url)}&client=${CLIENT_ID}`;

  let issues: SeedIssue[] = [];
  try {
    const response = await fetch(query);
    if (!response.ok) {
      status(`lecture impossible · ${response.status}`);
      return;
    }
    ({ issues } = (await response.json()) as { issues: SeedIssue[] });
  } catch {
    status(`worker injoignable sur ${workerOrigin}`);
    return;
  }

  overlay?.render(issues);
  status(`${issues.length} pin${issues.length > 1 ? 's' : ''}`);
}

// ── "Redeploy" ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a deploy does to a page, in one click: hashed classes change, a generated id changes, the
 * markup shifts. This is the button that makes re-anchoring testable without rebuilding anything.
 */
function redeploy(): void {
  document
    .querySelectorAll('.button_3f2a1b')
    .forEach((node) => node.classList.replace('button_3f2a1b', 'button_9d7e4c'));
  document.querySelectorAll('.css-1x9f7ab').forEach((node) => node.classList.replace('css-1x9f7ab', 'css-77aa31'));

  const burger = document.querySelector('header button');
  if (burger !== null) burger.id = `:r${Math.floor(Math.random() * 90) + 10}:`;

  const cards = document.querySelector('.cards');
  if (cards !== null && cards.querySelector('[data-fb-inserted]') === null) {
    const inserted = document.createElement('li');
    inserted.className = 'card';
    inserted.dataset.fbInserted = 'true';
    inserted.innerHTML = '<h3>Nouveau</h3><div class="price">—</div>';
    // Prepended, so every `:nth-child` below it now points one card to the left.
    cards.prepend(inserted);
  }

  status('redéployé · les pins se ré-ancrent');
  void plantPins();
}

/** The other half of the story: an element that is simply gone, and the orphan pin it leaves. */
function removeLatteCard(): void {
  document.querySelector('[data-testid="card-latte"]')?.remove();
  status('carte Latte supprimée · pin orphelin attendu');
  void plantPins();
}

// ── Dev chrome (light DOM, on purpose) ─────────────────────────────────────────────────────────

function buildToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.dataset.fbDev = 'toolbar';
  toolbar.id = 'fb-toolbar';
  toolbar.innerHTML = `
    <strong>🌱 Fruitback <span class="fb-tag">playground</span></strong>
    <button data-fb-dev="reload">Recharger les pins</button>
    <button data-fb-dev="redeploy">Redéployer</button>
    <button data-fb-dev="remove-latte">Supprimer la carte Latte</button>
    <span data-fb-dev="status" id="fb-status">—</span>
  `;

  toolbar.querySelector('[data-fb-dev="reload"]')?.addEventListener('click', () => void plantPins());
  toolbar.querySelector('[data-fb-dev="redeploy"]')?.addEventListener('click', redeploy);
  toolbar.querySelector('[data-fb-dev="remove-latte"]')?.addEventListener('click', removeLatteCard);

  return toolbar;
}

function status(message: string): void {
  const element = document.getElementById('fb-status');
  if (element !== null) element.textContent = message;
}

function injectToolbarStyles(): void {
  const style = document.createElement('style');
  style.dataset.fbDev = 'styles';
  style.textContent = `
    #fb-toolbar { position: fixed; left: 16px; bottom: 16px; z-index: 2147483001; display: flex; gap: 8px;
      align-items: center; background: #1c1917; color: #fafaf9; padding: 10px 14px; border-radius: 10px;
      font: 13px/1 -apple-system, system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
    #fb-toolbar button { background: #44403c; color: #fafaf9; border: 0; border-radius: 6px; padding: 7px 10px;
      font: inherit; cursor: pointer; }
    #fb-toolbar button:hover { background: #57534e; }
    #fb-toolbar .fb-tag { background: #e53935; border-radius: 4px; padding: 2px 6px; font-weight: 600; }
    #fb-status { opacity: .7; min-width: 150px; }
  `;
  document.head.append(style);
}

declare global {
  interface Window {
    __FRUITBACK_PLAYGROUND__?: { workerOrigin: string };
  }
}

main();
