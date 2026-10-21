import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { MAX_ATTACHMENT_BYTES } from '@fruitback/shared';
import { type AttachSeam, type Composer, createComposer } from '@fruitback/widget';
import { captureAnswerOf, createCapture } from './capture.ts';
import { captureResponseOf, pictureOfAnswer } from './capture-answer.ts';
import { MAX_FILE_BASE64 } from './protocol.ts';
import type { SiteConfig } from './sites.ts';

/**
 * A capture too large for the worker, from the background to the composer (FRU-332, balanced review
 * of #433): each hop runs the code of the file that runs it in the browser. The background takes the
 * tab with no JPEG to fall back on (`createCapture`, `captureAnswerOf`), the answer crosses
 * `runtime.sendMessage` and `postMessage` as JSON, the bridge reads it (`captureResponseOf`), the page
 * world hands the composer its file (`pictureOfAnswer`), and the composer says « Too large ». Before
 * this path, the bridge dropped a body that large and the composer said the capture was not taken.
 */

const TEAM: SiteConfig = { mode: 'team', endpoint: 'https://worker.test', enabled: true, mount: { clientId: 'acme' } };
const GRANT = { accessToken: 'access.1', expiresAt: 0, identity: { subject: 'reviewer-1' } };
const ANCHOR = { left: 100, top: 200, bottom: 240, right: 300 };

let composer: Composer | undefined;
afterEach(() => {
  composer?.destroy();
  composer = undefined;
});

/** What crosses `runtime.sendMessage` and `window.postMessage`: what JSON keeps. */
const across = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe('a capture too large for the worker, from the background to the composer (FRU-332)', () => {
  it('is said « Too large » under its name, and sends nothing', async () => {
    // Three bytes over the limit of an image: its base64 is one group over what the bridge carries.
    const tab = new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES.image + 3)], { type: 'image/png' });
    assert.ok(Math.ceil(tab.size / 3) * 4 > MAX_FILE_BASE64, 'the capture fits the bridge: no case');
    const background = createCapture({
      readSite: async () => TEAM,
      ensureAccess: async () => ({ ok: true, grant: GRANT }),
      captureTab: async () => tab,
      crop: async () => tab,
    });

    const seam: AttachSeam = {
      offer: () => 'offered',
      subscribe: () => () => undefined,
      captures: () => true,
      async capture() {
        const answer = captureAnswerOf(await background(undefined, 'https://acme.dev'));
        const posted = captureResponseOf(across(answer), 'req1');

        return pictureOfAnswer(across(posted) as typeof posted);
      },
      upload: async () => {
        uploads += 1;

        return { ok: true, id: 'att_1' };
      },
    };
    let uploads = 0;
    const window = new HappyDomWindow({ url: 'https://acme.dev/', width: 1_000, height: 1_000 });
    const document = window.document as unknown as Document;
    const host = document.createElement('div');
    document.body.append(host);
    composer = createComposer({ document, host, onSubmit: async () => true, attachments: seam });
    composer.open(ANCHOR);

    (composer.element.querySelector('[data-fruitback-attach-page]') as HTMLButtonElement).click();
    const file = async () => {
      for (let tries = 0; tries < 50; tries += 1) {
        const found = composer?.element.querySelector('.fruitback-composer-file');
        if (found !== null && found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      return undefined;
    };
    const shown = await file();

    assert.equal(shown?.getAttribute('data-fruitback-file'), 'refused');
    assert.equal(shown?.querySelector('.fruitback-composer-file-name')?.textContent, 'page.png');
    assert.match(shown?.textContent ?? '', /Too large/);
    assert.doesNotMatch(shown?.textContent ?? '', /not taken/);
    assert.equal(uploads, 0, 'a file too large went to the worker');
  });
});
