import {
  FRUITBACK_RED,
  MINIMUM_CONTRAST,
  PRESETS,
  contrastWithWhite,
  paintAction,
  parseActionColor,
  parseHexColor,
} from './action-color.ts';
import { language, msg, t } from './i18n.ts';
import { button, dropMark, make } from './kit.ts';
import { sectionId } from './options-pages.ts';

/**
 * « Appearance », a page of the page of the extension (FRU-601, FRU-591): the colour of the note
 * button. Four colours, a colour of your own refused under 4.5:1 with white text, a preview of
 * « Leave a note » and « Send », and « Reset to Fruitback red ». No `browser` here:
 * `entrypoints/options/main.ts` reads and writes storage, and `appearance-page.test.ts` reads this
 * on happy-dom.
 */

/** The names of the four colours, as the page says them. */
const PRESET_WORDS: Record<(typeof PRESETS)[number]['id'], string> = {
  fruitback: msg('Fruitback'),
  'deep-red': msg('Deep red'),
  orange: msg('Orange'),
  ink: msg('Ink'),
};

/** What a write that failed says: the choice is back where it was. */
export const COLOR_NOT_SAVED = msg('This colour could not be saved. Try again.');

/**
 * A ratio as the page says it, rounded down to one decimal so that « 4.5:1 » is never said of a
 * colour that is refused: « 2.1:1 », and « 2,1:1 » in French.
 */
export function formatRatio(ratio: number): string {
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);

  return `${language() === 'fr' ? shown.replace('.', ',') : shown}:1`;
}

export type Judged =
  | { kind: 'empty' }
  | { kind: 'invalid'; said: string }
  | { kind: 'refused' | 'kept'; color: string; said: string };

/** What the page says of a colour typed in: its contrast with white, and what to do when it is refused. */
export function judgeColor(text: string): Judged {
  if (text.trim() === '') return { kind: 'empty' };
  const color = parseHexColor(text);
  if (color === undefined) return { kind: 'invalid', said: t('Write a colour as #rrggbb, for example #1d4ed8.') };
  const ratio = formatRatio(contrastWithWhite(color));

  return contrastWithWhite(color) >= MINIMUM_CONTRAST
    ? { kind: 'kept', color, said: t('{ratio} with white text.', { ratio }) }
    : { kind: 'refused', color, said: t('{ratio} with white text. Pick a darker colour.', { ratio }) };
}

export type AppearanceOptions = {
  /** The colour stored now. `undefined`: the red of Fruitback. */
  color: string | undefined;
  /** Stores a colour, or takes it away for `undefined`. A write that fails puts the choice back. */
  onColor: (color: string | undefined) => Promise<void> | void;
};

