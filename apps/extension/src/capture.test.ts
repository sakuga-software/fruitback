import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CaptureSeams, createCapture, pixelsOf } from './capture.ts';
import type { SiteConfig } from './sites.ts';

/**
 * The capture of a note's picture, in the background (FRU-44): every case where it gives up, and the
 * one where it uploads. A refusal is « no picture », never an error.
 */

const PRIVATE: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', enabled: true, clientId: 'acme' };
const GRANT = { accessToken: 'access.1', expiresAt: 0, identity: { subject: 'reviewer-1' } };
const AREA = { left: 10, top: 20, width: 100, height: 40, scale: 2 };
const PNG = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });

function harness(overrides: Partial<CaptureSeams> = {}) {
  const calls: string[] = [];
  const capture = createCapture({
    readSite: async () => PRIVATE,
    ensureAccess: async () => ({ ok: true, grant: GRANT }),
    captureTab: async () => {
      calls.push('capture');

      return PNG;
    },
    crop: async (picture) => {
      calls.push('crop');

      return picture;
    },
    upload: async (url, token) => {
      calls.push(`upload ${url} ${token}`);

      return {
        status: 201,
        body: JSON.stringify({ url: 'https://worker.test/screenshot/shot_1', width: 200, height: 80 }),
      };
    },
    ...overrides,
  });

  return { capture, calls };
}

describe('the picture of a note (FRU-44)', () => {
  it('captures, crops and uploads it to the worker of the site, for its client, with the session', async () => {
    const { capture, calls } = harness();

    assert.deepEqual(await capture(AREA, 'https://acme.dev'), {
      url: 'https://worker.test/screenshot/shot_1',
      width: 200,
      height: 80,
    });
    assert.deepEqual(calls, ['capture', 'crop', 'upload https://worker.test/screenshot?client=acme access.1']);
  });

  it('takes the client of a site of a workspace that the extension mounts', async () => {
    const team: SiteConfig = {
      mode: 'team',
      endpoint: 'https://worker.test',
      enabled: true,
      mount: { clientId: 'site_1' },
    };
    const { capture, calls } = harness({ readSite: async () => team });

    assert.ok((await capture(AREA, 'https://acme.dev')) !== undefined);
    assert.match(calls.at(-1) ?? '', /client=site_1 /);
  });

  it('takes no picture at all without a session, a site, or a widget of its own', async () => {
    const cases: Partial<CaptureSeams>[] = [
      { ensureAccess: async () => ({ ok: false, reason: 'not-paired' }) },
      { readSite: async () => undefined },
      { readSite: async () => ({ ...PRIVATE, enabled: false }) },
      { readSite: async () => ({ mode: 'team', endpoint: 'https://worker.test', enabled: true }) },
      { readSite: async () => ({ ...PRIVATE, endpoint: 'http://worker.test' }) },
    ];
    for (const overrides of cases) {
      const { capture, calls } = harness(overrides);

      assert.equal(await capture(AREA, 'https://acme.dev'), undefined);
      assert.deepEqual(calls, [], JSON.stringify(overrides.readSite?.toString().slice(0, 60)));
    }
    assert.equal(await harness().capture(AREA, undefined), undefined, 'a sender the browser could not name');
  });

  it('gives up without an error when the browser refuses the capture: the note goes without it', async () => {
    const { capture, calls } = harness({
      captureTab: async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      },
    });

    assert.equal(await capture(AREA, 'https://acme.dev'), undefined);
    assert.deepEqual(calls, []);
  });

  it('keeps no answer of the worker that is not a picture on that worker', async () => {
    for (const answer of [
      { status: 413, body: '{"error":"payload-too-large"}' },
      { status: 201, body: 'not json' },
      { status: 201, body: '{"url":"https://elsewhere.test/x.png","width":1,"height":1}' },
      { status: 201, body: '{"url":"https://worker.test/screenshot/shot_1"}' },
    ]) {
      const { capture } = harness({ upload: async () => answer });

      assert.equal(await capture(AREA, 'https://acme.dev'), undefined, answer.body);
    }
  });
});

describe('the area cut out of the capture', () => {
  it('is the element, in pixels of the screen', () => {
    assert.deepEqual(pixelsOf(AREA, { width: 2880, height: 1800 }), { left: 20, top: 40, width: 200, height: 80 });
  });

  it('stops at the edge of the capture, and is nothing for an element out of view', () => {
    assert.deepEqual(pixelsOf({ left: -10, top: 0, width: 30, height: 10, scale: 1 }, { width: 100, height: 100 }), {
      left: 0,
      top: 0,
      width: 20,
      height: 10,
    });
    assert.equal(
      pixelsOf({ left: 0, top: 200, width: 30, height: 10, scale: 1 }, { width: 100, height: 100 }),
      undefined,
    );
    assert.equal(pixelsOf({ left: 0, top: 0, width: 0, height: 10, scale: 1 }, { width: 100, height: 100 }), undefined);
  });
});
