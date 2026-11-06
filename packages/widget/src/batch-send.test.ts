import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePageUrl } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { init } from './embed.ts';
import { createDraftStore } from './drafts.ts';
import { createTypingStore } from './typing.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * « Send all » through `init` (FRU-608), for the path the composer cannot see: a note with a file
 * goes alone first, with its file, then the batch. Raised in review: when the note goes and the batch
 * fails, the receipt says the note went and the batch did not, and the batch keeps its notes.
 */

const ENDPOINT = 'https://worker.test';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function mounted(): MountedPage {
  const page = mountPage('<main><button class="add" data-testid="cta">Commander</button></main>', {
    width: 1_000,
    height: 1_000,
  });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
  // The choice of the element reads its component with react-grab, which reads the global `window`.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: page.view, configurable: true, writable: true });
  cleanup.push(() =>
    had === undefined ? Reflect.deleteProperty(globalThis, 'window') : Object.defineProperty(globalThis, 'window', had),
  );

  return page;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('« Send all » with a file, through init (FRU-608)', () => {
  it('sends the note with its file alone, then the batch, and says what went when the batch fails', async () => {
    const page = mounted();
    const url = canonicalizePageUrl(page.view.location.href);
    // One note waits in the batch of this tab.
    createDraftStore({ storage: page.view.sessionStorage, key: 'fruitback:config:notes' }).add({
      note: noteFixture({ id: 'sd_waiting', text: 'Une note du lot', page: { url, path: '/', title: 'Page' } }),
    });
    // The composer opens again on the button, with the text left there (FRU-311).
    createTypingStore({ storage: page.view.sessionStorage, key: 'fruitback:config:typing' }).write(
      {
        page: url,
        anchor: {
          selector: '[data-testid="cta"]',
          tag: 'button',
          text: 'Commander',
          bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
        },
      },
      'Avec un fichier',
    );
    const writes: TransportRequest[] = [];
    // The worker reads back what it kept, as it does after a write.
    const kept: unknown[] = [];
    const transport = async (request: TransportRequest): Promise<TransportResponse> => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ issues: kept, batch: { max: 10, maxBytes: 65_536 }, canAttach: true }),
        };
      }
      writes.push(request);
      if (path === '/attachments')
        return { ok: true, status: 201, body: JSON.stringify({ id: `att_${'a'.repeat(32)}` }) };
      // The note alone, with its file, is kept; the batch after it is not.
      if (!request.body?.startsWith('[')) {
        kept.push(noteIssueFixture({ identifier: 'DEV-1', note: JSON.parse(request.body ?? '{}') }));
        return { ok: true, status: 201, body: JSON.stringify({ issue: { id: 'i1', identifier: 'DEV-1' } }) };
      }

      return { ok: false, status: 502, body: JSON.stringify({ error: 'store-unavailable' }) };
    };
    const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', transport });
    cleanup.push(() => widget.destroy());
    await widget.refresh();
    await settle(60);
    const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
    const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
    assert.equal(q<HTMLTextAreaElement>('[data-fruitback-note]').value, 'Avec un fichier', 'the composer did not open');
    assert.equal(q('[data-fruitback-send]').textContent, 'Send all 2');

    // A file of the disk joins the note.
    const input = q<HTMLInputElement>('[data-fruitback-attach-file-input]');
    const view = page.view as unknown as { File: typeof File; Event: typeof Event };
    Object.defineProperty(input, 'files', { value: [new view.File(['une ligne'], 'log.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    for (let n = 0; n < 20 && q('.fruitback-composer-file')?.dataset.fruitbackFile !== 'ready'; n += 1)
      await settle(10);
    assert.equal(q('.fruitback-composer-file')?.dataset.fruitbackFile, 'ready');

    q<HTMLButtonElement>('[data-fruitback-send]').click();
    for (let n = 0; n < 40 && q('[data-fruitback-receipt]')?.hidden !== false; n += 1) await settle(10);

    // The note went alone, with its file, then the batch, as an array.
    const notes = writes.filter((each) => new URL(each.url).pathname === '/feedback');
    assert.equal(notes.length, 2);
    assert.match(notes[0]?.url ?? '', /attachments=att_/);
    assert.equal((JSON.parse(notes[0]?.body ?? '{}') as { text: string }).text, 'Avec un fichier');
    assert.deepEqual(
      (JSON.parse(notes[1]?.body ?? '[]') as { id: string }[]).map((note) => note.id),
      ['sd_waiting'],
    );
    // The receipt says it: the note went, the batch did not, and it keeps its text.
    assert.equal(q('[data-fruitback-receipt-title]').textContent, '1 sent, 1 not sent');
    assert.equal(q('[data-fruitback-receipt-row="sent"] .fruitback-composer-receipt-id').textContent, 'DEV-1');
    assert.equal(
      q('[data-fruitback-receipt-row="unsent"] .fruitback-composer-receipt-text').textContent,
      'Une note du lot',
    );
    assert.equal(q<HTMLButtonElement>('[data-fruitback-receipt-retry]').hidden, false);
    assert.deepEqual(
      createDraftStore({ storage: page.view.sessionStorage, key: 'fruitback:config:notes' })
        .list()
        .map((draft) => draft.note.id),
      ['sd_waiting'],
      'the batch lost the note that did not go',
    );
  });
});