/** The section « Appearance ». */
export function appearanceSection(document: Document, options: AppearanceOptions): HTMLElement {
  const section = make(document, 'section', 'page-section');
  section.classList.add('appearance');
  section.id = sectionId('appearance');
  const title = make(document, 'h1', '', t('Appearance'));
  title.id = 'appearance-title';
  section.setAttribute('aria-labelledby', title.id);
  const intro = make(
    document,
    'p',
    'appearance-intro',
    t(
      'The colour of « Leave a note » and « Send » when you write with the extension. It is yours, in this browser: your team and the site see no change, and the pins keep their colours.',
    ),
  );

  let kept = parseActionColor(options.color);
  const card = make(document, 'div', 'pref-card');

  // The four colours: radios, in a group named by its legend.
  const presets = make(document, 'fieldset', 'appearance-presets');
  presets.append(make(document, 'legend', 'pref-title', t('Colour of the note button')));
  const radios = new Map<string, HTMLInputElement>();
  const swatches = make(document, 'div', 'appearance-swatches');
  for (const preset of PRESETS) {
    const label = make(document, 'label', 'appearance-swatch');
    const radio = make(document, 'input', '');
    radio.type = 'radio';
    radio.name = 'action-color';
    radio.value = preset.color;
    const chip = make(document, 'span', 'appearance-chip');
    chip.style.background = preset.color;
    chip.setAttribute('aria-hidden', 'true');
    label.append(radio, chip, make(document, 'span', '', t(PRESET_WORDS[preset.id])));
    radios.set(preset.color, radio);
    swatches.append(label);
  }
  presets.append(swatches);

  // A colour of your own, judged as it is typed, kept when it is left (Enter, or Tab).
  const own = make(document, 'div', 'pref-row');
  own.classList.add('appearance-own');
  const ownWords = make(document, 'div', 'pref-words');
  const ownLabel = make(document, 'label', 'pref-title', t('Your own colour'));
  ownLabel.htmlFor = 'appearance-own-color';
  ownWords.append(
    ownLabel,
    make(document, 'span', 'pref-help', t('A hex colour that holds white text at 4.5:1 or more.')),
  );
  const field = make(document, 'input', 'pref-name');
  field.classList.add('appearance-field');
  field.id = 'appearance-own-color';
  field.type = 'text';
  field.placeholder = '#1d4ed8';
  field.spellcheck = false;
  field.autocomplete = 'off';
  const said = make(document, 'p', 'appearance-said');
  said.id = 'appearance-said';
  said.setAttribute('role', 'status');
  field.setAttribute('aria-describedby', said.id);
  const ownControl = make(document, 'div', 'appearance-own-control');
  ownControl.append(field);
  own.append(ownWords, ownControl, said);

  // The preview: what the popup and the composer will show.
  const preview = make(document, 'div', 'appearance-preview');
  preview.setAttribute('role', 'group');
  preview.setAttribute('aria-label', t('Preview'));
  const mark = (): SVGSVGElement => {
    const drawing = dropMark(document);
    drawing.classList.add('appearance-mark');

    return drawing;
  };
  const leave = make(document, 'span', 'appearance-leave');
  leave.append(mark(), document.createTextNode(t('Leave a note')));
  const send = make(document, 'span', 'appearance-send');
  send.append(mark(), document.createTextNode(t('Send')));
  preview.append(leave, send);

  const reset = button(document, 'kit-secondary', t('Reset to Fruitback red'), () => {
    field.value = '';
    said.textContent = '';
    delete said.dataset.refused;
    choose(undefined);
  });
  reset.classList.add('appearance-reset');
  const foot = make(document, 'div', 'pref-row');
  foot.classList.add('appearance-foot');
  foot.append(preview, reset);

  const problem = make(document, 'p', 'pref-problem');
  problem.setAttribute('role', 'status');

  /** Shows a colour as chosen: its radio if it is one of the four, the preview, and « Reset » off for the red. */
  const show = (color: string | undefined): void => {
    for (const [value, radio] of radios) radio.checked = value === (color ?? FRUITBACK_RED);
    paintAction(preview, color);
    reset.disabled = color === undefined;
  };
  /** Stores a colour; a write that fails puts back the one before, and says so. */
  const choose = (color: string | undefined): void => {
    // The red of Fruitback is the default, and is stored as no key.
    const next = color === FRUITBACK_RED ? undefined : color;
    const before = kept;
    kept = next;
    show(next);
    problem.textContent = '';
    void Promise.resolve(options.onColor(next)).catch((error: unknown) => {
      console.error('[fruitback] the colour was not saved', error);
      kept = before;
      show(before);
      problem.textContent = t(COLOR_NOT_SAVED);
    });
  };

  for (const radio of radios.values()) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      field.value = '';
      said.textContent = '';
      delete said.dataset.refused;
      choose(radio.value);
    });
  }
  field.addEventListener('input', () => {
    const judged = judgeColor(field.value);
    said.textContent = judged.kind === 'empty' ? '' : judged.said;
    if (judged.kind === 'refused' || judged.kind === 'invalid') said.dataset.refused = 'true';
    else delete said.dataset.refused;
  });
  field.addEventListener('change', () => {
    const judged = judgeColor(field.value);
    // A colour refused, or no colour, stores nothing: what is typed stays, with what to do.
    if (judged.kind === 'kept' && judged.color !== (kept ?? FRUITBACK_RED)) choose(judged.color);
  });

  // A colour of your own that is stored is written in the field, and said.
  if (kept !== undefined && !radios.has(kept)) {
    field.value = kept;
    const judged = judgeColor(kept);
    if (judged.kind !== 'empty') said.textContent = judged.said;
  }
  show(kept);

  card.append(presets, own, foot, problem);
  section.append(title, intro, card);

  return section;
}
