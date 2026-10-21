import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TEXT_CONTRAST, contrastRatio, readableTextColor } from './contrast.ts';

/** The ink of the widget's theme (`--fruitback-color-text`), passed as the widget will pass it. */
const INK = '#18181b';

const round = (ratio: number | undefined) => (ratio === undefined ? undefined : Math.round(ratio * 100) / 100);

describe('the contrast of a text on a status (FRU-365)', () => {
  it('measures what WCAG measures', () => {
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#ffffff', '#000000'), 21, 'in either order');
    assert.equal(contrastRatio('#7dd3fc', '#7dd3fc'), 1);
    // The numbers of statuses.md, measured with contrast.test.ts of the widget.
    assert.equal(round(contrastRatio('#5560c4', '#ffffff')), 5.45);
    assert.equal(round(contrastRatio('#a52a3a', '#ffaaaa')), 3.87);
    // Under and over the 0.04045 threshold of a channel: 10/255 and 11/255.
    assert.equal(round(contrastRatio('#0a0a0a', '#000000')), 1.06);
    assert.equal(round(contrastRatio('#0b0b0b', '#000000')), 1.07);
  });

  it('measures nothing when a colour is not #rrggbb', () => {
    for (const color of ['#fff', 'white', 'var(--x)', '#7dd3fcff', '']) {
      assert.equal(contrastRatio(color, '#000000'), undefined, color);
      assert.equal(contrastRatio('#000000', color), undefined, color);
    }
    assert.equal(readableTextColor('white', INK), undefined);
    assert.equal(readableTextColor('#7dd3fc', 'black'), undefined);
  });

  it('writes on the five colours of FRU-334 what the widget writes today', () => {
    // theme.ts: ink on new, to do and in progress; white on done and closed.
    assert.deepEqual(
      ['#bec2c8', '#d9dbdf', '#f3bb3d', '#5560c4', '#a52a3a'].map((stage) => readableTextColor(stage, INK)),
      [INK, INK, INK, '#ffffff', '#ffffff'],
    );
  });

  it('takes black where neither the ink nor white reaches 4.5:1', () => {
    // The worst background for ink and white, measured: 4.21:1 with either, and 4.99:1 with black.
    assert.ok(
      Math.max(contrastRatio('#547bc2', INK) ?? 0, contrastRatio('#547bc2', '#ffffff') ?? 0) < MIN_TEXT_CONTRAST,
    );
    assert.equal(readableTextColor('#547bc2', INK), '#000000');
    // White where the ink cannot be read and white just can: the worst of black and white, 4.58:1.
    assert.equal(readableTextColor('#38860a', '#38860a'), '#ffffff');
    // The ink where it beats white, both over the threshold.
    assert.equal(readableTextColor('#f3bb3d', INK), INK);
  });

  it(`never answers a text under ${MIN_TEXT_CONTRAST}:1, on any colour`, () => {
    // Every 97th colour of the cube, and the two worst ones measured: 4.21:1 and 4.58:1.
    let worst = Number.POSITIVE_INFINITY;
    let worstBlack = Number.POSITIVE_INFINITY;
    const backgrounds = ['#547bc2', '#38860a', '#5385ae'];
    for (let value = 0; value < 0x1000000; value += 97) backgrounds.push(`#${value.toString(16).padStart(6, '0')}`);
    for (const background of backgrounds) {
      const text = readableTextColor(background, INK) as string;
      const ratio = contrastRatio(background, text) as number;
      worst = Math.min(worst, ratio);
      if (text === '#000000') worstBlack = Math.min(worstBlack, ratio);
    }

    assert.ok(worst >= MIN_TEXT_CONTRAST, `the worst text found is ${worst}:1`);
    // The ink or white is taken from 4.5:1 on: #5385ae takes the ink at 4.50007:1.
    assert.equal(round(worst), 4.5);
    // Black is taken only where it is the better of black and white, so it is over 4.58:1.
    assert.ok(worstBlack >= 4.58, `the worst black found is ${worstBlack}:1`);
  });
});
