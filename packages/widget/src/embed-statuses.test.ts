import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * A widget that does not read the statuses of FRU-364 draws a read that carries them exactly as one
 * that does not (FRU-364).
 *
 * This widget is that widget until FRU-370: it reads no `statuses` and no `status`. So the test is
 * the promise to every widget already served from `/v/<version>/`, cached a year on host pages:
 * a worker that starts sending the fields changes nothing they draw. FRU-370 makes the widget read
 * them, and then keeps this case for a read whose status it cannot use.
 */

const ENDPOINT = 'https://worker.test';
const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};
const REVIEW = seedIssueFixture({
  id: 'issue_1',
  identifier: 'FB-1',
  stage: 'progress',
  stateName: 'In Review',
  seed: seedFixture({ id: 'seed-1', note: 'Could the title mention Bordeaux?', anchor: ANCHOR }),
});
const DONE = seedIssueFixture({
  id: 'issue_2',
  identifier: 'FB-2',
  stage: 'done',
  stateName: 'Done',
  seed: seedFixture({ id: 'seed-2', note: 'An old one.', anchor: ANCHOR }),
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

  return { markup: root.innerHTML, notes: widget.pageNotes(), pins: root.querySelectorAll('.fruitback-pin').length };
}

describe('a read that carries statuses, to a widget that does not read them (FRU-364)', () => {
  it('draws the same pins, the same words and the same colours as the read without them', async () => {
    const before = await drawn({ issues: [REVIEW, DONE] });
    const after = await drawn({
      issues: [
        { ...REVIEW, status: 'linear:st_review' },
        // A status of another stage, and a key that is in no list: still drawn by the stage.
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
});
