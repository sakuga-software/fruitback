import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * A reply from the page, as `init` wires it (FRU-257): the read says whether this reader may reply,
 * the host can say never, and the reply goes through the transport of the host.
 */

const ENDPOINT = 'https://worker.test';
const ISSUE = seedIssueFixture({
  id: 'issue_42',
  comments: [],
  seed: seedFixture({
    anchor: {
      selector: '[data-testid="cta"]',
      tag: 'button',
      text: 'Commander',
      bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
    },
  }),
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

/** A worker whose read says `read`, and that keeps every reply. */
function worker(read: Record<string, unknown>) {
  const requests: TransportRequest[] = [];
  const transport = async (request: TransportRequest): Promise<TransportResponse> => {
    requests.push(request);
    if (request.method === 'GET') {
      return { ok: true, status: 200, body: JSON.stringify({ issues: [ISSUE], ...read }) };
    }

    return {
      ok: true,
      status: 201,
      body: JSON.stringify({ comment: { id: 'c1', body: 'kept', createdAt: '2026-10-19T08:00:00.000Z' } }),
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

describe('a reply from the page, through init (FRU-257)', () => {
  it('offers the field when the read says the reader may reply, and not when it does not, or when the host says never', async () => {
    const cases = [
      [{ canReply: true }, {}, true],
      [{}, {}, false],
      [{ canReply: 'yes' }, {}, false],
      [{ canReply: true }, { replies: false }, false],
    ] as const;
    for (const [read, options, offered] of cases) {
      const root = await threadOf(mounted(), { transport: worker(read).transport, ...options });

      assert.equal(
        root.querySelector('.fruitback-thread-reply-field') !== null,
        offered,
        JSON.stringify([read, options]),
      );
      for (const undo of cleanup.splice(0)) undo();
    }
  });

  it('posts the reply to the note, through the transport, with the page and no name it was not given', async () => {
    const page = mounted();
    const { requests, transport } = worker({ canReply: true });
    const root = await threadOf(page, { transport });
    const field = root.querySelector('.fruitback-thread-reply-field') as HTMLTextAreaElement;
    field.value = 'Same here.';
    (root.querySelector('.fruitback-thread-reply-form') as HTMLFormElement).requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = requests.find((request) => request.method === 'POST') as TransportRequest;
    assert.equal(posted.url, `${ENDPOINT}/feedback/issue_42/replies?client=acme`);
    assert.deepEqual(JSON.parse(posted.body ?? '{}'), { url: 'https://preview.acme.test/pricing', body: 'Same here.' });
    assert.equal(field.value, '');
  });

  it('signs a reply with the name the reporter kept, for a reader the worker does not name only', async () => {
    const stored = new Map([['fruitback:config', JSON.stringify({ hiddenStages: [], reporterName: 'Bob' })]]);
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    cleanup.push(() =>
      before === undefined
        ? Reflect.deleteProperty(globalThis, 'localStorage')
        : Object.defineProperty(globalThis, 'localStorage', before),
    );

    const names: unknown[] = [];
    for (const identified of [false, true]) {
      const { requests, transport } = worker({ canReply: true, identified });
      const root = await threadOf(mounted(), { transport });
      (root.querySelector('.fruitback-thread-reply-field') as HTMLTextAreaElement).value = 'Hi';
      (root.querySelector('.fruitback-thread-reply-form') as HTMLFormElement).requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const posted = requests.find((request) => request.method === 'POST') as TransportRequest;
      names.push(JSON.parse(posted.body ?? '{}').name);
    }

    assert.deepEqual(names, ['Bob', undefined]);
  });
});
