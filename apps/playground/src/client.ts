import { canonicalizePageUrl, SEED_STAGE_STYLES, type SeedIssue } from '@fruitback/shared';
import { captureSeed } from '@fruitback/widget';

/**
 * The dev harness that mounts the widget on the playground page.
 *
 * **This is scaffolding, not the product.** The real capture UI is a Shadow DOM host over
 * `react-grab/primitives` (SKG-492) with a proper popover (SKG-493), and the real re-anchoring engine
 * is SKG-500 — all three will replace what is below. It exists so the pipeline that *is* written —
 * `captureSeed`, `POST /feedback`, `GET /feedback` — can be exercised end to end by a human and by
 * the E2E suite, today, instead of waiting for the host to be finished to discover it was wrong.
 *
 * It stays in the light DOM (no Shadow root) and its styles are prefixed rather than isolated, which
 * is precisely the shortcut SKG-492 exists to remove.
 */

const CLIENT_ID = 'playground';
const workerOrigin = window.__FRUITBACK_PLAYGROUND__?.workerOrigin ?? 'http://localhost:8788';

/** What actually found the element — read by the E2E suite, and by anyone looking at a pin. */
type PinStrategy = 'selector' | 'text' | 'orphan';

let capturing = false;
let composerFor: Element | null = null;

function main(): void {
  injectStyles();
  const toolbar = buildToolbar();
  document.body.append(toolbar);

  document.addEventListener('mousemove', onHover, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopCapturing();
  });
  window.addEventListener('resize', () => void plantPins());

  void plantPins();
}

// ── Capture ────────────────────────────────────────────────────────────────────────────────────

