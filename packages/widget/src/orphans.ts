import { type NoteIssue, type NoteStatus } from '@fruitback/shared';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { statusLabel, statusPaint } from './status-paint.ts';
import { CAPTURE_START } from './events.ts';
import { excerpt } from './note-words.ts';

/**
 * The notes whose element is gone (FRU-12).
 *
 * A pin that still resolves — even only by position — stays on the page, dashed and marked unsure;
 * that is FRU-11's answer and this file does not touch it. What this is for is the case where the
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
  update(issues: NoteIssue[]): void;
  /**
   * Whether this node is part of the list's own DOM.
   *
   * The overlay observes the document for changes, and this list is a *sibling* of its container
   * rather than a child — so without being asked, the overlay treats the list redrawing itself as
   * the page changing, re-resolves, redraws the list, and goes round again.
   */
  owns(node: Node): boolean;
  /** The button of the note's entry, or `undefined` if the note is not in the list. */
  entry(id: string): HTMLElement | undefined;
  destroy(): void;
};

export type OrphanListOptions = {
  document?: Document;
  /** Where to render — the Shadow root, in practice. */
  host: Element | ShadowRoot;
  /**
   * The capsule of the dock (FRU-303). Given, the chip is its first control and the list opens above
   * it. Left out, the chip floats on its own above the corner, as it did before the capsule.
   */
  dock?: Element;
  /** The reporter asked to look at this note. */
  onSelect?: (issue: NoteIssue) => void;
  /** The status of a note (FRU-370): its mark takes its colour, and its entry its name. Left out: the stage. */
  statusOf?: (issue: NoteIssue) => NoteStatus | undefined;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

/** The identifier of a note, a link or a plain label. */
const LINK = [
  'fruitback-orphans-link',
  'fruitback:text-mark fruitback:text-accent fruitback:no-underline fruitback:whitespace-nowrap',
].join(' ');

/** Enough of the note to recognise it; the rest is one click away in Linear. */
const EXCERPT_MAX_LENGTH = 60;

export function createOrphanList(options: OrphanListOptions): OrphanList {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const root = document.createElement('div');
  root.className = [
    'fruitback-orphans',
    'fruitback:fixed fruitback:end-4 fruitback:bottom-21 fruitback:z-2147483000 fruitback:max-w-75 fruitback:flex fruitback:flex-col-reverse fruitback:items-end',
    'fruitback:font-sans fruitback:text-list fruitback:text-text fruitback:when-hidden:hidden',
    'fruitback:corner-right:undocked:right-4 fruitback:corner-right:undocked:left-auto',
    'fruitback:corner-left:undocked:left-4 fruitback:corner-left:undocked:right-auto fruitback:corner-left:undocked:items-start',
    'fruitback:corner-top:undocked:top-21 fruitback:corner-top:undocked:bottom-auto fruitback:corner-top:undocked:flex-col',
    'fruitback:docked:relative fruitback:docked:inset-auto fruitback:docked:z-auto fruitback:docked:max-w-none',
  ].join(' ');
  root.dataset.fruitbackOrphans = '';
  root.hidden = true;
  if (options.dock !== undefined) root.dataset.fruitbackDocked = '';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = [
    'fruitback-orphans-toggle',
    'fruitback:flex fruitback:items-center fruitback:gap-1.5 fruitback:px-3 fruitback:py-1.75 fruitback:border-0 fruitback:rounded-field fruitback:shadow-md fruitback:cursor-pointer',
    'fruitback:font-sans fruitback:font-semibold fruitback:text-tiny fruitback:leading-none',
    'fruitback:[--fruitback-pin-color:var(--fruitback-color-unplaced)] fruitback:bg-(--fruitback-pin-color) fruitback:text-on-stage',
    'fruitback:in-docked:gap-1.75 fruitback:in-docked:h-control fruitback:in-docked:ps-3 fruitback:in-docked:pe-3.5 fruitback:in-docked:border-4 fruitback:in-docked:border-transparent',
    'fruitback:in-docked:rounded-md-outer fruitback:in-docked:bg-clip-padding fruitback:in-docked:text-hint fruitback:in-docked:tracking-button',
    'fruitback:in-docked:whitespace-nowrap fruitback:in-docked:shadow-none',
    'fruitback:forced-colors:border-canvas fruitback:forced-colors:outline-1 fruitback:forced-colors:outline-button-text fruitback:forced-colors:-outline-offset-5',
  ].join(' ');
  toggle.setAttribute('aria-expanded', 'false');
  // A dashed drop rather than the fallen leaf that used to open this label (FRU-36). It is the pin's
  // own silhouette, drawn the way the overlay draws a pin it could not re-anchor — the chip and the
  // pin then say the same thing in the same language, which an emoji could not do.
  const toggleCount = document.createElement('span');
  const toggleIcon = createIcon(document, 'dropDashed');
  toggleIcon.classList.add('fruitback:size-3.25');
  toggle.append(toggleIcon, toggleCount);

  const list = document.createElement('ul');
  list.className = [
    'fruitback-orphans-list',
    'fruitback:block fruitback:m-0 fruitback:mb-2 fruitback:p-2 fruitback:rounded-md fruitback:bg-surface fruitback:shadow-lg fruitback:list-none fruitback:max-h-55 fruitback:overflow-y-auto fruitback:when-hidden:hidden',
    'fruitback:in-docked:absolute fruitback:in-docked:bottom-beyond fruitback:in-docked:end-0 fruitback:in-docked:w-max fruitback:in-docked:max-w-orphans',
    'fruitback:in-docked:max-h-list-room fruitback:in-docked:m-0',
    'fruitback:in-docked:corner-top:top-beyond fruitback:in-docked:corner-top:bottom-auto',
    'fruitback:in-docked:corner-left:left-0 fruitback:in-docked:corner-left:right-auto',
    'fruitback:in-docked:corner-right:right-0 fruitback:in-docked:corner-right:left-auto',
  ].join(' ');
  list.hidden = true;

  toggle.addEventListener('click', () => {
    const opening = list.hidden;
    list.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });

  // A capture hides the capsule's controls, the chip among them: the list folds with it, so it is
  // not open again when the capture ends (FRU-303).
  const fold = (): void => {
    list.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  options.dock?.addEventListener(CAPTURE_START, fold);

  root.append(toggle, list);

  // A sibling of the root, because the root is hidden while the list is empty (FRU-51).
  // A live region inside a hidden element announces nothing.
  const announcer = document.createElement('div');
  announcer.className = [
    'fruitback-orphans-announcer',
    'fruitback:absolute fruitback:w-px fruitback:h-px fruitback:overflow-hidden fruitback:clip-hidden fruitback:whitespace-nowrap',
  ].join(' ');
  announcer.dataset.fruitbackOrphansAnnouncer = '';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');

  options.host.append(announcer);
  if (options.dock === undefined) options.host.append(root);
  else options.dock.prepend(root);

  /** What is on screen, so an unchanged set costs no DOM writes at all. */
  let drawn = '';
  let count = 0;

  return {
    update(issues) {
      // Identity *and* stage, and the stage is in there because the entry draws it: each row carries
      // a drop in its stage's colour. FRU-24 left this over-invalidating on purpose, pending the
      // ticket that would decide how a stage shows up here; that ticket is FRU-36, and this is the
      // answer. Drop the stage from this key and a note that changes stage keeps the colour it had.
      // The status too since FRU-370, for the same reason: its colour and its name are drawn. And the
      // name of the state in the tracker, which the entry says when the team gave no status (FRU-512).
      const next = issues
        .map((issue) => {
          const status = options.statusOf?.(issue);

          return `${issue.note.id}:${issue.stage}:${issue.stateName ?? ''}:${status === undefined ? '' : JSON.stringify(status)}`;
        })
        .join('|');
      if (next === drawn) return;
      drawn = next;

      // Only an increase is news. A note that is found again, or a stage change, is not.
      if (issues.length > count) announcer.textContent = t.plural('orphans.count', issues.length);
      if (issues.length === 0) announcer.textContent = '';
      count = issues.length;

      root.hidden = issues.length === 0;
      if (issues.length === 0) {
        // Collapsed on the way out, so it does not reappear open on the next redeploy.
        list.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        list.replaceChildren();

        return;
      }

      // « 1 detached » on the chip of the capsule, where the drop says the rest. Alone, the chip
      // says « 1 detached note ».
      toggleCount.textContent = t.plural(options.dock === undefined ? 'orphans.count' : 'orphans.chip', issues.length);

      list.replaceChildren(
        ...issues.map((issue) => entry(document, issue, options.statusOf?.(issue), t, options.onSelect)),
      );
    },
    owns: (node) => node === root || root.contains(node) || announcer.contains(node),
    entry: (id) =>
      [...list.children]
        .find((item) => (item as HTMLElement).dataset.fruitbackOrphan === id)
        ?.querySelector<HTMLElement>('.fruitback-orphans-note') ?? undefined,
    destroy() {
      options.dock?.removeEventListener(CAPTURE_START, fold);
      announcer.remove();
      root.remove();
    },
  };
}

function entry(
  document: Document,
  issue: NoteIssue,
  status: NoteStatus | undefined,
  t: Translator,
  onSelect?: (issue: NoteIssue) => void,
): HTMLElement {
  const item = document.createElement('li');
  item.className = [
    'fruitback-orphans-item',
    'fruitback:flex fruitback:items-baseline fruitback:gap-1.5 fruitback:list-none fruitback:not-first:mt-1.5',
  ].join(' ');
  item.dataset.fruitbackOrphan = issue.note.id;

  // The stage of the note, as the pin's shape in the stage's colour — the same vocabulary the page
  // itself uses, which is what a reporter has to be able to match up. The stage is named in the
  // button's accessible name rather than in the mark, because colour alone is not a label.
  const mark = createIcon(document, 'drop');
  mark.classList.add(
    'fruitback-orphans-stage',
    ...'fruitback:text-(--fruitback-pin-color) fruitback:text-mark fruitback:overflow-visible fruitback:*:stroke-stage-edge fruitback:*:stroke-3 fruitback:*:stroke-join-round fruitback:*:paint-stroke-first'.split(
      ' ',
    ),
  );
  mark.style.setProperty('--fruitback-pin-color', statusPaint(issue, status).fill);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = [
    'fruitback-orphans-note',
    'fruitback:flex-1 fruitback:border-0 fruitback:bg-transparent fruitback:p-0 fruitback:text-start fruitback:whitespace-normal fruitback:cursor-pointer',
  ].join(' ');
  button.textContent = summary(issue);
  // The word of its state, as its pin says it: the name of its status (FRU-370), else the name of its
  // state in the tracker, else the word of its stage (FRU-512).
  button.setAttribute(
    'aria-label',
    t.text('orphans.entry', { stage: statusLabel(issue, status, t), note: summary(issue) }),
  );
  button.addEventListener('click', () => onSelect?.(issue));

  item.append(mark, button, ...handle(document, issue));

  return item;
}

/**
 * The identifier, as a link when the store has somewhere to open it and as plain text otherwise
 * (FRU-31).
 *
 * A store with no web interface — SQLite — reports no `url`, and an anchor with an empty `href`
 * resolves to the current page: clicking it reloads the client's site and loses whatever the
 * reporter was doing. The identifier is still worth showing, so it degrades to a span rather than
 * disappearing with the link.
 */
function handle(document: Document, issue: NoteIssue): HTMLElement[] {
  if (issue.url === undefined) {
    const label = document.createElement('span');
    label.className = LINK;
    label.textContent = issue.identifier;

    return [label];
  }

  const link = document.createElement('a');
  link.className = LINK;
  link.href = issue.url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = issue.identifier;

  return [link];
}

/** The first line of the note, or its element and its page for a note with no words. */
function summary(issue: NoteIssue): string {
  return excerpt(issue.note.text, EXCERPT_MAX_LENGTH) ?? `<${issue.note.anchor.tag}> · ${issue.note.page.path}`;
}
