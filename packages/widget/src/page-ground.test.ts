import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage } from './dom.fixture.ts';
import { groundOf, markGround, opaqueHex, readGround } from './page-ground.ts';

describe('the ground of the page (FRU-611, P7)', () => {
  it('reads an opaque computed colour, and nothing for a transparent one', () => {
    assert.equal(opaqueHex('rgb(17, 17, 17)'), '#111111');
    assert.equal(opaqueHex('rgba(221, 44, 39, 1)'), '#dd2c27');
    assert.equal(opaqueHex('rgb(255 255 255 / 100%)'), '#ffffff');
    assert.equal(opaqueHex('rgba(0, 0, 0, 0)'), undefined);
    assert.equal(opaqueHex('rgba(0, 0, 0, 0.5)'), undefined);
    assert.equal(opaqueHex('transparent'), undefined);
  });

  it('is dark under a mid grey, and faint where the red of Fruitback is under 3:1', () => {
    assert.deepEqual(groundOf('#ffffff'), { dark: false, faint: false });
    assert.deepEqual(groundOf('#111827'), { dark: true, faint: false });
    // The red of Fruitback, and a red of the same family: the red vanishes there.
    assert.deepEqual(groundOf('#dd2c27'), { dark: true, faint: true });
    assert.deepEqual(groundOf('#f87171'), { dark: false, faint: true });
    assert.deepEqual(groundOf('#fafaf9'), { dark: false, faint: false });
  });

  it('reads the body first, then the root, and takes white when both are transparent', () => {
    const page = mountPage('<main></main>');
    assert.deepEqual(readGround(page.document), { dark: false, faint: false });
    page.document.documentElement.style.backgroundColor = 'rgb(17, 24, 39)';
    assert.deepEqual(readGround(page.document), { dark: true, faint: false });
    page.document.body.style.backgroundColor = 'rgb(221, 44, 39)';
    assert.deepEqual(readGround(page.document), { dark: true, faint: true });
  });

  it('writes the ground on the host element, and takes it off again', () => {
    const page = mountPage('<main><div id="host"></div></main>');
    const host = page.query('#host') as HTMLElement;
    markGround(host, { dark: true, faint: true });
    assert.equal(host.dataset.fruitbackGround, 'dark');
    assert.equal(host.dataset.fruitbackFaint, '');
    markGround(host, { dark: false, faint: false });
    assert.equal(host.dataset.fruitbackGround, undefined);
    assert.equal(host.dataset.fruitbackFaint, undefined);
  });
});
