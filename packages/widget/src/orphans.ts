import { type SeedIssue } from '@fruitback/shared';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { stageToken } from './theme.ts';

/**
 * The notes whose element is gone (SKG-501).
 *
 * A pin that still resolves — even only by position — stays on the page, dashed and marked unsure;
 * that is SKG-500's answer and this file does not touch it. What this is for is the case where the
 * cascade found **nothing**: the element was deleted, and the pin is drawn at the box it was planted
 * on, which after a redesign can mean anywhere.
 *
 * Those notes are the easiest thing in the product to lose. They are still real feedback, they are
 * still open in Linear, and the only trace of them on the page is a dotted rectangle over whatever
 * happens to be there now. So they get a list of their own: text, readable, with the way through to
 * Linear — a detached bin rather than a pin nobody can interpret.
 *
 * It shows itself only when there is something in it. A widget that puts an empty drawer on someone
 * else's site is a widget they turn off.
 */

export type OrphanList = {
  /** Replace the contents. Hides itself when the list is empty. */
  update(issues: SeedIssue[]): void;
  /**
   * Whether this node is part of the list's own DOM.
   *
   * The overlay observes the document for changes, and this list is a *sibling* of its container
   * rather than a child — so without being asked, the overlay treats the list redrawing itself as
   * the page changing, re-resolves, redraws the list, and goes round again.
   */
  owns(node: Node): boolean;
  destroy(): void;
};

export type OrphanListOptions = {
  document?: Document;
  /** Where to render — the Shadow root, in practice. */
  host: Element | ShadowRoot;
  /** The reporter asked to look at this note. */
  onSelect?: (issue: SeedIssue) => void;
  /** The widget's words (SKG-530). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

/** Enough of the note to recognise it; the rest is one click away in Linear. */
const EXCERPT_MAX_LENGTH = 60;

export function createOrphanList(options: OrphanListOptions): OrphanList {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fruitback-orphans';
  root.dataset.fruitbackOrphans = '';
  root.hidden = true;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'fruitback-orphans-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  // A dashed drop rather than the fallen leaf that used to open this label (SKG-529). It is the pin's
  // own silhouette, drawn the way the overlay draws a pin it could not re-anchor — the chip and the
  // pin then say the same thing in the same language, which an emoji could not do.
  const toggleCount = document.createElement('span');
  toggle.append(createIcon(document, 'dropDashed'), toggleCount);

  const list = document.createElement('ul');
  list.className = 'fruitback-orphans-list';
  list.hidden = true;

  toggle.addEventListener('click', () => {
    const opening = list.hidden;
    list.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });

  root.append(toggle, list);
  options.host.append(style, root);

  /** What is on screen, so an unchanged set costs no DOM writes at all. */
  let drawn = '';

  return {
    update(issues) {
      // Identity *and* stage, and the stage is in there because the entry draws it: each row carries
      // a drop in its stage's colour. SKG-517 left this over-invalidating on purpose, pending the
      // ticket that would decide how a stage shows up here; that ticket is SKG-529, and this is the
      // answer. Drop the stage from this key and a note that ripens keeps the colour it had.
      const next = issues.map((issue) => `${issue.seed.id}:${issue.stage}`).join('|');
      if (next === drawn) return;
      drawn = next;

      root.hidden = issues.length === 0;
      if (issues.length === 0) {
        // Collapsed on the way out, so it does not reappear open on the next redeploy.
        list.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        list.replaceChildren();

        return;
      }

      toggleCount.textContent = t.plural('orphans.count', issues.length);

      list.replaceChildren(...issues.map((issue) => entry(document, issue, t, options.onSelect)));
    },
    owns: (node) => node === root || node === style || root.contains(node),
    destroy() {
      root.remove();
      style.remove();
    },
  };
}

function entry(
  document: Document,
  issue: SeedIssue,
  t: Translator,
  onSelect?: (issue: SeedIssue) => void,
): HTMLElement {
  const item = document.createElement('li');
  item.className = 'fruitback-orphans-item';
  item.dataset.fruitbackOrphan = issue.seed.id;

  // How ripe the note is, as the pin's shape in the stage's colour — the same vocabulary the page
  // itself uses, which is what a reporter has to be able to match up. The stage is named in the
  // button's accessible name rather than in the mark, because colour alone is not a label.
  const mark = createIcon(document, 'drop');
  mark.classList.add('fruitback-orphans-stage');
  mark.style.setProperty('--fruitback-pin-color', stageToken(issue.stage));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fruitback-orphans-note';
  button.textContent = excerpt(issue);
  button.setAttribute('aria-label', t.text('orphans.entry', { stage: t.stage(issue.stage), note: excerpt(issue) }));
  button.addEventListener('click', () => onSelect?.(issue));

  item.append(mark, button, ...handle(document, issue));

  return item;
}

/**
 * The identifier, as a link when the store has somewhere to open it and as plain text otherwise
 * (SKG-524).
 *
 * A store with no web interface — SQLite — reports no `url`, and an anchor with an empty `href`
 * resolves to the current page: clicking it reloads the client's site and loses whatever the
 * reporter was doing. The identifier is still worth showing, so it degrades to a span rather than
 * disappearing with the link.
 */
function handle(document: Document, issue: SeedIssue): HTMLElement[] {
  if (issue.url === undefined) {
    const label = document.createElement('span');
    label.className = 'fruitback-orphans-link';
    label.textContent = issue.identifier;

    return [label];
  }

  const link = document.createElement('a');
  link.className = 'fruitback-orphans-link';
  link.href = issue.url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = issue.identifier;

  return [link];
}

function excerpt(issue: SeedIssue): string {
  const line = issue.seed.note
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (line === undefined) return `<${issue.seed.anchor.tag}> · ${issue.seed.page.path}`;

  return line.length > EXCERPT_MAX_LENGTH ? `${line.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : line;
}

// No backticks in here: one inside this literal closes it and the module stops parsing. It has
// happened four times in this repo.
const STYLES = `
.fruitback-orphans {
  position: fixed;
  /*
    Stacked above the widget's own dock rather than in the opposite corner. Claiming a second corner
    of someone else's page is how a widget ends up on top of their cookie banner or their support
    chat — and it put this drawer under the playground's toolbar the first time.
  */
  inset-inline-end: 16px;
  bottom: 60px;
  z-index: 2147483000;
  max-width: 300px;
  font: 13px/1.45 var(--fruitback-font-sans);
  color: var(--fruitback-color-text);
}
.fruitback-orphans[hidden] { display: none; }
/* Chip last in the DOM order it reads in, list above it on screen. */
.fruitback-orphans { display: flex; flex-direction: column-reverse; align-items: flex-end; }
.fruitback-orphans-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-warning);
  color: var(--fruitback-color-on-warning);
  font: 600 12px/1 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-md);
  cursor: pointer;
}
.fruitback-orphans-list {
  display: block;
  /* Above the chip: it sits at the bottom of the page, so a list below it would have nowhere to go. */
  margin: 0 0 8px;
  padding: 8px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-lg);
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
}
.fruitback-orphans-list[hidden] { display: none; }
.fruitback-orphans-item { display: flex; align-items: baseline; gap: 6px; list-style: none; }
.fruitback-orphans-stage { color: var(--fruitback-pin-color); font-size: 11px; }
.fruitback-orphans-item + .fruitback-orphans-item { margin-top: 6px; }
.fruitback-orphans-note {
  flex: 1;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.fruitback-orphans-link {
  font-size: 11px;
  color: var(--fruitback-color-accent);
  text-decoration: none;
  white-space: nowrap;
}
`;