function onHover(event: MouseEvent): void {
  if (!capturing) return;

  const element = targetOf(event);
  const highlight = byId('fb-highlight');
  if (element === null || highlight === null) return;

  const rect = element.getBoundingClientRect();
  Object.assign(highlight.style, {
    display: 'block',
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function onClick(event: MouseEvent): void {
  if (!capturing) return;

  const element = targetOf(event);
  if (element === null) return;

  // The page's own handlers must not run while the reporter is pointing at things.
  event.preventDefault();
  event.stopPropagation();
  openComposer(element);
}

/** The element under the pointer, or null when the pointer is over the harness's own UI. */
function targetOf(event: MouseEvent): Element | null {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('[data-fb-dev]') !== null) return null;

  return target;
}

function openComposer(element: Element): void {
  composerFor = element;
  const composer = byId('fb-composer');
  const note = byId('fb-note') as HTMLTextAreaElement | null;
  const rect = element.getBoundingClientRect();
  if (composer === null || note === null) return;

  note.value = '';
  Object.assign(composer.style, {
    display: 'block',
    left: `${Math.min(rect.left + window.scrollX, window.innerWidth - 320)}px`,
    top: `${rect.bottom + window.scrollY + 8}px`,
  });
  note.focus();
}

async function send(): Promise<void> {
  const note = byId('fb-note') as HTMLTextAreaElement | null;
  if (composerFor === null || note === null) return;

  const seed = captureSeed({
    element: composerFor,
    note: note.value,
    client: { id: CLIENT_ID, name: 'Playground' },
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
  stopCapturing();
  // Re-read rather than draw what we just sent: this is what proves the read path answers.
  await plantPins();
  status(`planté · ${issue.identifier}`);
}

function closeComposer(): void {
  composerFor = null;
  const composer = byId('fb-composer');
  if (composer !== null) composer.style.display = 'none';
}

function startCapturing(): void {
  capturing = true;
  document.body.style.cursor = 'crosshair';
  status('cliquez sur un élément · Échap pour sortir');
}

function stopCapturing(): void {
  capturing = false;
  composerFor = null;
  document.body.style.cursor = '';
  const highlight = byId('fb-highlight');
  if (highlight !== null) highlight.style.display = 'none';
  closeComposer();
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

  document.querySelectorAll('[data-fb-pin]').forEach((pin) => pin.remove());
  for (const issue of issues) drawPin(issue);
  status(`${issues.length} pin${issues.length > 1 ? 's' : ''}`);
}

function drawPin(issue: SeedIssue): void {
  const { element, strategy } = resolve(issue);
  const style = SEED_STAGE_STYLES[issue.stage];
  const pin = document.createElement('div');

  pin.dataset.fbPin = issue.seed.id;
  pin.dataset.fbDev = 'pin';
  pin.dataset.fbStrategy = strategy;
  pin.dataset.fbStage = issue.stage;
  pin.className = strategy === 'orphan' ? 'fb-pin fb-pin-orphan' : 'fb-pin';
  pin.style.borderColor = style.color;
  pin.style.setProperty('--fb-pin-color', style.color);
  pin.title = `${issue.identifier} · ${issue.stateName}\n${issue.seed.note}`;
  pin.dataset.fbLabel = `${style.emoji} ${issue.seed.note.split('\n')[0]?.slice(0, 40) || issue.identifier}`;

  const box = element === null ? boundsBox(issue) : elementBox(element);
  Object.assign(pin.style, box);
  document.body.append(pin);
}

/**
 * Selector, then text, then orphan.
 *
 * **`domPath` is deliberately not used here**, and that is a finding rather than an omission. The
 * E2E suite pins it down: after a card is inserted — or removed — `li:nth-child(2)` still matches
 * exactly one element, and it is the *neighbour* that inherited the position. Both buttons say
 * "Ajouter", so corroborating by text does not catch it either. A path that resolves confidently to
 * the wrong element is worse than no match at all: an orphan pin says "I lost this one", a
 * misplaced pin says "your feedback was about this button" and is believed.
 *
 * The seed still carries `domPath`, and SKG-500 may yet find a way to use it safely — with a
 * corroboration this harness has no business inventing. Until then it stays unused.
 */
function resolve(issue: SeedIssue): { element: Element | null; strategy: PinStrategy } {
  const { selector, text } = issue.seed.anchor;

  const bySelector = queryOne(selector);
  if (bySelector !== null) return { element: bySelector, strategy: 'selector' };

  if (text) {
    const byText = [...document.querySelectorAll(issue.seed.anchor.tag)].filter(
      (candidate) => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === text,
    );
    // Only when it is the one and only match — "an element that says Ajouter" is not an identity.
    if (byText.length === 1) return { element: byText[0] ?? null, strategy: 'text' };
  }

  return { element: null, strategy: 'orphan' };
}

function queryOne(selector: string): Element | null {
  if (selector === '') return null;

  try {
    const found = document.querySelectorAll(selector);

    return found.length === 1 ? (found[0] ?? null) : null;
  } catch {
    return null;
  }
}

function elementBox(element: Element): Record<string, string> {
  const rect = element.getBoundingClientRect();

  return {
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

/** The orphan fallback: last known position, as a share of the document. */
function boundsBox(issue: SeedIssue): Record<string, string> {
  const width = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const height = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const { xPct, yPct, wPct, hPct } = issue.seed.anchor.bounds;

  return {
    left: `${(xPct / 100) * width}px`,
    top: `${(yPct / 100) * height}px`,
    width: `${(wPct / 100) * width}px`,
    height: `${(hPct / 100) * height}px`,
  };
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

// ── Harness UI ─────────────────────────────────────────────────────────────────────────────────

function buildToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.dataset.fbDev = 'toolbar';
  toolbar.id = 'fb-toolbar';
  toolbar.innerHTML = `
    <strong>🌱 Fruitback <span class="fb-tag">playground</span></strong>
    <button data-fb-dev="capture-toggle" id="fb-capture">Laisser un feedback</button>
    <button data-fb-dev="reload">Recharger les pins</button>
    <button data-fb-dev="redeploy">Redéployer</button>
    <button data-fb-dev="remove-latte">Supprimer la carte Latte</button>
    <span data-fb-dev="status" id="fb-status">—</span>
  `;

  toolbar.querySelector('[data-fb-dev="capture-toggle"]')?.addEventListener('click', () => {
    if (capturing) stopCapturing();
    else startCapturing();
  });
  toolbar.querySelector('[data-fb-dev="reload"]')?.addEventListener('click', () => void plantPins());
  toolbar.querySelector('[data-fb-dev="redeploy"]')?.addEventListener('click', redeploy);
  toolbar.querySelector('[data-fb-dev="remove-latte"]')?.addEventListener('click', removeLatteCard);

  const highlight = document.createElement('div');
  highlight.id = 'fb-highlight';
  highlight.dataset.fbDev = 'highlight';

  const composer = document.createElement('div');
  composer.id = 'fb-composer';
  composer.dataset.fbDev = 'composer';
  composer.innerHTML = `
    <textarea data-fb-dev="note" id="fb-note" rows="3" placeholder="Qu'est-ce qui ne va pas ici ?"></textarea>
    <div class="fb-composer-actions">
      <button data-fb-dev="cancel">Annuler</button>
      <button data-fb-dev="send" class="fb-primary">Envoyer</button>
    </div>
  `;
  composer.querySelector('[data-fb-dev="send"]')?.addEventListener('click', () => void send());
  composer.querySelector('[data-fb-dev="cancel"]')?.addEventListener('click', () => closeComposer());

  const host = document.createElement('div');
  host.dataset.fbDev = 'host';
  host.append(toolbar, highlight, composer);

  return host;
}

function status(message: string): void {
  const element = byId('fb-status');
  if (element !== null) element.textContent = message;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.dataset.fbDev = 'styles';
  style.textContent = `
    #fb-toolbar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483001; display: flex; gap: 8px;
      align-items: center; background: #1c1917; color: #fafaf9; padding: 10px 14px; border-radius: 10px;
      font: 13px/1 -apple-system, system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
    #fb-toolbar button { background: #44403c; color: #fafaf9; border: 0; border-radius: 6px; padding: 7px 10px;
      font: inherit; cursor: pointer; }
    #fb-toolbar button:hover { background: #57534e; }
    #fb-toolbar .fb-tag { background: #e53935; border-radius: 4px; padding: 2px 6px; font-weight: 600; }
    #fb-status { opacity: .7; min-width: 130px; }
    #fb-highlight { position: absolute; display: none; z-index: 2147483000; pointer-events: none;
      outline: 2px solid #e53935; background: rgba(229,57,53,.08); border-radius: 4px; }
    #fb-composer { position: absolute; display: none; z-index: 2147483002; width: 300px; background: #fff;
      border: 1px solid #d6d3d1; border-radius: 10px; padding: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18); }
    #fb-composer textarea { width: 100%; border: 1px solid #d6d3d1; border-radius: 6px; padding: 8px;
      font: 14px/1.4 -apple-system, system-ui, sans-serif; resize: vertical; }
    .fb-composer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .fb-composer-actions button { border: 1px solid #d6d3d1; background: #fff; border-radius: 6px; padding: 6px 10px;
      font: 13px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
    .fb-composer-actions .fb-primary { background: #e53935; border-color: #e53935; color: #fff; }
    .fb-pin { position: absolute; z-index: 2147483000; pointer-events: none; border: 2px solid var(--fb-pin-color);
      border-radius: 6px; background: color-mix(in srgb, var(--fb-pin-color) 14%, transparent); }
    .fb-pin::after { content: attr(data-fb-label); position: absolute; top: -24px; left: -2px;
      background: var(--fb-pin-color); color: #fff; font: 600 11px/1 -apple-system, system-ui, sans-serif;
      padding: 5px 7px; border-radius: 5px; white-space: nowrap; }
    .fb-pin-orphan { border-style: dashed; }
  `;
  document.head.append(style);
}

declare global {
  interface Window {
    __FRUITBACK_PLAYGROUND__?: { workerOrigin: string };
  }
}

main();
