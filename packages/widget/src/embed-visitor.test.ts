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
