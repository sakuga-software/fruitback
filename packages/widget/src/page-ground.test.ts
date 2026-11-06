import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage } from './dom.fixture.ts';
import { composeOnWhite, groundOf, markGround, parseRgb, readGround } from './page-ground.ts';

describe('the ground of the page (FRU-611, P7)', () => {
  it('reads a computed rgb() with its alpha, and nothing for another notation', () => {
    assert.deepEqual(parseRgb('rgb(17, 17, 17)'), [17, 17, 17, 1]);
    assert.deepEqual(parseRgb('rgba(221, 44, 39, 0.5)'), [221, 44, 39, 0.5]);
    assert.deepEqual(parseRgb('rgb(255 255 255 / 40%)'), [255, 255, 255, 0.4]);
    assert.equal(parseRgb('oklch(0.2 0.02 260)'), undefined);
  });

  it('lays the layers on white, the top one first, as a browser paints them (review of #859)', () => {
    assert.equal(composeOnWhite([]), '#ffffff');
    assert.equal(composeOnWhite([[0, 0, 0, 0]]), '#ffffff');
    // A body of black at 90 % on a transparent root: dark, not white.
    assert.equal(composeOnWhite([[0, 0, 0, 0.9]]), '#1a1a1a');
    assert.deepEqual(groundOf(composeOnWhite([[0, 0, 0, 0.9]])), { dark: true, faint: false });
    // A body of red at 50 % over a root of near black.
    assert.equal(
      composeOnWhite([
        [221, 44, 39, 0.5],
        [17, 24, 39, 1],
      ]),
      '#772227',
    );
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
