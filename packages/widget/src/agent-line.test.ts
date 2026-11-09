import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type Overlay, createOverlay } from './overlay.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/** « An agent is working on this note » in the thread (FRU-618), and its session for the team only. */

let overlay: Overlay | null = null;

afterEach(() => {
  overlay?.destroy();
  overlay = null;
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

function threadOf(page: MountedPage, overrides: Partial<NoteIssue>) {
  const issue = noteIssueFixture({
    comments: [],
    note: noteFixture({
      anchor: { selector: '[data-testid="cta"]', tag: 'button', bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 } },
    }),
    ...overrides,
  });
  overlay = createOverlay({ document: page.document });
  overlay.render([issue]);
  (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

  return page.document.querySelector('.fruitback-thread-agent');
}

describe('the line of an agent in the thread of a note (FRU-618)', () => {
  it('says an agent works on the note, with the way to its session for a member of the team', () => {
    const line = threadOf(mounted(), { agent: { url: 'https://claude.ai/code/session_01' } });
    const link = line?.querySelector('a');

    assert.equal(line?.textContent, 'An agent is working on this note · Open the session');
    assert.equal(link?.getAttribute('href'), 'https://claude.ai/code/session_01');
    assert.equal(link?.getAttribute('target'), '_blank');
    assert.equal(link?.getAttribute('rel'), 'noreferrer noopener');
  });

  it('says it alone to a reader who does not get the session', () => {
    const line = threadOf(mounted(), { agent: {} });

    assert.equal(line?.textContent, 'An agent is working on this note');
    assert.equal(line?.querySelector('a'), null);
  });

  it('says nothing on a note no agent works on', () => {
    assert.equal(threadOf(mounted(), {}), null);
  });
});
