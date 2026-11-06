import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import * as here from './action-color.ts';
import * as widget from '../../../packages/widget/src/action-color.ts';

/**
 * The colour of the note button (FRU-601), as the extension reads it. The bridge and the pages do
 * not import the widget, so the rules are written twice: this holds the two equal on the colours that
 * matter, and on a sample of every other kind.
 */

const SAMPLES = [
  ...here.PRESETS.map((preset) => preset.color),
  '#1d4ed8',
  '#15803d',
  '#facc15',
  '#ffffff',
  '#000000',
  '#abc',
  '#ABCDEF',
  ' #123456 ',
  'red',
  '#12345',
  '',
  undefined,
  42,
];

describe('the colour of the note button (FRU-601)', () => {
  it('has the four colours of the board, the red of Fruitback first, each at 4.5:1 or more with white', () => {
    assert.deepEqual(
      here.PRESETS.map((preset) => [preset.id, preset.color]),
      [
        ['fruitback', '#dd2c27'],
        ['deep-red', '#b91c1c'],
        ['orange', '#c2410c'],
        ['ink', '#1c1917'],
      ],
    );
    assert.equal(here.FRUITBACK_RED, widget.FRUITBACK_RED);
    for (const preset of here.PRESETS) {
      assert.ok(here.contrastWithWhite(preset.color) >= here.MINIMUM_CONTRAST, preset.id);
    }
  });

  it('follows the rules of the widget: the same colours taken, refused, darkened and marked', () => {
    assert.equal(here.MINIMUM_CONTRAST, widget.ACTION_COLOR_MINIMUM_CONTRAST);
    for (const sample of SAMPLES) {
      assert.equal(here.parseHexColor(sample), widget.parseHexColor(sample), String(sample));
      assert.equal(here.parseActionColor(sample), widget.parseActionColor(sample), String(sample));
      const color = here.parseHexColor(sample);
      if (color === undefined) continue;
      assert.equal(here.contrastRatio(color, '#ffffff'), widget.contrastRatio(color, '#ffffff'), color);
      assert.equal(here.strongerColor(color), widget.strongerColor(color), color);
      assert.equal(here.actionMarkColor(color), widget.actionMarkColor(color), color);
    }
  });

  it('keeps the drop red on Ink only, of the four', () => {
    assert.deepEqual(
      here.PRESETS.map((preset) => [preset.id, here.actionMarkColor(preset.color)]),
      [
        ['fruitback', '#ffffff'],
        ['deep-red', '#ffffff'],
        ['orange', '#ffffff'],
        ['ink', '#dd2c27'],
      ],
    );
  });

  it('writes the properties of the button on an element, and takes them away for no colour or one refused', () => {
    const element = new HappyDomWindow().document.createElement('div') as unknown as HTMLElement;
    const read = () =>
      ['--action', '--action-strong', '--on-action', '--action-mark'].map((name) =>
        element.style.getPropertyValue(name),
      );
    here.paintAction(element, '#1c1917');
    assert.deepEqual(read(), ['#1c1917', here.strongerColor('#1c1917'), '#fff', '#dd2c27']);
    here.paintAction(element, '#facc15');
    assert.deepEqual(read(), ['', '', '', '']);
    here.paintAction(element, '#c2410c');
    here.paintAction(element, undefined);
    assert.deepEqual(read(), ['', '', '', '']);
  });
});
