import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENTS_PER_NOTE, MAX_ATTACHMENT_BYTES } from '@fruitback/shared';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { type AttachSeam, type Composer, createComposer } from './composer.ts';
import { type AttachRefusal, type PickedFile, readableSize, refusalBefore, refusalOf } from './attachments.ts';
import { MIN_SIDE, STEP, clamp, pickArea } from './area.ts';
import { attachOffer, failureOf, plant, uploadAttachment } from './embed.ts';
import { offeredDestinations } from './destinations.ts';
import { createOverlay } from './overlay.ts';
import { base64OfBytes, bytesOfBase64, fetchTransport } from './transport.ts';
import type { TransportRequest } from './transport.ts';
import { keyboardEventCtor, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { createTranslator } from './messages.ts';
import { deepActiveElement } from './focus.ts';

/**
 * The files of a note, in the widget (FRU-332): the composer joins them and says why one did not go,
 * the host sends each one on its way, the note names them, and its thread says how many there are,
 * with no file shown.
 */

const ANCHOR = { left: 100, top: 200, bottom: 240, right: 300 };
const ENDPOINT = 'https://worker.test';
const FILE: PickedFile = { name: 'page.png', type: 'image/png', size: 4, base64: 'iVBORw==' };
const ID = `att_${'a'.repeat(32)}`;

let composer: Composer | null = null;
afterEach(() => {
  composer?.destroy();
  composer = null;
  mock.restoreAll();
});

type Upload = {
  file: PickedFile;
  destination: string | undefined;
  answer: (value: Awaited<ReturnType<AttachSeam['upload']>>) => void;
};

function mount(seam: Partial<AttachSeam> = {}, more: { keep?: boolean } = {}) {
  const page = mountPage('<main></main>', { width: 1_000, height: 1_000 });
  const host = page.document.createElement('div');
  page.document.body.append(host);
  const uploads: Upload[] = [];
  const submitted: (readonly string[])[] = [];
  let reply: (value: true | 'attachment-gone' | 'no-tracker') => void = () => {};
  composer = createComposer({
    document: page.document,
    host,
    onSubmit: (_note, _reporter, _destination, attachments = []) => {
      submitted.push(attachments);

      return new Promise((resolve) => (reply = resolve));
    },
    ...(more.keep === true ? { keep: { offered: () => true, onKeep: async () => true as const } } : {}),
    attachments: {
      offer: () => 'offered',
      subscribe: () => () => {},
      captures: () => true,
      capture: async () => FILE,
      upload: (file, destination) => new Promise((answer) => uploads.push({ file, destination, answer })),
      ...seam,
    },
  });
  const root = composer.element;
  const q = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { page, root, q, uploads, submitted, reply: (value: Parameters<typeof reply>[0]) => reply(value), settle };
}

const files = (root: HTMLElement) =>
  [...root.querySelectorAll('.fruitback-composer-file')].map((item) => [
    item.querySelector('.fruitback-composer-file-name')?.textContent,
    item.querySelector('.fruitback-composer-file-detail')?.textContent,
    (item as HTMLElement).dataset.fruitbackFile,
  ]);

describe('the files of a note in the composer (FRU-332)', () => {
  it('offers the four ways, sends a capture on its way at once, and shows its name and size', async () => {
    const { root, q, uploads, settle } = mount();
    composer?.open(ANCHOR);
    const ways = [...root.querySelectorAll('.fruitback-composer-attach-way')].map((way) => [
      way.textContent,
      (way as HTMLElement).hidden,
    ]);
    assert.deepEqual(ways, [
      ['Capture the page', false],
      ['Capture an area', false],
      ['Image', false],
      ['File', false],
    ]);

    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    assert.equal(uploads.length, 1);
    assert.deepEqual(files(root), [['page.png', '0.1 kB · Sending…', 'sending']]);
    uploads[0]?.answer({ ok: true, id: ID });
    await settle();
    assert.deepEqual(files(root), [['page.png', '0.1 kB', 'ready']]);
  });

  it('names the files the worker took, and only those, in the note it sends, after the ones in flight', async () => {
    const { q, uploads, submitted, settle } = mount();
    composer?.open(ANCHOR);
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    uploads[0]?.answer({ ok: false, refusal: 'type' });
    q<HTMLButtonElement>('[data-fruitback-send]').click();
    await settle();
    assert.deepEqual(submitted, [], 'the note waits for the file still on its way');
    uploads[1]?.answer({ ok: true, id: ID });
    await settle();
    assert.deepEqual(submitted, [[ID]]);
  });

  it('says why a file did not go, under its name, and keeps the text of the note', async () => {
    const refusals: AttachRefusal[] = ['too-large', 'type', 'no-tracker', 'full', 'signed-out', 'retry'];
    const { root, q, uploads, settle } = mount();
    composer?.open(ANCHOR);
    const field = q<HTMLTextAreaElement>('[data-fruitback-note]');
    field.value = 'The price is wrong';
    for (const refusal of refusals) {
      q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
      await settle();
      uploads.at(-1)?.answer({ ok: false, refusal });
      await settle();
    }
    assert.deepEqual(
      files(root).map(([, detail, state]) => [detail, state]),
      [
        ['Too large: 10 MB for an image, a PDF or a file, 2 MB for a text, 25 MB for a note', 'refused'],
        ['This file is not what its type says', 'refused'],
        ['This destination takes no file', 'refused'],
        ['Too many files on their way: send your notes first', 'refused'],
        ['Your session has ended: sign in again', 'refused'],
        ['Did not go: remove it, then try again', 'refused'],
      ],
    );
    assert.equal(field.value, 'The price is wrong');
  });

  it('refuses at once a file over its limit, or a sixth file, and sends nothing for it', async () => {
    const big = { ...FILE, name: 'big.png', size: MAX_ATTACHMENT_BYTES.image + 1 };
    let next: PickedFile = big;
    const { root, q, uploads, settle } = mount({ capture: async () => next });
    composer?.open(ANCHOR);
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    assert.deepEqual(files(root)[0]?.slice(0, 2), [
      'big.png',
      'Too large: 10 MB for an image, a PDF or a file, 2 MB for a text, 25 MB for a note',
    ]);
    assert.equal(uploads.length, 0);

    next = FILE;
    for (let n = 0; n < MAX_ATTACHMENTS_PER_NOTE; n += 1) {
      q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
      await settle();
    }
    assert.equal(uploads.length, MAX_ATTACHMENTS_PER_NOTE);
    assert.equal(q('[data-fruitback-attach-page]').getAttribute('aria-disabled'), 'true');
    assert.equal(
      refusalBefore(
        FILE,
        Array.from({ length: MAX_ATTACHMENTS_PER_NOTE }, () => FILE),
      ),
      'too-many',
    );
  });

  it('removes a file by its button, named by the file, and gives the focus back', async () => {
    const { root, q, uploads, settle } = mount();
    composer?.open(ANCHOR);
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    uploads[0]?.answer({ ok: true, id: ID });
    await settle();
    const remove = q<HTMLButtonElement>('.fruitback-composer-file-remove');
    assert.equal(remove.getAttribute('aria-label'), 'Remove page.png');
    remove.focus();
    remove.click();
    assert.deepEqual(files(root), []);
    assert.equal(root.querySelector('[data-fruitback-attach-list]')?.hasAttribute('hidden'), true);
  });

  it('offers no way to join a file when the note stays in Fruitback, and says why', () => {
    const { q } = mount({ offer: () => 'no-tracker' });
    composer?.open(ANCHOR);
    assert.equal(q('[data-fruitback-attach]').hasAttribute('hidden'), false);
    assert.equal(q('[data-fruitback-attach-ways]').hasAttribute('hidden'), true);
    assert.equal(
      q('[data-fruitback-attach-none]').textContent,
      'This note stays in Fruitback, with no tracker: it takes no file.',
    );
    assert.equal(q('[data-fruitback-attach-none]').hasAttribute('hidden'), false);
  });

  it('shows nothing of files to a reader the worker takes none from, and no capture where the host takes none', () => {
    const none = mount({ offer: () => 'none' });
    composer?.open(ANCHOR);
    assert.equal(none.q('[data-fruitback-attach]').hasAttribute('hidden'), true);
    composer?.destroy();
    const noCapture = mount({ captures: () => false });
    composer?.open(ANCHOR);
    assert.equal(noCapture.q<HTMLButtonElement>('[data-fruitback-attach-page]').hidden, true);
    assert.equal(noCapture.q<HTMLButtonElement>('[data-fruitback-attach-area]').hidden, true);
    assert.equal(noCapture.q<HTMLButtonElement>('[data-fruitback-attach-file]').hidden, false);
  });

  it('keeps no note with files for later: « Keep for later » goes while a file is joined', async () => {
    const { q, uploads, settle } = mount({}, { keep: true });
    composer?.open(ANCHOR);
    const keep = q<HTMLButtonElement>('[data-fruitback-keep]');
    assert.equal(keep.hidden, false);
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    assert.equal(keep.hidden, true);
    uploads[0]?.answer({ ok: true, id: ID });
    await settle();
    q<HTMLButtonElement>('.fruitback-composer-file-remove').click();
    assert.equal(keep.hidden, false);
  });

  it('marks the files of a refused send, says why, and keeps the text', async () => {
    const { root, q, uploads, reply, settle } = mount();
    composer?.open(ANCHOR);
    q<HTMLTextAreaElement>('[data-fruitback-note]').value = 'kept';
    q<HTMLButtonElement>('[data-fruitback-attach-page]').click();
    await settle();
    uploads[0]?.answer({ ok: true, id: ID });
    await settle();
    q<HTMLButtonElement>('[data-fruitback-send]').click();
    await settle();
    reply('attachment-gone');
    await settle();
    assert.equal(
      q('[data-fruitback-failed-text]').textContent,
      'A file of this note is no longer on its way. Your text is kept: remove the file, then send again.',
    );
    assert.deepEqual(files(root)[0]?.[2], 'refused');
    assert.equal(q<HTMLTextAreaElement>('[data-fruitback-note]').value, 'kept');
  });

  it('says nothing when the capture was cancelled, and that it was not taken when it did not come', async () => {
    let answer: PickedFile | 'cancelled' | undefined = 'cancelled';
    const { root, q, settle } = mount({ capture: async () => answer });
    composer?.open(ANCHOR);
    q<HTMLButtonElement>('[data-fruitback-attach-area]').click();
    await settle();
    assert.deepEqual(files(root), []);
    answer = undefined;
    q<HTMLButtonElement>('[data-fruitback-attach-area]').click();
    await settle();
    assert.deepEqual(files(root), [['area.png', 'The capture was not taken', 'refused']]);
  });
});

describe('the area of a capture (FRU-332)', () => {
  const t = createTranslator({ language: 'en' });

  function open() {
    const page = mountPage('<main></main>', { width: 1_000, height: 800 });
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const chosen = pickArea({ document: page.document, host, translator: t });
    const overlay = host.querySelector('[data-fruitback-area]') as HTMLElement;
    const KeyboardEvent = keyboardEventCtor(page);
    const press = (key: string, shiftKey = false) =>
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

    return { page, host, chosen, overlay, press };
  }

  it('starts with an area in the middle, that the arrows move and Shift and the arrows size, and Enter takes', async () => {
    const { host, chosen, overlay, press } = open();
    assert.equal(overlay.getAttribute('aria-label'), 'Choose an area of the page');
    assert.equal(host.ownerDocument.activeElement, overlay, 'the keyboard is in the area at once');
    press('ArrowRight');
    press('ArrowDown');
    press('ArrowLeft', true);
    press('Enter');

    assert.deepEqual(await chosen, { left: 250 + STEP, top: 240 + STEP, width: 500 - STEP, height: 320 });
    assert.equal(host.querySelector('[data-fruitback-area]'), null, 'the overlay is gone before the capture');
  });

  it('cancels on Esc, and takes the area of its button', async () => {
    const escaped = open();
    escaped.press('Escape');
    assert.equal(await escaped.chosen, undefined);
    assert.equal(escaped.host.querySelector('[data-fruitback-area]'), null);

    const taken = open();
    (taken.host.querySelector('.fruitback-area-take') as HTMLButtonElement).click();
    assert.deepEqual(await taken.chosen, { left: 250, top: 240, width: 500, height: 320 });
  });

  it('gives the focus back to « Capture an area » in the Shadow root of the widget, after Esc and after Enter', async () => {
    for (const key of ['Escape', 'Enter']) {
      const page = mountPage('<main></main>', { width: 1_000, height: 800 });
      const container = page.document.createElement('div');
      page.document.body.append(container);
      const root = container.attachShadow({ mode: 'open' });
      const button = page.document.createElement('button');
      button.textContent = 'Capture an area';
      root.append(button);
      button.focus();
      assert.equal(deepActiveElement(page.document), button, `${key}: the control of the case`);

      const chosen = pickArea({ document: page.document, host: root, translator: t });
      const overlay = root.querySelector('[data-fruitback-area]') as HTMLElement;
      const KeyboardEvent = keyboardEventCtor(page);
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await chosen;

      assert.equal(deepActiveElement(page.document), button, `${key}: the focus is not back on its button`);
    }
  });

  it('keeps an area inside the window, and never under its smallest side', () => {
    assert.deepEqual(clamp({ left: -50, top: 900, width: 2, height: 5_000 }, 1_000, 800), {
      left: 0,
      top: 0,
      width: MIN_SIDE,
      height: 800,
    });
  });
});

describe('a file on its way, and the note that names it (FRU-332)', () => {
  it('posts the file through the transport, in base64, with its type, its site and its place', async () => {
    const seen: TransportRequest[] = [];
    const answer = await uploadAttachment(
      {
        endpoint: ENDPOINT,
        clientId: 'acme',
        identityToken: () => 'a-token',
        transport: async (request) => {
          seen.push(request);

          return { ok: true, status: 201, body: JSON.stringify({ id: ID }) };
        },
      },
      { ...FILE, name: 'a b.png' },
      'dst_two',
    );

    assert.deepEqual(answer, { ok: true, id: ID });
    assert.deepEqual(seen, [
      {
        url: `${ENDPOINT}/attachments?client=acme&name=a+b.png&destination=dst_two`,
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Authorization: 'Bearer a-token' },
        body: FILE.base64,
        encoding: 'base64',
      },
    ]);
  });

  it('answers the refusal of the worker, a transport that throws, and an answer with no id', async () => {
    const upload = (transport: () => Promise<{ ok: boolean; status: number; body: string }>) =>
      uploadAttachment({ endpoint: ENDPOINT, clientId: 'acme', transport }, FILE, undefined);
    assert.deepEqual(await upload(async () => ({ ok: false, status: 413, body: '{}' })), {
      ok: false,
      refusal: 'too-large',
    });
    assert.deepEqual(
      await upload(async () => {
        throw new Error('gone');
      }),
      { ok: false, refusal: 'retry' },
    );
    assert.deepEqual(await upload(async () => ({ ok: true, status: 201, body: '{"id":"shot_1"}' })), {
      ok: false,
      refusal: 'retry',
    });
  });

  it('reads each refusal of the worker', () => {
    const of = (status: number, error?: string) => refusalOf({ status, body: JSON.stringify({ error }) });
    assert.deepEqual(
      [of(413), of(409), of(401), of(400), of(429, 'transit-full'), of(429, 'rate-limited'), of(502)],
      ['too-large', 'no-tracker', 'signed-out', 'type', 'full', 'retry', 'retry'],
    );
    assert.equal(failureOf({ status: 410, body: '{"error":"attachment-gone"}' }), 'attachment-gone');
    assert.equal(failureOf({ status: 409, body: '{"error":"attachments-not-taken"}' }), 'no-tracker');
    assert.equal(failureOf({ status: 409, body: '{"error":"check-in-progress"}' }), 'retry');
  });

  it('names the files of the note in the query of the write, and the body stays the seed', async () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const seen: TransportRequest[] = [];
    await plant({
      note: 'with files',
      target: { element: page.query('button'), source: undefined },
      reporter: undefined,
      destination: 'dst_two',
      attachments: [ID, `att_${'b'.repeat(32)}`],
      config: { hiddenStages: [], screenshot: false },
      options: {
        endpoint: ENDPOINT,
        clientId: 'acme',
        transport: async (request) => {
          seen.push(request);

          return { ok: true, status: 201, body: '{}' };
        },
      },
    });
    const url = new URL(seen[0]?.url ?? '');
    assert.equal(url.pathname, '/feedback');
    assert.equal(url.searchParams.get('destination'), 'dst_two');
    assert.equal(url.searchParams.get('attachments'), `${ID},att_${'b'.repeat(32)}`);
    assert.equal('attachments' in (JSON.parse(seen[0]?.body ?? '{}') as object), false);
  });

  it('offers files by the place of the note, then by the site, and nothing to a reader the worker named none', () => {
    const places = offeredDestinations([
      { id: 'linear', canAttach: true },
      { id: 'kept', canAttach: false },
      { id: 'old' },
    ]);
    assert.deepEqual(places, [{ id: 'linear', canAttach: true }, { id: 'kept', canAttach: false }, { id: 'old' }]);
    const reader = (canAttach: boolean | undefined) => ({
      identified: false,
      canReply: false,
      canWrite: true,
      canAttach,
    });
    assert.equal(attachOffer(reader(true), places, 'kept'), 'no-tracker');
    assert.equal(attachOffer(reader(false), places, 'linear'), 'offered');
    assert.equal(attachOffer(reader(true), places, 'old'), 'offered');
    assert.equal(attachOffer(reader(false), places, undefined), 'no-tracker');
    assert.equal(attachOffer(reader(undefined), places, 'linear'), 'none');
  });

  it('sends the bytes of a body in base64, and a body of text as it is', async () => {
    const bodies: unknown[] = [];
    mock.method(globalThis, 'fetch', async (_url: unknown, init: { body?: unknown }) => {
      bodies.push(init.body);

      return new Response('{}', { status: 201 });
    });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await fetchTransport({
      url: ENDPOINT,
      method: 'POST',
      headers: {},
      body: base64OfBytes(bytes),
      encoding: 'base64',
    });
    await fetchTransport({ url: ENDPOINT, method: 'POST', headers: {}, body: '{"a":1}' });
    assert.deepEqual([...(bodies[0] as Uint8Array)], [...bytes]);
    assert.equal(bodies[1], '{"a":1}');
    const big = new Uint8Array(300_000).map((_, index) => index % 256);
    assert.deepEqual(bytesOfBase64(base64OfBytes(big)), big);
  });

  it('writes a size as a person reads it', () => {
    assert.equal(readableSize(512, 'en'), '0.5 kB');
    assert.equal(readableSize(4, 'en'), '0.1 kB');
    assert.equal(readableSize(48 * 1_024, 'en'), '48 kB');
    // `Intl` puts a no-break space between the number and its unit in French.
    assert.equal(readableSize(2.5 * 1_024 * 1_024, 'fr').replace(/\s/gu, ' '), '2,5 Mo');
  });
});

