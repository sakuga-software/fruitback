import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { PAGE_NOTES_SHOWN, pageNotes, shortAge, showPageNotes } from './popup-notes.ts';
import type { PanelNote } from './protocol.ts';

/** « On this page » of screen 3 (FRU-695), read on happy-dom: its lines, its states, its clicks. */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' }).document as unknown as Document;
}

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

function note(id: string, stage: PanelNote['stage'], text: string, seconds: number): PanelNote {
  return {
    id,
    stage,
    note: text,
    createdAt: ago(seconds),
    updatedAt: ago(seconds),
    replies: [],
    canReply: true,
    placement: 'found',
  };
}

const NOTES = [
  note('n1', 'progress', 'The button is hard to read on the green.', 2 * 86_400),
  note('n2', 'new', 'The order form rejects postcodes with a space.', 40 * 60),
  note('n3', 'todo', 'The returns policy says "recieve".', 3 * 3_600),
  note('n4', 'done', 'The chat bubble covers the send button.', 86_400),
];

afterEach(() => setLanguage('en'));

describe('« On this page » of the popup (FRU-695)', () => {
  it('reads « Reading… » until the widget answers, with no count', () => {
    const section = pageNotes(page(), { onOpenPanel: () => undefined });

    assert.equal(section.querySelector('.page-notes-title')?.textContent, 'On this page');
    assert.equal(section.querySelector('.page-notes-said')?.textContent, 'Reading the notes of this page…');
    assert.equal(section.querySelectorAll('.page-note').length, 0);
  });

  it('draws each note on one line: its stage in words, the note whole in the DOM, its age', () => {
    const opened: string[] = [];
    let panels = 0;
    const section = pageNotes(page(), { onOpenPanel: () => (panels += 1) });
    showPageNotes(
      section,
      { notes: NOTES },
      { onOpen: (id) => opened.push(id), onOpenPanel: () => (panels += 1), now: NOW },
    );

    assert.equal(section.querySelector('.page-notes-title')?.textContent, 'On this page4');
    assert.equal(section.querySelector<HTMLElement>('.page-notes-said')?.hidden, true);
    const lines = [...section.querySelectorAll<HTMLButtonElement>('.page-note')];
    assert.deepEqual(
      lines.map((line) => line.textContent),
      [
        'In progress, The button is hard to read on the green.2d',
        'New, The order form rejects postcodes with a space.40m',
        'To do, The returns policy says "recieve".3h',
        'Done, The chat bubble covers the send button.1d',
      ],
    );
    // The sheet cuts a note, never the code: the pointer reads it whole in `title`.
    assert.equal(lines[1]?.title, 'The order form rejects postcodes with a space.');
    // The round of the stage of the side panel and of the widget's list.
    assert.equal(lines[0]?.querySelector('svg.kit-stage-ring')?.getAttribute('aria-hidden'), 'true');
    lines[2]?.click();
    section.querySelector<HTMLButtonElement>('.page-notes-panel')?.click();
    assert.deepEqual(opened, ['n3']);
    assert.equal(panels, 1);
  });

  it(`shows ${PAGE_NOTES_SHOWN} notes at most, and the rest is in the side panel`, () => {
    let panels = 0;
    const many = Array.from({ length: 9 }, (_, index) => note(`n${index}`, 'new', `Note ${index}`, 120));
    const section = pageNotes(page(), { onOpenPanel: () => undefined });
    showPageNotes(section, { notes: many }, { onOpen: () => undefined, onOpenPanel: () => (panels += 1), now: NOW });

    assert.equal(section.querySelectorAll('.page-note').length, PAGE_NOTES_SHOWN);
    assert.equal(section.querySelector('.page-notes-count')?.textContent, '9');
    const more = section.querySelector<HTMLButtonElement>('.page-notes-more');
    assert.equal(more?.textContent, '3 more in the sidebar');
    more?.click();
    assert.equal(panels, 1);
    // The control: exactly as many as it shows, no line for the rest.
    const six = pageNotes(page(), { onOpenPanel: () => undefined });
    showPageNotes(
      six,
      { notes: many.slice(0, PAGE_NOTES_SHOWN) },
      { onOpen: () => undefined, onOpenPanel: () => undefined },
    );
    assert.equal(six.querySelector('.page-notes-more'), null);
  });

  it('says that the page has no note, or why none could be read', () => {
    const section = pageNotes(page(), { onOpenPanel: () => undefined });
    const said = (read: Parameters<typeof showPageNotes>[1]): string | null | undefined => {
      showPageNotes(section, read, { onOpen: () => undefined, onOpenPanel: () => undefined });

      return section.querySelector('.page-notes-said')?.textContent;
    };
    assert.equal(said({ notes: [] }), 'No notes on this page yet');
    assert.equal(section.querySelector('.page-notes-count')?.textContent, '0');
    assert.equal(said({ reading: 'failed' }), 'The notes of this page could not be read. They are not lost.');
    assert.equal(section.querySelector('.page-notes-count')?.textContent, '');
    assert.equal(said({ reading: 'no-widget' }), 'Fruitback did not start on this page. Reload it to see its notes.');
    assert.equal(said({ reading: 'unreached' }), 'Fruitback did not start on this page. Reload it to see its notes.');
    assert.equal(
      said({ reading: 'signed-out' }),
      'Your session ended. Sign in again from the Fruitback button, then try again.',
    );
    // A read that answers after a failed one draws its notes, and the words go.
    showPageNotes(section, { notes: NOTES.slice(0, 1) }, { onOpen: () => undefined, onOpenPanel: () => undefined });
    assert.equal(section.querySelector<HTMLElement>('.page-notes-said')?.hidden, true);
    assert.equal(section.querySelectorAll('.page-note').length, 1);
  });

  it('writes an age as the mock-up does, in the language of the popup', () => {
    assert.equal(shortAge(ago(20), NOW), 'now');
    assert.equal(shortAge(ago(40 * 60), NOW), '40m');
    assert.equal(shortAge(ago(3 * 3_600), NOW), '3h');
    assert.equal(shortAge(ago(2 * 86_400), NOW), '2d');
    assert.equal(shortAge(ago(15 * 86_400), NOW), '2w');
    // Past four weeks, a date: a month and a minute would both read « m ».
    assert.equal(shortAge(ago(60 * 86_400), NOW), 'Sep 26');
    assert.equal(shortAge('not a date', NOW), '');
    setLanguage('fr');
    assert.equal(shortAge(ago(40 * 60), NOW), '40min');
    assert.equal(shortAge(ago(2 * 86_400), NOW), '2j');
    assert.equal(shortAge(ago(20), NOW), 'à l’instant');
  });

  it('speaks French', () => {
    setLanguage('fr');
    const section = pageNotes(page(), { onOpenPanel: () => undefined });
    showPageNotes(
      section,
      { notes: NOTES.slice(0, 1) },
      { onOpen: () => undefined, onOpenPanel: () => undefined, now: NOW },
    );

    assert.equal(section.querySelector('.page-notes-title')?.textContent, 'Sur cette page1');
    assert.equal(section.querySelector('.page-notes-panel')?.textContent, 'Ouvrir le panneau');
    assert.equal(
      section.querySelector('.page-note')?.textContent,
      'En cours, The button is hard to read on the green.2j',
    );
  });
});
