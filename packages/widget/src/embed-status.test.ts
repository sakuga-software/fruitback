import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The status of a note, changed from the head of its thread (FRU-718), through `init` and the transport
 * of a host, as the extension carries the calls of a member. The read says `canSetStatus`; the chip of
 * the status is then a button with a chevron and the menu of the five stages. Without it, the chip stays
 * read only, as FRU-696 drew it.
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

/**
 * A host that carries the calls: each read answers `read`, and a status answers `status`. `sent` keeps
 * every call, as « METHOD path ».
 */
function hostOf(read: Record<string, unknown>, status: TransportResponse) {
  const sent: TransportRequest[] = [];
  const calls: string[] = [];
  const transport = async (request: TransportRequest): Promise<TransportResponse> => {
    sent.push(request);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.url.includes('/status')) return status;

    return { ok: true, status: 200, body: JSON.stringify({ identified: true, ...read }) };
  };

  return { transport, sent, calls };
}

async function threadOf(page: MountedPage, transport: (request: TransportRequest) => Promise<TransportResponse>) {
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'site_acme', transport });
  cleanup.push(() => widget.destroy());
  await widget.refresh();
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;
  (root.querySelector('.fruitback-pin-badge') as HTMLElement).click();

  return root;
}

const settle = async () => {
  for (let each = 0; each < 3; each += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const MOVED = { ok: true, status: 200, body: JSON.stringify({ status: 'own:progress', stage: 'progress' }) };

describe('the status of a note, from the head of its thread (FRU-718)', () => {
  it('offers the five stages to a reader the read lets change it, sends the one chosen, and the pin follows', async () => {
    const page = mounted();
    const host = hostOf({ issues: [aNote({ mine: true, canSetStatus: true })] }, MOVED);
    const root = await threadOf(page, host.transport);

    const trigger = root.querySelector<HTMLButtonElement>('button.fruitback-thread-stage');
    assert.ok(trigger, 'the chip of the status is a button');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-label'), 'Status: New. Change the status');
    assert.ok(trigger.querySelector('.fruitback-thread-status-chevron'), 'the chevron of the mock-up');
    trigger.click();
    const items = [...root.querySelectorAll<HTMLButtonElement>('.fruitback-thread-status-item')];
    assert.deepEqual(
      items.map((item) => item.textContent),
      ['New', 'To do', 'In progress', 'Done', 'Closed'],
    );
    assert.deepEqual(
      items.map((item) => item.getAttribute('aria-checked')),
      ['true', 'false', 'false', 'false', 'false'],
    );
    assert.equal(root.activeElement, items[0], 'the menu opens on the stage of the note');

    const before = host.calls.length;
    items[2]?.click();
    await settle();

    assert.deepEqual(host.calls.slice(before), ['POST /feedback/issue_7/status'], 'no read after it');
    const call = host.sent.at(-1) as TransportRequest;
    assert.equal(new URL(call.url).searchParams.get('client'), 'site_acme');
    assert.deepEqual(JSON.parse(call.body as string), {
      url: 'https://preview.acme.test/pricing',
      status: 'own:progress',
    });
    assert.equal(root.querySelector('.fruitback-thread-state')?.textContent, 'In progress');
    assert.equal(root.querySelector('.fruitback-thread-status-said')?.textContent, 'Status changed: In progress.');
    assert.equal(root.querySelector('.fruitback-pin')?.getAttribute('data-fruitback-stage'), 'progress');
    assert.ok(root.querySelector('.fruitback-thread'), 'the thread stays open');
  });

  it('keeps the status read only where the read does not say canSetStatus, even on a note of the reader', async () => {
    const page = mounted();
    const host = hostOf({ issues: [aNote({ mine: true })] }, MOVED);
    const root = await threadOf(page, host.transport);

    assert.equal(root.querySelector('button.fruitback-thread-stage'), null);
    assert.equal(root.querySelector('span.fruitback-thread-stage .fruitback-thread-state')?.textContent, 'New');
    assert.equal(root.querySelector('.fruitback-thread-status-menu'), null);
    assert.equal(root.querySelector('.fruitback-thread-status-chevron'), null);
  });

  it('says why a status was refused, and keeps the stage of the note', async () => {
    const page = mounted();
    const refused = { ok: false, status: 403, body: JSON.stringify({ error: 'not-allowed' }) };
    const host = hostOf({ issues: [aNote({ canSetStatus: true })] }, refused);
    const root = await threadOf(page, host.transport);

    root.querySelector<HTMLButtonElement>('button.fruitback-thread-stage')?.click();
    root.querySelectorAll<HTMLButtonElement>('.fruitback-thread-status-item')[3]?.click();
    await settle();

    assert.equal(
      root.querySelector('.fruitback-thread-status-said')?.textContent,
      'You can no longer change the status of this note here. Reload the page.',
    );
    assert.equal(root.querySelector('.fruitback-thread-state')?.textContent, 'New');
    assert.equal(root.querySelector('.fruitback-pin')?.getAttribute('data-fruitback-stage'), 'new');
  });

  it('says a status that waits for a minute, and one whose session ended, in words of a status', async () => {
    for (const [status, words] of [
      [429, 'The status was not saved: too many requests just now. Try again in a minute.'],
      [401, 'The status was not saved: your session has ended. Sign in again, then try again.'],
    ] as const) {
      const page = mounted();
      const host = hostOf({ issues: [aNote({ canSetStatus: true })] }, { ok: false, status, body: '{}' });
      const root = await threadOf(page, host.transport);

      root.querySelector<HTMLButtonElement>('button.fruitback-thread-stage')?.click();
      root.querySelectorAll<HTMLButtonElement>('.fruitback-thread-status-item')[1]?.click();
      await settle();

      assert.equal(root.querySelector('.fruitback-thread-status-said')?.textContent, words);
    }
  });

  it('sends nothing for the stage the note is in, and Escape closes the menu, not the thread', async () => {
    const page = mounted();
    const host = hostOf({ issues: [aNote({ canSetStatus: true })] }, MOVED);
    const root = await threadOf(page, host.transport);
    const trigger = root.querySelector<HTMLButtonElement>('button.fruitback-thread-stage') as HTMLButtonElement;
    const before = host.calls.length;

    trigger.click();
    root.querySelector<HTMLButtonElement>('.fruitback-thread-status-item')?.click();
    await settle();
    assert.deepEqual(host.calls.slice(before), []);

    trigger.click();
    const menu = root.querySelector<HTMLElement>('.fruitback-thread-status-menu') as HTMLElement;
    assert.equal(menu.hidden, false);
    const KeyboardEventCtor = (page.view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    menu.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menu.hidden, true);
    assert.equal(root.activeElement, trigger);
    assert.ok(root.querySelector('.fruitback-thread'), 'the thread stays open');
  });

  it('names a stage by the name the team gave its built-in status', async () => {
    const page = mounted();
    const statuses = [{ key: 'own:progress', name: 'Doing', stage: 'progress' }];
    const host = hostOf({ issues: [aNote({ canSetStatus: true })], statuses }, MOVED);
    const root = await threadOf(page, host.transport);

    root.querySelector<HTMLButtonElement>('button.fruitback-thread-stage')?.click();

    assert.equal(root.querySelectorAll('.fruitback-thread-status-item')[2]?.textContent, 'Doing');
  });
});
