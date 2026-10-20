import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type NotesChange, init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The notes of the page for a list outside it (FRU-299): `pageNotes`, `focusNote`, `markNote`,
 * `replyTo` and `watchNotes`, as the side panel of the extension uses them.
 */

const ENDPOINT = 'https://worker.test';
const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};
const MINE = seedIssueFixture({
  id: 'issue_1',
  identifier: 'FB-1',
  stage: 'green',
  mine: true,
  comments: [{ id: 'c0', body: 'Planned.', createdAt: '2026-10-19T16:00:00.000Z', author: 'Marc' }],
  seed: seedFixture({ id: 'seed-1', note: 'Could the title mention Bordeaux?', anchor: ANCHOR }),
});
const CLOSED = seedIssueFixture({
  id: 'issue_2',
  identifier: 'FB-2',
  stage: 'composted',
  seed: seedFixture({ id: 'seed-2', note: 'An old one.', anchor: ANCHOR, reporter: { name: 'Léa' } }),
});

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

/** A worker whose read says `read` and lists `issues`, and that keeps every reply with `status`. */
function worker(read: Record<string, unknown>, status = 201) {
  const requests: TransportRequest[] = [];
  const transport = async (request: TransportRequest): Promise<TransportResponse> => {
    requests.push(request);
    if (request.method === 'GET') {
      return { ok: true, status: 200, body: JSON.stringify({ issues: [MINE, CLOSED], ...read }) };
    }

    return {
      ok: status < 400,
      status,
      body: JSON.stringify({ comment: { id: 'c1', body: 'kept', createdAt: '2026-10-20T08:00:00.000Z' } }),
    };
  };

  return { requests, transport };
}

function widgetOn(page: MountedPage, options: Partial<Parameters<typeof init>[0]>) {
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', locale: 'en', ...options });
  cleanup.push(() => widget.destroy());

  return widget;
}

const shadowOf = (page: MountedPage) => page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

