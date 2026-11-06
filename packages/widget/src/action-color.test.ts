import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRUITBACK_RED,
  actionMarkColor,
  contrastRatio,
  paintActionColor,
  parseActionColor,
  parseHexColor,
  strongerColor,
} from './action-color.ts';
import { mountPage } from './dom.fixture.ts';
import { init } from './embed.ts';
import { STYLES as COMPOSER_STYLES } from './composer.styles.ts';

/**
 * The colour of « Send » (FRU-601): what a host may give, what is refused, and what is written on the
 * host element. The extension gives the colour its person chose in « Appearance ».
 */

describe('the colour of « Send » (FRU-601)', () => {
  it('reads #rrggbb and #rgb, in any case, and nothing else', () => {
    assert.equal(parseHexColor('#B91C1C'), '#b91c1c');
    assert.equal(parseHexColor(' #c2410c '), '#c2410c');
    assert.equal(parseHexColor('#abc'), '#aabbcc');
    for (const value of ['b91c1c', '#b91c1', '#b91c1cff', 'red', 'rgb(0,0,0)', '', 12, undefined, null]) {
      assert.equal(parseHexColor(value), undefined, String(value));
    }
  });

  it('measures the contrast as WCAG 2.2 does', () => {
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#777777', '#777777'), 1);
    // The red of Fruitback, as theme.ts and the extension write it: 4.70:1 with white.
    assert.equal(contrastRatio(FRUITBACK_RED, '#ffffff').toFixed(2), '4.70');
  });

  it('takes the four colours of « Appearance », and refuses one under 4.5:1 with white', () => {
    for (const color of [FRUITBACK_RED, '#b91c1c', '#c2410c', '#1c1917']) {
      assert.equal(parseActionColor(color), color, color);
    }
    // The orange of before FRU-372 at its light step, and a yellow: white is unreadable on them.
    assert.equal(parseActionColor('#f97316'), undefined);
    assert.equal(parseActionColor('#facc15'), undefined);
    assert.equal(parseActionColor('#ffffff'), undefined);
  });

  it('darkens the colour under the pointer, so the label only gets easier to read', () => {
    assert.equal(strongerColor('#ffffff'), '#d9d9d9');
    assert.equal(strongerColor('#000000'), '#000000');
    for (const color of [FRUITBACK_RED, '#b91c1c', '#c2410c', '#1c1917']) {
      assert.ok(contrastRatio(strongerColor(color), '#ffffff') >= contrastRatio(color, '#ffffff'), color);
    }
  });

  it('keeps the drop red on a colour where the red stands out at 3:1 (Ink), and white on the reds and the orange', () => {
    assert.equal(actionMarkColor('#1c1917'), FRUITBACK_RED);
    for (const color of [FRUITBACK_RED, '#b91c1c', '#c2410c']) assert.equal(actionMarkColor(color), '#ffffff', color);
  });

  it('writes its properties on the host element, and removes them for no colour or a colour refused', () => {
    const { document } = mountPage('<main></main>');
    const element = document.createElement('div');
    const read = () =>
      ['action', 'action-strong', 'on-action', 'action-mark'].map((name) =>
        element.style.getPropertyValue(`--fruitback-color-${name}`),
      );

    paintActionColor(element, '#1C1917');
    assert.deepEqual(read(), ['#1c1917', strongerColor('#1c1917'), '#ffffff', FRUITBACK_RED]);
    paintActionColor(element, '#facc15');
    assert.deepEqual(read(), ['', '', '', '']);
    paintActionColor(element, '#c2410c');
    paintActionColor(element, undefined);
    assert.deepEqual(read(), ['', '', '', '']);
  });

  it('is read by « Send » only, with the accent when it is not set', () => {
    const send = COMPOSER_STYLES.slice(COMPOSER_STYLES.indexOf('.fruitback-composer-send {'));
    assert.match(send, /background: var\(--fruitback-color-action, var\(--fruitback-color-accent\)\)/);
    assert.match(send, /color: var\(--fruitback-color-on-action, var\(--fruitback-color-on-accent\)\)/);
    assert.match(send, /var\(--fruitback-color-action-strong, var\(--fruitback-color-accent-strong\)\)/);
    // Nothing else of the widget reads the colour: the pins and the launch button keep the accent.
    const others = COMPOSER_STYLES.replaceAll(/\.fruitback-composer-send[^{]*\{[^}]*\}/g, '');
    assert.doesNotMatch(others, /--fruitback-color-action/);
  });

  it('is given at init, changed with setActionColor with no new widget, and taken back with undefined', () => {
    const page = mountPage('<main><button id="cta">Commander</button></main>');
    const widget = init({
      document: page.document,
      endpoint: 'https://worker.test',
      clientId: 'acme',
      actionColor: '#b91c1c',
    });
    const container = page.document.querySelector('[data-fruitback-host]') as HTMLElement;
    const color = () => container.style.getPropertyValue('--fruitback-color-action');
    assert.equal(color(), '#b91c1c');

    widget.setActionColor('#C2410C');
    assert.equal(color(), '#c2410c');
    assert.equal(page.document.querySelectorAll('[data-fruitback-host]').length, 1, 'a second widget was built');
    widget.setActionColor('#facc15');
    assert.equal(color(), '');
    widget.setActionColor('#1c1917');
    widget.setActionColor(undefined);
    assert.equal(color(), '');

    widget.destroy();
  });
});