describe('the files of a sent note, in its thread (FRU-332)', () => {
  it('says how many, with the link of its ticket, and shows no file', () => {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const overlay = createOverlay({ document: page.document, host });
    const seed = seedFixture({
      id: 'sd_files',
      anchor: {
        selector: '[data-testid="cta"]',
        tag: 'button',
        text: 'Commander',
        bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
      },
    });
    const files = [
      { name: 'page.png', url: 'https://uploads.linear.app/a/page.png' },
      { name: 'log.txt', url: 'https://uploads.linear.app/a/log.txt' },
    ];
    overlay.render([
      seedIssueFixture({ identifier: 'DEV-3', url: 'https://linear.app/x/DEV-3', attachments: files, seed }),
    ]);
    overlay.select('sd_files');

    const line = host.querySelector('[data-fruitback-files]') as HTMLElement;
    assert.equal(line.textContent, '2 attachments · in DEV-3');
    assert.equal(line.querySelector('a')?.getAttribute('href'), 'https://linear.app/x/DEV-3');
    assert.equal(host.querySelector('.fruitback-thread img'), null, 'no file is shown');
    assert.equal(
      [...host.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('uploads.linear.app')),
      false,
      'no link to a file either',
    );
    overlay.destroy();
  });

  it('says the count alone to a reader with no link to the tracker, and nothing for a note with no file', () => {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const overlay = createOverlay({ document: page.document, host });
    const anchor = {
      selector: '[data-testid="cta"]',
      tag: 'button',
      text: 'Commander',
      bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
    };
    const { url: _url, ...guest } = seedIssueFixture({
      attachments: [{ name: 'page.png' }],
      seed: seedFixture({ id: 'sd_guest', anchor }),
    });
    overlay.render([guest, seedIssueFixture({ id: 'other', seed: seedFixture({ id: 'sd_none', anchor }) })]);
    overlay.select('sd_guest');
    assert.equal(host.querySelector('[data-fruitback-files]')?.textContent, '1 attachment');
    overlay.select('sd_none');
    assert.equal(host.querySelector('[data-fruitback-files]'), null);
    overlay.destroy();
  });
});
