import { canonicalizePageUrl, type SeedIssue } from '@fruitback/shared';
import {
  type CaptureHost,
  type CaptureTarget,
  type Overlay,
  captureSeed,
  createCaptureHost,
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
 * never captures the toolbar. The note composer is the one piece still standing in for product code —
 * SKG-493 replaces it.
 */

const CLIENT_ID = 'playground';
const workerOrigin = window.__FRUITBACK_PLAYGROUND__?.workerOrigin ?? 'http://localhost:8788';

let host: CaptureHost | null = null;
let overlay: Overlay | null = null;
let composerFor: Element | null = null;
let composerSource: CaptureTarget['source'];

function main(): void {
  injectToolbarStyles();
  document.body.append(buildToolbar());

  host = createCaptureHost({
    onSelect: openComposer,
    // The dev toolbar is neither part of the page under test nor part of the widget.
    ignore: (element) => element.closest('[data-fb-dev]') !== null,
  });
  buildComposer(host);

  // Pins go in the widget's Shadow root too: that is the point of the host, and it is what finally
  // stops the client's CSS from reaching a pin.
  overlay = createOverlay({
    host: host.root,
    onSelect: (issue) => status(`${issue.identifier} · ${issue.stateName}`),
  });

  void plantPins();
}

// ── The note, until SKG-493 ────────────────────────────────────────────────────────────────────

function openComposer(target: CaptureTarget): void {
  composerFor = target.element;
  composerSource = target.source;

  const composer = queryHost('[data-fb-composer]');
  const note = queryHost('[data-fb-note]') as HTMLTextAreaElement | null;
  if (composer === null || note === null) return;

  const rect = target.element.getBoundingClientRect();
  note.value = '';
  Object.assign(composer.style, {
    display: 'block',
    left: `${Math.min(rect.left + window.scrollX, window.innerWidth - 320)}px`,
    top: `${rect.bottom + window.scrollY + 8}px`,
  });
  note.focus();
  status(target.source?.component ? `cible : <${target.source.component}>` : 'cible sélectionnée');
}

function closeComposer(): void {
  composerFor = null;
  composerSource = undefined;
  const composer = queryHost('[data-fb-composer]');
  if (composer !== null) composer.style.display = 'none';
}

async function send(): Promise<void> {
  const note = queryHost('[data-fb-note]') as HTMLTextAreaElement | null;
  if (composerFor === null || note === null) return;

  const seed = captureSeed({
    element: composerFor,
    note: note.value,
    client: { id: CLIENT_ID, name: 'Playground' },
    // Straight from react-grab, through the host — no fiber guessing on this path.
    source: composerSource,
  });

  status('envoi…');
  const response = await fetch(`${workerOrigin}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seed),
  });

  if (!response.ok) {
    status(`le worker a répondu ${response.status}`);
    return;
  }

  const { issue } = (await response.json()) as { issue: { identifier: string } };
  closeComposer();
  // Re-read rather than draw what we just sent: this is what proves the read path answers.
  await plantPins();
  status(`planté · ${issue.identifier}`);
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

/** Inside the Shadow root, `all: initial` applies — so the composer ships its own rules with it. */
function buildComposer(captureHost: CaptureHost): void {
  const style = document.createElement('style');
  style.textContent = COMPOSER_STYLES;

  const composer = document.createElement('div');
  composer.className = 'fb-composer';
  composer.dataset.fbComposer = '';
  composer.innerHTML = `
    <textarea data-fb-note rows="3" placeholder="Qu'est-ce qui ne va pas ici ?"></textarea>
    <div class="fb-composer-actions">
      <button type="button" data-fb-cancel>Annuler</button>
      <button type="button" data-fb-send class="fb-primary">Envoyer</button>
    </div>
  `;
  composer.querySelector('[data-fb-send]')?.addEventListener('click', () => void send());
  composer.querySelector('[data-fb-cancel]')?.addEventListener('click', () => closeComposer());

  captureHost.panel.append(style, composer);
}

function queryHost(selector: string): HTMLElement | null {
  return (host?.root.querySelector(selector) as HTMLElement | null) ?? null;
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

const COMPOSER_STYLES = `
.fb-composer { position: absolute; display: none; z-index: 2147483300; width: 300px; background: #fff;
  border: 1px solid #d6d3d1; border-radius: 10px; padding: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18); }
.fb-composer textarea { display: block; width: 100%; border: 1px solid #d6d3d1; border-radius: 6px; padding: 8px;
  font: 14px/1.4 -apple-system, system-ui, sans-serif; resize: vertical; }
.fb-composer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.fb-composer-actions button { border: 1px solid #d6d3d1; background: #fff; border-radius: 6px; padding: 6px 10px;
  font: 13px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
.fb-composer-actions .fb-primary { background: #e53935; border-color: #e53935; color: #fff; }
`;

declare global {
  interface Window {
    __FRUITBACK_PLAYGROUND__?: { workerOrigin: string };
  }
}

main();
