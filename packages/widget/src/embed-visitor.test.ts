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

  it('tells the author that the team keeps the text of before, on a site that keeps every version, and only there (FRU-704)', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    pageFetch(readOf(aNote({ mine: true, editable: true, versionsKept: true })));
    const root = await threadOf(page, {});
    (root.querySelector('.fruitback-thread-edit') as HTMLButtonElement).click();
    assert.equal(
      root.querySelector('.fruitback-thread-edit-kept')?.textContent,
      'The team of this site keeps the text of before in the history of the note.',
    );
    for (const undo of cleanup.splice(0)) undo();
    mock.restoreAll();

    const elsewhere = mounted();
    elsewhere.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    pageFetch(readOf(aNote({ mine: true, editable: true })));
    const other = await threadOf(elsewhere, {});
    (other.querySelector('.fruitback-thread-edit') as HTMLButtonElement).click();
    assert.ok(other.querySelector('.fruitback-thread-edit-field') !== null, 'the form is open');
    assert.equal(other.querySelector('.fruitback-thread-edit-kept'), null);
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

  it('makes no key, and sends none, for a mount whose host carries the calls', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const sent: TransportRequest[] = [];
    const transport = async (request: TransportRequest): Promise<TransportResponse> => {
      sent.push(request);

      return { ok: true, status: 200, body: readOf(aNote({ mine: true }), true) };
    };
    await threadOf(page, { transport });

    assert.equal(sent[0]?.headers[VISITOR_HEADER], undefined);
  });
});

describe('a visitor the site signs, through init (FRU-706)', () => {
  it('sends the key of this browser beside the token, for the worker to fall back on', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const headers = pageFetch(readOf(aNote()));
    await threadOf(page, { identityToken: () => 'token.1' });

    assert.equal(headers[0]?.Authorization, 'Bearer token.1');
    assert.equal(headers[0]?.[VISITOR_HEADER], 'K'.repeat(43));
  });

  it('shows « You » and what a visitor may do on a note of a person the site signed', async () => {
    const page = mounted();
    pageFetch(
      JSON.stringify({
        issues: [aNote({ mine: true, editable: true, withdrawable: true })],
        identified: true,
        visitor: 'signed',
      }),
    );
    const root = await threadOf(page, { identityToken: () => 'token.1' });

    assert.equal(root.querySelector('.fruitback-thread-you')?.textContent, 'You');
    assert.equal(
      root.querySelector('.fruitback-thread-you-may')?.textContent,
      'You can edit or delete it until a member picks it up.',
    );
  });

  it('shows no chip for a token the worker does not say is a visitor of the site', async () => {
    const page = mounted();
    pageFetch(readOf(aNote({ mine: true }), true));
    const root = await threadOf(page, { identityToken: () => 'token.1' });

    assert.equal(root.querySelector('.fruitback-thread-you'), null);
  });
});

describe('a visitor asked for a confirmed address, through init (FRU-705)', () => {
  /** `fetch` of the page: each call, and the read answering `body`, every other call `{ sent: true }`. */
  function pageCalls(body: string): { url: string; method: string; headers: Record<string, string>; body?: string }[] {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers as Record<string, string>) },
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });

      return new Response(init?.method === 'POST' ? JSON.stringify({ sent: true }) : body, {
        status: init?.method === 'POST' ? 202 : 200,
      });
    });

    return calls;
  }

  it('asks for an address under a note of theirs, and sends it with the key of this browser and the page', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const calls = pageCalls(JSON.stringify({ issues: [aNote({ mine: true })], confirm: 'email' }));
    const root = await threadOf(page, {});

    const form = root.querySelector('.fruitback-thread-confirm') as HTMLFormElement;
    assert.equal(
      form.querySelector('.fruitback-thread-you-may')?.textContent,
      'Confirm your address to edit or delete your note, here and on your other browsers.',
    );
    const field = form.querySelector('input') as HTMLInputElement;
    field.value = 'ana@example.com';
    field.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('input'));
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = calls.find((call) => call.url.includes('/feedback/visitor/email'));
    assert.equal(asked?.method, 'POST');
    assert.equal(asked?.headers[VISITOR_HEADER], 'K'.repeat(43));
    assert.deepEqual(JSON.parse(asked?.body ?? '{}'), {
      email: 'ana@example.com',
      url: 'https://preview.acme.test/pricing',
      // The language of the widget: the worker writes the message in it.
      locale: 'en-US',
    });
    assert.equal(
      root.querySelector('.fruitback-thread-confirm .fruitback-thread-reply-status')?.textContent,
      'Open the link we sent, in this browser, within 30 minutes.',
    );
  });

  it('asks for nothing where the worker does not: a note of theirs offers the edit as before', async () => {
    const page = mounted();
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    pageCalls(readOf(aNote({ mine: true, editable: true })));
    const root = await threadOf(page, {});

    assert.equal(root.querySelector('.fruitback-thread-confirm'), null);
  });

  it('sends the link the page was opened with, once, and takes it out of the address', async () => {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_000,
      height: 1_000,
      url: 'https://preview.acme.test/pricing#fruitback-confirm=123.abc.def.ghi',
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    page.view.localStorage.setItem(`${VISITOR_KEY_PREFIX}site_acme`, 'K'.repeat(43));
    const calls = pageCalls(readOf(aNote({ mine: true })));
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'site_acme' });
    cleanup.push(() => widget.destroy());
    await widget.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirms = calls.filter((call) => call.url.includes('/feedback/visitor/confirm'));
    assert.equal(confirms.length, 1);
    assert.deepEqual(JSON.parse(confirms[0]?.body ?? '{}'), { token: '123.abc.def.ghi' });
    assert.equal(confirms[0]?.headers[VISITOR_HEADER], 'K'.repeat(43));
    assert.equal(page.view.location.hash, '');
  });
});
