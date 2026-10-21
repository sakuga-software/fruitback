import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { init } from './embed.ts';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { canonicalizePageUrl } from '@fruitback/shared';
import { createTypingStore } from './typing.ts';

/**
 * A site whose notes are « Members only » (FRU-330), for a reader with no session: the read says
 * `canWrite: false`, in its refusal or in its answer, and the widget offers no note. Only `false`
 * closes: a refusal that says nothing, and a worker of before, keep the launch button.
 */

const ENDPOINT = 'https://worker.test';

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

/** A worker whose read answers `status` and `body`, which the test can change between two reads. */
function worker(first: { status: number; body: Record<string, unknown> | string }) {
  const answer = { ...first };
  const requests: TransportRequest[] = [];
  const transport = async (request: TransportRequest): Promise<TransportResponse> => {
    requests.push(request);
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);

    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, body };
  };

  return { answer, requests, transport };
}

async function widgetOn(page: MountedPage, options: Partial<Parameters<typeof init>[0]>) {
  const widget = init({ document: page.document, endpoint: ENDPOINT, clientId: 'acme', ...options });
  cleanup.push(() => widget.destroy());
  await widget.refresh();
  const root = page.document.querySelector('[data-fruitback-host]')?.shadowRoot as ShadowRoot;

  return { widget, root, launch: root.querySelector('.fruitback-launch') as HTMLButtonElement };
}

/** What the choice of an element does after it, a moment later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const REFUSED = { error: 'identity-required', reason: 'identity-required' };

describe('a site whose notes are « Members only », for a reader with no session (FRU-330)', () => {
  it('offers no note when the refusal of the read says canWrite: false, and says why on a press', async () => {
    const { transport } = worker({ status: 401, body: { ...REFUSED, canWrite: false } });
    const { widget, root, launch } = await widgetOn(mounted(), { transport });

    assert.equal(launch.textContent, 'Notes from members only');
    assert.equal(launch.getAttribute('aria-disabled'), 'true');
    assert.equal(launch.title, 'Only members of this site leave notes here. Ask its team to invite you.');
    launch.click();
    assert.equal(
      root.querySelector('[data-fruitback-announcer]')?.textContent,
      'Only members of this site leave notes here. Ask its team to invite you.',
    );
    // No capture starts: by the button, by the API of the extension, or by the list.
    assert.equal(root.querySelector('[data-fruitback-capturing]'), null);
    assert.equal(widget.leaveFeedback(), false);
    assert.equal(root.querySelector('[data-fruitback-capturing]'), null);
    widget.showEveryNote();
    assert.equal((root.querySelector('[data-fruitback-leave]') as HTMLElement).hidden, true);
  });

  it('keeps the launch button on a refusal that says nothing of the notes, and on a body that is not JSON', async () => {
    for (const body of [REFUSED, { ...REFUSED, canWrite: 'no' }, 'not json']) {
      const { transport } = worker({ status: 401, body });
      const { widget, launch } = await widgetOn(mounted(), { transport });

      assert.equal(launch.textContent, 'Leave feedback', JSON.stringify(body));
      assert.equal(launch.hasAttribute('aria-disabled'), false, JSON.stringify(body));
      assert.equal(widget.leaveFeedback(), true, JSON.stringify(body));
      widget.destroy();
    }
  });

  it('follows each read: an answer with canWrite: false closes, an answer without it opens again', async () => {
    const { answer, transport } = worker({ status: 200, body: { issues: [], canWrite: false } });
    const { widget, launch } = await widgetOn(mounted(), { transport });
    assert.equal(launch.getAttribute('aria-disabled'), 'true');

    answer.body = { issues: [] };
    await widget.refresh();

    assert.equal(launch.textContent, 'Leave feedback');
    assert.equal(launch.hasAttribute('aria-disabled'), false);
    assert.equal(launch.hasAttribute('title'), false);
    assert.equal(widget.leaveFeedback(), true);
  });

  it('changes nothing when a read fails for another reason: the worker said nothing of who writes', async () => {
    const { answer, transport } = worker({ status: 401, body: { ...REFUSED, canWrite: false } });
    const { widget, launch } = await widgetOn(mounted(), { transport });
    assert.equal(launch.getAttribute('aria-disabled'), 'true');

    answer.status = 503;
    answer.body = { error: 'store-unavailable' };
    await widget.refresh();

    assert.equal(launch.getAttribute('aria-disabled'), 'true');
  });

  it('leaves a host that signs in to its own offer: the extension asks for a session instead', async () => {
    const { transport } = worker({ status: 401, body: { ...REFUSED, canWrite: false } });
    const { launch } = await widgetOn(mounted(), { transport, onSignIn: () => {} });

    assert.equal(launch.hasAttribute('aria-disabled'), false);
  });

  /**
   * Raised in review. Choosing the element of the text is what reopens its composer (FRU-311): with
   * the guard out, the widget chooses it here, and this test fails (seen red). The text coming back
   * once the site opens is the restore of FRU-311, which the e2e of the typing holds.
   */
  it('opens no composer on a text written before, and keeps the text in its store', async () => {
    const page = mounted();
    const typing = createTypingStore({ storage: page.view.sessionStorage, key: 'fruitback:config:typing' });
    const place = {
      page: canonicalizePageUrl(page.view.location.href),
      anchor: {
        selector: '[data-testid="cta"]',
        tag: 'button',
        text: 'Commander',
        bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
      },
    };
    typing.write(place, 'Le prix est coupé sur un téléphone.');
    const { transport } = worker({ status: 401, body: { ...REFUSED, canWrite: false } });
    const { root } = await widgetOn(page, { transport });
    await settle();

    const field = root.querySelector('textarea');
    assert.equal(field === null || field.closest('[hidden]') !== null, true, 'a composer opened');
    assert.equal(typing.latest(place.page)?.text, 'Le prix est coupé sur un téléphone.');
  });
});
