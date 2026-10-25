import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The statuses of a read, drawn by the widget (FRU-364, FRU-370).
 *
 * Two promises. A read whose statuses this widget cannot use draws exactly what a read with none
 * draws: the promise of FRU-364 to every widget already served from `/v/<version>/`, cached a year on
 * host pages, and to every site with no statuses. A status it can use paints the pin, the list and the
 * thread with its colour and its name, and is handed to a list outside the page (FRU-370).
 */

const ENDPOINT = 'https://worker.test';
const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};
const REVIEW = noteIssueFixture({
  id: 'issue_1',
  identifier: 'FB-1',
  stage: 'progress',
  stateName: 'In Review',
  seed: noteFixture({ id: 'seed-1', note: 'Could the title mention Bordeaux?', anchor: ANCHOR }),
});
const DONE = noteIssueFixture({
  id: 'issue_2',
  identifier: 'FB-2',
  stage: 'done',
  stateName: 'Done',
  seed: noteFixture({ id: 'seed-2', note: 'An old one.', anchor: ANCHOR }),
});
const STATUSES = [
  { key: 'linear:st_review', name: 'In Review', stage: 'progress', color: '#7dd3fc', textColor: '#18181b' },
  { key: 'linear:st_done', name: 'Shipped', stage: 'done', color: '#15803d' },
];

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

/** What a widget shows of one read: the markup of its Shadow root, and the notes it gives a list. */
async function drawn(read: Record<string, unknown>) {
  const page = mounted();
  const transport = async (request: TransportRequest): Promise<TransportResponse> => ({
    ok: true,
    status: 200,
    body: request.method === 'GET' ? JSON.stringify(read) : '{}',
  });
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', locale: 'en', transport });
  cleanup.push(() => widget.destroy());
  await widget.refresh();
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

  return {
    markup: root.innerHTML,
    notes: widget.pageNotes(),
    pins: root.querySelectorAll('.fruitback-pin').length,
    root,
    widget,
  };
}

describe('a read that carries statuses (FRU-364, FRU-370)', () => {
  it('draws a status of another stage, or a key in no list, as the read without statuses', async () => {
    const before = await drawn({ issues: [REVIEW, DONE] });
    const after = await drawn({
      issues: [
        // `st_done` is a status of done, and REVIEW is in progress: the stage wins.
        { ...REVIEW, status: 'linear:st_done' },
        { ...DONE, status: 'linear:st_gone' },
      ],
      statuses: STATUSES,
    });

    assert.equal(before.pins, 2, 'the control draws its two pins, so an empty page cannot pass');
    assert.equal(after.markup, before.markup);
    assert.deepEqual(after.notes, before.notes);
  });

  it('draws the same with a list it could not use at all', async () => {
    const before = await drawn({ issues: [REVIEW] });

    for (const statuses of [null, 'In Review', [{ key: '', stage: 'blue', color: 'url(x)' }], {}]) {
      const after = await drawn({ issues: [{ ...REVIEW, status: 'linear:st_review' }], statuses });

      assert.equal(after.markup, before.markup, JSON.stringify(statuses));
    }
  });

  it('paints the pin with the colour of its status, and writes its text colour on it (FRU-370)', async () => {
    const { root } = await drawn({
      issues: [
        { ...REVIEW, status: 'linear:st_review' },
        { ...DONE, status: 'linear:st_done' },
      ],
      statuses: STATUSES,
    });
    const [review, done] = [...root.querySelectorAll<HTMLElement>('.fruitback-pin')];

    assert.equal(review?.style.getPropertyValue('--fruitback-pin-color'), '#7dd3fc');
    // The text colour the team chose.
    assert.equal(review?.style.getPropertyValue('--fruitback-pin-on-color'), '#18181b');
    assert.equal(review?.dataset.fruitbackStatus, 'linear:st_review');
    // The stage stays the stage: the filters and the counts are by stage.
    assert.equal(review?.dataset.fruitbackStage, 'progress');
    assert.equal(done?.style.getPropertyValue('--fruitback-pin-color'), '#15803d');
    // No text colour in the list: computed, white on this green (5.02:1), not the ink (3.53:1).
    assert.equal(done?.style.getPropertyValue('--fruitback-pin-on-color'), '#ffffff');
  });

  it('keeps the token of the stage for a status with no colour, so a host that set it keeps it', async () => {
    const { root } = await drawn({
      issues: [{ ...REVIEW, status: 'own:progress' }],
      statuses: [{ key: 'own:progress', name: '', stage: 'progress' }],
    });
    const pin = root.querySelector<HTMLElement>('.fruitback-pin');

    assert.equal(pin?.style.getPropertyValue('--fruitback-pin-color'), 'var(--fruitback-stage-progress)');
    assert.equal(pin?.dataset.fruitbackStatus, 'own:progress');
  });

  it('names the status in the thread, the list and the notes it gives a list outside the page', async () => {
    const { root, notes, widget } = await drawn({
      issues: [{ ...REVIEW, stateName: '', status: 'own:review' }],
      statuses: [{ key: 'own:review', name: 'Waiting for the client', stage: 'progress', color: '#fde68a' }],
    });

    root.querySelector<HTMLElement>('.fruitback-pin-badge')?.click();
    assert.equal(root.querySelector('.fruitback-thread-state')?.textContent, 'Waiting for the client');
    assert.equal(
      (root.querySelector('.fruitback-thread') as HTMLElement).style.getPropertyValue('--fruitback-pin-color'),
      '#fde68a',
    );

    widget.showEveryNote();
    assert.equal(root.querySelector('.fruitback-sidebar-status')?.textContent, 'Waiting for the client');
    const drop = root.querySelector<HTMLElement>('.fruitback-sidebar-pin');
    assert.equal(drop?.style.getPropertyValue('--fruitback-sidebar-stage'), '#fde68a');
    // A light colour the team chose: the ink, computed.
    assert.equal(drop?.style.getPropertyValue('--fruitback-sidebar-on-stage'), '#18181b');

    assert.deepEqual(notes?.[0]?.status, {
      key: 'own:review',
      name: 'Waiting for the client',
      stage: 'progress',
      color: '#fde68a',
    });
    // The store named nothing: no word to pass on, and the side panel writes the status.
    assert.equal(notes?.[0]?.stateName, undefined);
  });

  it('hands a list outside the page the word of the store, with no status', async () => {
    const { notes } = await drawn({ issues: [REVIEW] });

    assert.equal(notes?.[0]?.stateName, 'In Review');
    assert.equal(notes?.[0]?.status, undefined);
  });
});
