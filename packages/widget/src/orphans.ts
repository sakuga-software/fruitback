import { SEED_STAGE_STYLES, type SeedIssue } from '@fruitback/shared';

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
};

/** Enough of the note to recognise it; the rest is one click away in Linear. */
const EXCERPT_MAX_LENGTH = 60;

export function createOrphanList(options: OrphanListOptions): OrphanList {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fb-orphans';
  root.dataset.fbOrphans = '';
  root.hidden = true;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'fb-orphans-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const list = document.createElement('ul');
  list.className = 'fb-orphans-list';
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
      // Short-circuited on identity *and* stage: a pin whose Linear state moved needs its emoji
      // redrawn, and nothing else here changes without one of the two changing.
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

      toggle.textContent = `🍂 ${issues.length} note${issues.length > 1 ? 's' : ''} détachée${
        issues.length > 1 ? 's' : ''
      }`;

      list.replaceChildren(...issues.map((issue) => entry(document, issue, options.onSelect)));
    },
    owns: (node) => node === root || node === style || root.contains(node),
    destroy() {
      root.remove();
      style.remove();
    },
  };
}

function entry(document: Document, issue: SeedIssue, onSelect?: (issue: SeedIssue) => void): HTMLElement {
  const item = document.createElement('li');
  item.className = 'fb-orphans-item';
  item.dataset.fbOrphan = issue.seed.id;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fb-orphans-note';
  button.textContent = `${SEED_STAGE_STYLES[issue.stage].emoji} ${excerpt(issue)}`;
  button.addEventListener('click', () => onSelect?.(issue));

  const link = document.createElement('a');
  link.className = 'fb-orphans-link';
  link.href = issue.url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = issue.identifier;

  item.append(button, link);

  return item;
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
.fb-orphans {
  position: fixed;
  /*
    Stacked above the widget's own dock rather than in the opposite corner. Claiming a second corner
    of someone else's page is how a widget ends up on top of their cookie banner or their support
    chat — and it put this drawer under the playground's toolbar the first time.
  */
  right: 16px;
  bottom: 60px;
  z-index: 2147483000;
  max-width: 300px;
  font: 13px/1.45 var(--fb-font-sans);
  color: var(--fb-color-text);
}
.fb-orphans[hidden] { display: none; }
/* Chip last in the DOM order it reads in, list above it on screen. */
.fb-orphans { display: flex; flex-direction: column-reverse; align-items: flex-end; }
.fb-orphans-toggle {
  display: block;
  padding: 8px 12px;
  border: 0;
  border-radius: 999px;
  background: var(--fb-color-warning);
  color: var(--fb-color-on-accent);
  font: 600 12px/1 var(--fb-font-sans);
  box-shadow: var(--fb-shadow-md);
  cursor: pointer;
}
.fb-orphans-list {
  display: block;
  /* Above the chip: it sits at the bottom of the page, so a list below it would have nowhere to go. */
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 12px;
  background: var(--fb-color-surface);
  box-shadow: var(--fb-shadow-lg);
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
}
.fb-orphans-list[hidden] { display: none; }
.fb-orphans-item { display: flex; align-items: baseline; gap: 8px; list-style: none; }
.fb-orphans-item + .fb-orphans-item { margin-top: 6px; }
.fb-orphans-note {
  flex: 1;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.fb-orphans-link { font-size: 11px; color: var(--fb-color-accent); text-decoration: none; white-space: nowrap; }
`;
