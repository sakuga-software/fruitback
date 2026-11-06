import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { COLOR_NOT_SAVED, appearanceSection, formatRatio, judgeColor } from './appearance-page.ts';

/**
 * « Appearance » (FRU-601), read on happy-dom: the four colours, a colour of your own and its
 * contrast, the preview, « Reset to Fruitback red », and a write that fails. The browser, the popup,
 * the composer and axe are `e2e/extension-appearance.spec.ts`'s.
 */

afterEach(() => setLanguage('en'));

function page() {
  const window = new HappyDomWindow({ url: 'chrome-extension://fruitback/options.html' });

  return { window, document: window.document as unknown as Document };
}

function drawn(color: string | undefined, onColor: (color: string | undefined) => Promise<void> | void = () => {}) {
  const { window, document } = page();
  const section = appearanceSection(document, { color, onColor });
  document.body.append(section);
  const radio = (name: string) =>
    [...section.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (each) => each.closest('label')?.textContent === name,
    ) as HTMLInputElement;
  const checked = () =>
    [...section.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .filter((each) => each.checked)
      .map((each) => each.closest('label')?.textContent);
  const field = section.querySelector<HTMLInputElement>('#appearance-own-color') as HTMLInputElement;
  const said = () => section.querySelector('#appearance-said')?.textContent ?? '';
  const preview = section.querySelector<HTMLElement>('.appearance-preview') as HTMLElement;
  const reset = [...section.querySelectorAll('button')].find(
    (each) => each.textContent === 'Reset to Fruitback red' || each.textContent === 'Revenir au rouge Fruitback',
  ) as HTMLButtonElement;
  const pick = (input: HTMLInputElement) => {
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  };
  const type = (text: string, leave = false) => {
    field.value = text;
    field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    if (leave) field.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  };

  return { section, radio, checked, field, said, preview, reset, pick, type };
}

describe('« Appearance » (FRU-601)', () => {
  it('is a page with its title, the four colours, a field, a preview and the reset', () => {
    const { section, checked, preview, reset } = drawn(undefined);
    assert.equal(section.id, 'page-appearance');
    assert.equal(section.querySelector('h1')?.textContent, 'Appearance');
    assert.equal(section.getAttribute('aria-labelledby'), section.querySelector('h1')?.id);
    assert.equal(section.querySelector('legend')?.textContent, 'Colour of the note button');
    assert.deepEqual(
      [...section.querySelectorAll('.appearance-swatch')].map((each) => each.textContent),
      ['Fruitback', 'Deep red', 'Orange', 'Ink'],
    );
    // Nothing stored is the red of Fruitback, and there is nothing to reset.
    assert.deepEqual(checked(), ['Fruitback']);
    assert.equal(reset.disabled, true);
    assert.deepEqual(
      [...preview.querySelectorAll('span')].map((each) => each.textContent),
      ['Leave a note', 'Send'],
    );
    assert.equal(preview.getAttribute('aria-label'), 'Preview');
    assert.equal(preview.style.getPropertyValue('--action'), '');
  });

  it('stores a colour chosen, the red of Fruitback as no key, and paints the preview', () => {
    const stored: (string | undefined)[] = [];
    const { radio, checked, preview, reset, pick } = drawn(undefined, (color) => void stored.push(color));
    pick(radio('Orange'));
    assert.deepEqual(stored, ['#c2410c']);
    assert.deepEqual(checked(), ['Orange']);
    assert.equal(preview.style.getPropertyValue('--action'), '#c2410c');
    assert.equal(preview.style.getPropertyValue('--action-mark'), '#ffffff');
    assert.equal(reset.disabled, false);

    pick(radio('Ink'));
    // With Ink, the drop stays red.
    assert.equal(preview.style.getPropertyValue('--action-mark'), '#dd2c27');

    pick(radio('Fruitback'));
    assert.deepEqual(stored, ['#c2410c', '#1c1917', undefined]);
    assert.equal(preview.style.getPropertyValue('--action'), '');
  });

  it('says the contrast of a colour of your own as it is typed, and keeps it only at 4.5:1 or more', () => {
    const stored: (string | undefined)[] = [];
    const { checked, field, said, preview, type } = drawn('#b91c1c', (color) => void stored.push(color));
    assert.deepEqual(checked(), ['Deep red']);

    type('#facc15', true);
    assert.equal(said(), '1.5:1 with white text. Pick a darker colour.');
    assert.deepEqual(stored, [], 'a colour refused was stored');
    assert.equal(field.value, '#facc15', 'what was typed is gone');
    assert.deepEqual(checked(), ['Deep red'], 'the colour that applies is still the one chosen');
    assert.equal(preview.style.getPropertyValue('--action'), '#b91c1c');

    type('#1d4e', true);
    assert.equal(said(), 'Write a colour as #rrggbb, for example #1d4ed8.');
    assert.deepEqual(stored, []);

    type('#1d4ed8');
    assert.equal(said(), '6.7:1 with white text.');
    assert.deepEqual(stored, [], 'stored before the field was left');
    type('#1d4ed8', true);
    assert.deepEqual(stored, ['#1d4ed8']);
    assert.deepEqual(checked(), [], 'a radio says a colour that is not the one stored');
    assert.equal(preview.style.getPropertyValue('--action'), '#1d4ed8');

    // One of the four, typed: its radio.
    type('#C2410C', true);
    assert.deepEqual(stored, ['#1d4ed8', '#c2410c']);
    assert.deepEqual(checked(), ['Orange']);
  });

  it('opens on a colour of your own stored before, written in the field', () => {
    const { checked, field, said } = drawn('#1d4ed8');
    assert.deepEqual(checked(), []);
    assert.equal(field.value, '#1d4ed8');
    assert.equal(said(), '6.7:1 with white text.');
  });

  it('opens on the red of Fruitback for a stored value that is not a colour the button can take', () => {
    const { checked, field } = drawn('#facc15');
    assert.deepEqual(checked(), ['Fruitback']);
    assert.equal(field.value, '');
  });

  it('« Reset to Fruitback red » takes the colour away, and clears the field', () => {
    const stored: (string | undefined)[] = [];
    const { checked, field, said, preview, reset, type } = drawn('#1d4ed8', (color) => void stored.push(color));
    type('#facc1');
    reset.click();
    assert.deepEqual(stored, [undefined]);
    assert.deepEqual(checked(), ['Fruitback']);
    assert.equal(field.value, '');
    assert.equal(said(), '');
    assert.equal(preview.style.getPropertyValue('--action'), '');
    assert.equal(reset.disabled, true);
  });

  it('puts the colour back, and says so, when the write fails', async () => {
    const { section, radio, checked, preview, pick } = drawn('#b91c1c', () => Promise.reject(new Error('QUOTA_BYTES')));
    const error = console.error;
    console.error = () => {};
    try {
      pick(radio('Orange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = error;
    }
    assert.deepEqual(checked(), ['Deep red']);
    assert.equal(preview.style.getPropertyValue('--action'), '#b91c1c');
    assert.equal(section.querySelector('.pref-problem')?.textContent, COLOR_NOT_SAVED);
  });

  it('writes a colour of your own back in the field when a radio chosen over it was not saved (review)', async () => {
    const { section, radio, checked, field, said, preview, pick } = drawn('#1d4ed8', () =>
      Promise.reject(new Error('QUOTA_BYTES')),
    );
    const error = console.error;
    console.error = () => {};
    try {
      pick(radio('Orange'));
      assert.equal(field.value, '', 'the radio clears the field at once');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = error;
    }
    assert.deepEqual(checked(), []);
    assert.equal(field.value, '#1d4ed8');
    assert.equal(said(), '6.7:1 with white text.');
    assert.equal(preview.style.getPropertyValue('--action'), '#1d4ed8');
    assert.equal(section.querySelector('.pref-problem')?.textContent, COLOR_NOT_SAVED);
  });

  it('keeps what is typed in the field while a write that then fails was in flight (review)', async () => {
    let fail: (error: Error) => void = () => {};
    const { radio, checked, field, said, preview, pick, type } = drawn(
      '#1d4ed8',
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    pick(radio('Orange'));
    type('#0f766e');
    const error = console.error;
    console.error = () => {};
    try {
      fail(new Error('QUOTA_BYTES'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = error;
    }
    assert.equal(field.value, '#0f766e', 'what was typed is gone');
    assert.equal(said(), '5.4:1 with white text.');
    assert.deepEqual(checked(), []);
    assert.equal(preview.style.getPropertyValue('--action'), '#1d4ed8');
  });

  it('speaks French, with a decimal comma in the ratio', () => {
    setLanguage('fr');
    assert.equal(formatRatio(2.14), '2,1:1');
    assert.deepEqual(judgeColor('#facc15'), {
      kind: 'refused',
      color: '#facc15',
      said: '1,5:1 avec un texte blanc. Choisissez une couleur plus foncée.',
    });
    const { section } = drawn(undefined);
    assert.equal(section.querySelector('h1')?.textContent, 'Apparence');
    assert.deepEqual(
      [...section.querySelectorAll('.appearance-swatch')].map((each) => each.textContent),
      ['Fruitback', 'Rouge profond', 'Orange', 'Encre'],
    );
  });

  it('never says 4.5:1 of a colour it refuses', () => {
    // Just under the line: rounded, it would read 4.5:1.
    assert.equal(formatRatio(4.4999), '4.4:1');
    assert.equal(formatRatio(4.5), '4.5:1');
  });
});
