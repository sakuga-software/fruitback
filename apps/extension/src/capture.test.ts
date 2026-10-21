import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CaptureSeams, base64Of, bytesOf, createCapture, pixelsOf } from './capture.ts';
import type { SiteConfig } from './sites.ts';

/**
 * A capture of the page or of an area, in the background (FRU-44, FRU-332): every case where it gives
 * up, and the one where it answers a PNG. It sends nothing: the widget joins it to the note, and it
 * goes through the relay like any file. A refusal is « no capture », never an error.
 */

const TEAM: SiteConfig = {
  mode: 'team',
  endpoint: 'https://worker.test',
  enabled: true,
  mount: { clientId: 'acme' },
};
const GRANT = { accessToken: 'access.1', expiresAt: 0, identity: { subject: 'reviewer-1' } };
const AREA = { left: 10, top: 20, width: 100, height: 40, scale: 2 };
const TAB = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
const CUT = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9])], { type: 'image/png' });

function harness(overrides: Partial<CaptureSeams> = {}) {
  const calls: string[] = [];
  const capture = createCapture({
    readSite: async () => TEAM,
    ensureAccess: async () => {
      calls.push('access');

      return { ok: true, grant: GRANT };
    },
    captureTab: async () => {
      calls.push('capture');

      return TAB;
    },
    crop: async () => {
      calls.push('crop');

      return CUT;
    },
    ...overrides,
  });

  return { capture, calls };
}

describe('a capture of the page or of an area (FRU-332)', () => {
  it('answers the whole visible page as a PNG in base64, and sends it nowhere', async () => {
    const { capture, calls } = harness();

    assert.deepEqual(await capture(undefined, 'https://acme.dev'), {
      name: 'page.png',
      type: 'image/png',
      size: 7,
      base64: base64Of(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    });
    assert.deepEqual(calls, ['access', 'capture']);
  });

  it('cuts the area that the person chose', async () => {
    const { capture, calls } = harness();

    const taken = await capture(AREA, 'https://acme.dev');
    assert.equal(taken?.name, 'area.png');
    assert.deepEqual([...bytesOf(taken?.base64 ?? '')], [0x89, 0x50, 0x4e, 0x47, 9]);
    assert.deepEqual(calls, ['access', 'capture', 'crop']);
  });

  it('takes no capture at all without a session, a site of a workspace, or a secure worker', async () => {
    const cases: [string, Partial<CaptureSeams>, string | undefined][] = [
      ['no origin', {}, undefined],
      ['no site', { readSite: async () => undefined }, 'https://acme.dev'],
      ['a site switched off', { readSite: async () => ({ ...TEAM, enabled: false }) }, 'https://acme.dev'],
      [
        'a site in private mode',
        {
          readSite: async () => ({ mode: 'private', endpoint: 'https://worker.test', enabled: true, clientId: 'acme' }),
        },
        'https://acme.dev',
      ],
      ['an http worker', { readSite: async () => ({ ...TEAM, endpoint: 'http://worker.test' }) }, 'https://acme.dev'],
      ['no session', { ensureAccess: async () => ({ ok: false, reason: 'not-paired' }) }, 'https://acme.dev'],
    ];
    for (const [what, overrides, origin] of cases) {
      const { capture, calls } = harness(overrides);
      assert.equal(await capture(undefined, origin), undefined, what);
      assert.equal(calls.includes('capture'), false, `${what}: the tab was captured`);
    }
    // The control: the same call on the site of a workspace, with a session, takes it.
    assert.notEqual(await harness().capture(undefined, 'https://acme.dev'), undefined);
  });

  it('gives up without an error when the browser refuses the capture, or the area is off the screen', async () => {
    const refused = harness({
      captureTab: async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      },
    });
    assert.equal(await refused.capture(undefined, 'https://acme.dev'), undefined);
    const off = harness({
      crop: async () => {
        throw new Error('the area is not on the screen');
      },
    });
    assert.equal(await off.capture(AREA, 'https://acme.dev'), undefined);
  });

  it('turns bytes into base64 and back, past the size where a spread would overflow', () => {
    const big = new Uint8Array(200_000).map((_, index) => index % 251);
    assert.deepEqual(bytesOf(base64Of(big)), big);
    assert.equal(base64Of(new Uint8Array([0xff, 0x00, 0x7f])), '/wB/');
  });
});

describe('the area cut out of the capture', () => {
  it('is the area, in pixels of the screen', () => {
    assert.deepEqual(pixelsOf(AREA, { width: 2880, height: 1800 }), { left: 20, top: 40, width: 200, height: 80 });
  });

  it('stops at the edge of the capture, and is nothing for an area out of view', () => {
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
