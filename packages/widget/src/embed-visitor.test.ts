import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { VISITOR_HEADER, VISITOR_KEY_PREFIX } from './visitor-key.ts';

/**
 * A visitor known by the key of their browser, through `init` (FRU-700): a mount of a page with no
 * token and no transport of a host keeps a key for its site, and a note the read says is `mine`
 * carries « You · this browser ». The worker decides who it is; the widget only shows it.
 */

const ENDPOINT = 'https://worker.test';
const ANCHOR = {
  selector: '[data-testid="cta"]',
  tag: 'button',
  text: 'Commander',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
  mock.restoreAll();
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

function aNote(overrides: Partial<NoteIssue> = {}): NoteIssue {
  return noteIssueFixture({
    id: 'issue_7',
    stage: 'new',
    stateName: 'New',
    note: noteFixture({ anchor: ANCHOR }),
    ...overrides,
  });
}

/** The answer of a read: the note, and `identified` when the worker names the reader by a session. */
function readOf(issue: NoteIssue, identified = false): string {
  return JSON.stringify({ issues: [issue], ...(identified ? { identified: true } : {}) });
}

async function threadOf(page: MountedPage, options: Partial<Parameters<typeof init>[0]>) {
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'site_acme', ...options });
  cleanup.push(() => widget.destroy());
  await widget.refresh();
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
  (root.querySelector('.fruitback-pin-badge') as HTMLElement).click();

  return root;
}

/** `fetch` of the page, answering each read with `body`, and keeping the headers of each call. */
function pageFetch(body: string): Record<string, string>[] {
  const headers: Record<string, string>[] = [];
  mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    headers.push({ ...(init?.headers as Record<string, string>) });

    return new Response(body, { status: 200 });
  });

  return headers;
}

describe('a visitor known by the key of their browser, through init (FRU-700)', () => {
  it('shows « You · this browser » on a note the read says is mine, for a reader with no session', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const headers = pageFetch(readOf(aNote({ mine: true })));
    const root = await threadOf(page, {});

    assert.equal(root.querySelector('.fruitback-thread-you')?.textContent, 'You · this browser');
    // The key of this browser went with the read.
    assert.equal(headers[0]?.[VISITOR_HEADER], 'K'.repeat(43));
  });

  it('shows no chip on a note of somebody else, nor for a reader the worker names by a session', async () => {
    pageFetch(readOf(aNote()));
    assert.equal((await threadOf(mounted(), {})).querySelector('.fruitback-thread-you'), null);
    for (const undo of cleanup.splice(0)) undo();
    mock.restoreAll();

    pageFetch(readOf(aNote({ mine: true }), true));
    assert.equal((await threadOf(mounted(), {})).querySelector('.fruitback-thread-you'), null);
  });

  it('offers a visitor known by their browser « Edit the text », no move, and says where the new text goes (FRU-701)', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const headers = pageFetch(
      readOf(aNote({ mine: true, editable: true, url: 'https://linear.app/acme/issue/ACM-7' })),
    );
    const root = await threadOf(page, {});

    const items = [...root.querySelectorAll('.fruitback-thread-more-item')].map((item) => item.textContent);
    assert.deepEqual(items, ['Edit the text', 'Copy link to the note']);
    assert.equal(
      root.querySelector('.fruitback-thread-you-may')?.textContent,
      'You can edit it until a member picks it up.',
    );
    (root.querySelector('.fruitback-thread-edit') as HTMLButtonElement).click();
    assert.equal(root.querySelector('.fruitback-thread-edit-sent')?.textContent, 'Edited text is sent to Linear too');
    assert.equal(headers[0]?.[VISITOR_HEADER], 'K'.repeat(43));
  });

  it('keeps the words and the move of a member: the read names them by a session', async () => {
    pageFetch(readOf(aNote({ mine: true, editable: true, url: 'https://linear.app/acme/issue/ACM-7' }), true));
    const root = await threadOf(mounted(), {});

    const items = [...root.querySelectorAll('.fruitback-thread-more-item')].map((item) => item.textContent);
    assert.deepEqual(items, ['Edit the note', 'Copy link to the note', 'Move the note']);
    assert.equal(root.querySelector('.fruitback-thread-you-may'), null);
    (root.querySelector('.fruitback-thread-edit') as HTMLButtonElement).click();
    assert.equal(root.querySelector('.fruitback-thread-edit-sent'), null);
  });

  it('deletes a note of a visitor after « Delete your note? », and reads the page again when its thread closes (FRU-702)', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const note = aNote({ mine: true, editable: true, withdrawable: true, url: 'https://linear.app/acme/issue/ACM-7' });
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (init?.method === 'POST') return new Response(JSON.stringify({ stage: 'closed' }), { status: 200 });

      return new Response(readOf(calls.length > 2 ? aNote({ id: 'issue_8' }) : note), { status: 200 });
    });
    const root = await threadOf(page, {});

    const items = [...root.querySelectorAll<HTMLButtonElement>('.fruitback-thread-more-item')];
    assert.deepEqual(
      items.map((item) => item.textContent),
      ['Edit the text', 'Copy link to the note', 'Delete the note'],
    );
    assert.equal(items.at(-1)?.dataset.fruitbackDanger, '');
    assert.equal(
      root.querySelector('.fruitback-thread-you-may')?.textContent,
      'You can edit or delete it until a member picks it up.',
    );
    items.at(-1)?.click();
    assert.equal(root.querySelector('.fruitback-thread-withdraw-ask')?.textContent, 'Delete your note?');
    assert.equal(
      root.querySelector('.fruitback-thread-withdraw-detail')?.textContent,
      'The pin goes away for everyone. The issue in Linear is closed as withdrawn.',
    );
    (root.querySelector('.fruitback-thread-withdraw-confirm') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      root.querySelector('.fruitback-thread-withdraw-said')?.textContent,
      'Deleted. The pin goes away when you close this note.',
    );
    const before = calls.length;
    (root.querySelector('.fruitback-thread-close') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls.slice(before), ['GET /feedback']);
    assert.ok(calls.includes('POST /feedback/issue_7/withdraw'), JSON.stringify(calls));
  });

  it('makes no key, and sends none, for a mount whose host names the reporter or carries the calls', async () => {
    const page = mounted();
    const sent: TransportRequest[] = [];
    const transport = async (request: TransportRequest): Promise<TransportResponse> => {
      sent.push(request);

      return { ok: true, status: 200, body: readOf(aNote({ mine: true }), true) };
    };
    await threadOf(page, { transport });
    const headers = pageFetch(readOf(aNote({ mine: true }), true));
    await threadOf(page, { identityToken: () => 'token.1' });

    assert.equal(sent[0]?.headers[VISITOR_HEADER], undefined);
    assert.equal(headers[0]?.[VISITOR_HEADER], undefined);
    assert.equal(page.view.localStorage.getItem(`${VISITOR_KEY_PREFIX}site_acme`), null);
  });
});
