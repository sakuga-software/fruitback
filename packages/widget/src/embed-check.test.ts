import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The verdict of the author from the thread of the pin, as `init` wires it (FRU-603): the read says
 * who left the note (`mine`), the verdict goes through the transport of the host, the same
 * `POST /feedback/<id>/check` as `checkNote` (FRU-300), and no read follows it.
 */

const ENDPOINT = 'https://worker.test';
const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};

function aDoneNote(overrides: Partial<NoteIssue> = {}): NoteIssue {
  return noteIssueFixture({
    id: 'issue_42',
    stage: 'done',
    stateName: 'Done',
    mine: true,
    comments: [{ id: 'c1', body: 'Fixed.', createdAt: '2026-11-05T10:00:00.000Z', author: 'Marc Petit' }],
    note: noteFixture({ anchor: ANCHOR }),
    ...overrides,
  });
}

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

/** A worker that reads `issue`, and keeps a verdict as the worker of FRU-294 answers it. */
function worker(issue: NoteIssue, refusal?: { status: number; error: string }) {
  const requests: TransportRequest[] = [];
  const transport = async (request: TransportRequest): Promise<TransportResponse> => {
    requests.push(request);
    if (request.method === 'GET')
      return { ok: true, status: 200, body: JSON.stringify({ issues: [issue], canReply: true }) };
    if (refusal !== undefined)
      return { ok: false, status: refusal.status, body: JSON.stringify({ error: refusal.error }) };
    const { verdict } = JSON.parse(request.body ?? '{}') as { verdict: string };

    return {
      ok: true,
      status: 201,
      body: JSON.stringify({
        comment: {
          id: 'c2',
          body: `**Camille** via Fruitback · member of Acme\n${verdict === 'fixed' ? 'Checked: looks fixed' : 'Reopened: still wrong'}`,
          createdAt: '2026-11-06T09:00:00.000Z',
          author: 'Camille',
        },
        stage: verdict === 'fixed' ? 'done' : 'new',
      }),
    };
  };

  return { requests, transport };
}

async function threadOf(page: MountedPage, options: Partial<Parameters<typeof init>[0]>) {
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', ...options });
  cleanup.push(() => widget.destroy());
  await widget.refresh();
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
  (root.querySelector('.fruitback-pin-badge') as HTMLElement).click();

  return root;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the verdict from the thread of the pin, through init (FRU-603)', () => {
  it('asks the author the read names, and nobody else; never when the host says no replies', async () => {
    const { mine: _mine, ...notMine } = aDoneNote();
    const cases = [
      [aDoneNote(), {}, true],
      [noteIssueFixture(notMine), {}, false],
      [aDoneNote({ checked: { by: 'Camille', at: '2026-11-06T09:00:00.000Z' } }), {}, false],
      [aDoneNote(), { replies: false }, false],
    ] as const;
    for (const [issue, options, asked] of cases) {
      const root = await threadOf(mounted(), { transport: worker(issue).transport, ...options });

      assert.equal(
        root.querySelector('.fruitback-thread-check') !== null,
        asked,
        JSON.stringify([issue.mine, options]),
      );
      for (const undo of cleanup.splice(0)) undo();
    }
  });

  it('posts « Still wrong » and what was typed to the note, through the transport, and reads nothing after', async () => {
    const { requests, transport } = worker(aDoneNote());
    const root = await threadOf(mounted(), { transport });
    const reads = requests.filter((request) => request.method === 'GET').length;

    (root.querySelector('.fruitback-thread-check-wrong') as HTMLButtonElement).click();
    (root.querySelector('.fruitback-thread-check-field') as HTMLTextAreaElement).value = 'Still 12 €.';
    (root.querySelector('.fruitback-thread-check-form') as HTMLFormElement).requestSubmit();
    await settle();

    const posted = requests.find((request) => request.method === 'POST') as TransportRequest;
    assert.equal(posted.url, `${ENDPOINT}/feedback/issue_42/check?client=acme`);
    assert.deepEqual(JSON.parse(posted.body ?? '{}'), {
      url: 'https://preview.acme.test/pricing',
      verdict: 'wrong',
      body: 'Still 12 €.',
    });
    assert.equal(requests.filter((request) => request.method === 'GET').length, reads, 'a read after the verdict');
    // The pin takes the stage the worker answered, and the thread stays open with the answer.
    assert.equal((root.querySelector('[data-fruitback-pin]') as HTMLElement).dataset.fruitbackStage, 'new');
    assert.equal(root.querySelector('.fruitback-thread-check-said')?.textContent, 'Sent. The note is open again.');
  });

  it('posts « Looks fixed » alone', async () => {
    const { requests, transport } = worker(aDoneNote());
    const root = await threadOf(mounted(), { transport });
    (root.querySelector('.fruitback-thread-check-fixed') as HTMLButtonElement).click();
    await settle();

    const posted = requests.find((request) => request.method === 'POST') as TransportRequest;
    assert.deepEqual(JSON.parse(posted.body ?? '{}'), { url: 'https://preview.acme.test/pricing', verdict: 'fixed' });
    assert.equal(root.querySelector('.fruitback-thread-check'), null);
    assert.equal(
      root.querySelector('.fruitback-thread-check-said')?.textContent,
      'Thank you. The team knows it looks fixed.',
    );
  });

  for (const body of ['', 'null', '"ok"', '42', 'true', '[]'])
    it(`reads nothing after a verdict the worker kept with no answer (${body || 'empty'}): the thread stays open (review)`, async () => {
      const requests: TransportRequest[] = [];
      const transport = async (request: TransportRequest): Promise<TransportResponse> => {
        requests.push(request);
        if (request.method === 'GET') {
          return { ok: true, status: 200, body: JSON.stringify({ issues: [aDoneNote()], canReply: true }) };
        }

        return { ok: true, status: 201, body };
      };
      const root = await threadOf(mounted(), { transport });
      const reads = requests.filter((request) => request.method === 'GET').length;
      (root.querySelector('.fruitback-thread-check-fixed') as HTMLButtonElement).click();
      await settle();

      assert.equal(requests.filter((request) => request.method === 'GET').length, reads);
      assert.notEqual(root.querySelector('.fruitback-thread'), null);
      assert.equal(root.querySelector('.fruitback-thread-check'), null);
    });

  it('says the refusal of the worker, and keeps the question', async () => {
    const root = await threadOf(mounted(), {
      transport: worker(aDoneNote(), { status: 409, error: 'not-done' }).transport,
    });
    (root.querySelector('.fruitback-thread-check-fixed') as HTMLButtonElement).click();
    await settle();

    assert.notEqual(root.querySelector('.fruitback-thread-check'), null);
    assert.match(root.querySelector('.fruitback-thread-check-status')?.textContent ?? '', /did not take this answer/);
  });
});