describe('the notes of the page for a list outside it (FRU-299)', () => {
  it('gives the notes the pins show, with their numbers, from the last read, and nothing before one', async () => {
    const { requests, transport } = worker({ canReply: true });
    const widget = widgetOn(mounted(), { transport });

    assert.equal(widget.pageNotes(), undefined, 'a list before any read says there is no note');
    await widget.refresh();
    const reads = requests.length;
    const notes = widget.pageNotes();

    assert.deepEqual(notes?.[0], {
      id: 'seed-1',
      number: 1,
      stage: 'green',
      note: 'Could the title mention Bordeaux?',
      mine: true,
      createdAt: MINE.seed.createdAt,
      updatedAt: MINE.updatedAt,
      replies: [{ author: 'Marc', body: 'Planned.', createdAt: '2026-10-19T16:00:00.000Z' }],
      canReply: true,
      placement: 'found',
    });
    assert.deepEqual(
      notes?.map((note) => [note.id, note.number, note.author]),
      [
        ['seed-1', 1, undefined],
        ['seed-2', 2, 'Léa'],
      ],
    );
    assert.equal(requests.length, reads, 'the list cost a request');
    // Plain data: it crosses a `postMessage`.
    assert.deepEqual(structuredClone(notes), notes);
  });

  it('gives a reply written from a page as its thread shows it: the name, and the text unquoted', async () => {
    const answered = {
      ...MINE,
      comments: [
        {
          id: 'c9',
          body: '**Dev** via Fruitback · member of Playground\n\n> Seen, thanks.\n> Two lines.',
          createdAt: '2026-10-20T09:00:00.000Z',
        },
      ],
    };
    const transport = async (request: TransportRequest): Promise<TransportResponse> => ({
      ok: true,
      status: 200,
      body: request.method === 'GET' ? JSON.stringify({ issues: [answered] }) : '{}',
    });
    const widget = widgetOn(mounted(), { transport });
    await widget.refresh();

    assert.deepEqual(widget.pageNotes()?.[0]?.replies, [
      { author: 'Dev', body: 'Seen, thanks.\nTwo lines.', createdAt: '2026-10-20T09:00:00.000Z' },
    ]);
  });

  it('says where its read is: pending before one answers, read, or failed (raised in review)', async () => {
    const pending = widgetOn(mounted(), { transport: worker({}).transport });
    assert.equal(pending.notesState(), 'pending');
    await pending.refresh();
    assert.equal(pending.notesState(), 'read');

    const failing = async (): Promise<TransportResponse> => ({ ok: false, status: 503, body: '{}' });
    const failed = widgetOn(mounted(), { transport: failing });
    await failed.refresh();
    assert.equal(failed.notesState(), 'failed');
    assert.equal(failed.pageNotes(), undefined);
  });

  it('leaves out a stage the reporter hid, and says the list changed', async () => {
    const page = mounted();
    const widget = widgetOn(page, { transport: worker({}).transport });
    const changes: NotesChange[] = [];
    widget.watchNotes((change) => changes.push(change));
    await widget.refresh();
    // The read of the mount and the refresh: each is a change.
    assert.ok(changes.length > 0 && changes.every((change) => change.kind === 'list'), 'a read is a change');

    (shadowOf(page).querySelector('[name="stage-composted"]') as HTMLInputElement).click();
    assert.deepEqual(
      widget.pageNotes()?.map((note) => note.id),
      ['seed-1'],
    );
    assert.deepEqual(changes.at(-1), { kind: 'list' });
  });

  it('offers no reply where the worker does not let this reader reply, or the host says never', async () => {
    for (const [read, options] of [
      [{}, {}],
      [{ canReply: true }, { replies: false }],
    ] as const) {
      const widget = widgetOn(mounted(), { transport: worker(read).transport, ...options });
      await widget.refresh();
      assert.equal(widget.pageNotes()?.[0]?.canReply, false, JSON.stringify([read, options]));
      assert.equal(await widget.replyTo('seed-1', 'Hi'), 'refused');
    }
  });

  it('opens the thread of a note, and says which note was opened on the page', async () => {
    const page = mounted();
    const widget = widgetOn(page, { transport: worker({}).transport });
    const changes: NotesChange[] = [];
    widget.watchNotes((change) => changes.push(change));
    await widget.refresh();

    assert.equal(widget.focusNote('seed-1'), true);
    assert.notEqual(shadowOf(page).querySelector('[role="dialog"]'), null, 'no thread opened');
    assert.deepEqual(changes.at(-1), { kind: 'open', id: 'seed-1' });
    assert.equal(widget.focusNote('nobody'), false);

    // A click on a pin says it too.
    widget.focusNote('seed-1');
    (shadowOf(page).querySelectorAll('.fruitback-pin-badge')[1] as HTMLElement).click();
    assert.deepEqual(changes.at(-1), { kind: 'open', id: 'seed-2' });
  });

  it('marks the pin of the row open in the list, and keeps it marked across a read', async () => {
    const page = mounted();
    const widget = widgetOn(page, { transport: worker({}).transport });
    await widget.refresh();
    const marked = () =>
      [...shadowOf(page).querySelectorAll<HTMLElement>('.fruitback-pin')]
        .filter((pin) => pin.dataset.fruitbackMarked !== undefined)
        .map((pin) => pin.querySelector('.fruitback-pin-badge')?.textContent?.trim());

    widget.markNote('seed-2');
    assert.deepEqual(marked(), ['2']);
    await widget.refresh();
    assert.deepEqual(marked(), ['2'], 'a read lost the mark');
    widget.markNote(undefined);
    assert.deepEqual(marked(), []);
  });

  it('sends a reply by the path of the thread, then reads again', async () => {
    const { requests, transport } = worker({ canReply: true });
    const widget = widgetOn(mounted(), { transport });
    await widget.refresh();
    const reads = requests.filter((request) => request.method === 'GET').length;

    assert.equal(await widget.replyTo('seed-1', '  Merci  '), 'sent');
    const posted = requests.find((request) => request.method === 'POST') as TransportRequest;
    assert.equal(posted.url, `${ENDPOINT}/feedback/issue_1/replies?client=acme`);
    assert.equal(JSON.parse(posted.body ?? '{}').body, 'Merci');
    assert.equal(requests.filter((request) => request.method === 'GET').length, reads + 1, 'no read after the reply');
    assert.equal(await widget.replyTo('seed-1', '   '), 'refused');
    assert.equal(await widget.replyTo('nobody', 'Hi'), 'refused');
  });

  it('says why a reply did not go', async () => {
    for (const [status, outcome] of [
      [429, 'wait'],
      [401, 'signed-out'],
      [500, 'retry'],
    ] as const) {
      const widget = widgetOn(mounted(), { transport: worker({ canReply: true }, status).transport });
      await widget.refresh();
      assert.equal(await widget.replyTo('seed-1', 'Hi'), outcome);
    }
  });

  it('keeps the page when a listener throws, and stops telling one that stopped', async () => {
    const widget = widgetOn(mounted(), { transport: worker({}).transport });
    const told: NotesChange[] = [];
    widget.watchNotes(() => {
      throw new Error('the list broke');
    });
    const stop = widget.watchNotes((change) => told.push(change));
    await widget.refresh();
    const before = told.length;
    assert.ok(before > 0, 'the second listener was not told');
    stop();
    await widget.refresh();

    assert.equal(told.length, before);
  });
});
