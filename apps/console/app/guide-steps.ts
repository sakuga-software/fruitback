import { msg } from './i18n.ts';

/**
 * The guide of the extension (FRU-486): one source for step 3 of the setup and for `docs/reviewing.md`.
 *
 * Each step has a sentence, the capture that shows it, and the controls the sentence names. A
 * sentence names a control with `{key}`: the setup draws it in bold, in the language of the person,
 * and `e2e/first-note.spec.ts` checks that the page of the capture draws it, by its role and its
 * accessible name, before it takes the capture.
 *
 * The captures are in `docs/assets/guide/`, under the name of their step. Only
 * `pnpm guide:captures` writes them, on a Mac: see `docs/decisions/onboarding.md`.
 */

/** Where a control is drawn. The extension and the console each translate their own words. */
export type GuideControl = {
  role: 'button' | 'link';
  /** The English sentence of the control, as its screen hands it to `t`. */
  name: string;
  where: 'extension' | 'console';
  /**
   * What each `{name}` of the control reads in the guide. The screen shows a value of the moment, such
   * as the address of the site; the guide shows a word that stands for it.
   */
  values?: Readonly<Record<string, string>>;
};

export type GuideStep = {
  /** The name of its capture: `docs/assets/guide/<id>.png`. Stable: the docs and the setup link it. */
  id: string;
  text: string;
  alt: string;
  controls: Readonly<Record<string, GuideControl>>;
};

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'welcome',
    text: msg('Install the extension. A Fruitback tab opens: choose {signIn} there.'),
    alt: msg('The tab that opens at install, with Sign in with email'),
    controls: { signIn: { role: 'button', name: msg('Sign in with email'), where: 'extension' } },
  },
  {
    id: 'word',
    text: msg(
      'A tab of the console opens with a word. Check that the Fruitback tab shows the same word, then press {connect}.',
    ),
    alt: msg('The console shows the word to check, and Connect Chrome'),
    controls: {
      connect: { role: 'button', name: msg('Connect {browser}'), where: 'console', values: { browser: 'Chrome' } },
    },
  },
  {
    id: 'turn-on',
    text: msg('Back on the Fruitback tab, press {turnOn}. Chrome asks once for access to that site: allow it.'),
    alt: msg('The Fruitback tab, signed in, with Turn on and the address of the site'),
    controls: {
      turnOn: { role: 'button', name: msg('Turn on {site}'), where: 'extension', values: { site: msg('your site') } },
    },
  },
  {
    id: 'note',
    text: msg(
      'The site opens, ready for a note: click the part of the page it is about, write what should change, then send it.',
    ),
    alt: msg('A note written on an element of the site'),
    controls: {},
  },
  {
    id: 'popup',
    text: msg(
      'Later, the Fruitback icon in the toolbar opens the same tools on any site of your team: {leave} starts a note.',
    ),
    alt: msg('The popup on a site that is on, with Leave a note'),
    controls: { leave: { role: 'button', name: msg('Leave a note'), where: 'extension' } },
  },
];

/**
 * The captures that a guide shows outside of the steps: the popup of a browser that is signed out
 * (`docs/reviewing.md`), and the card of the script tag (`docs/install.md`). The spec takes them too.
 */
export const GUIDE_EXTRA_CAPTURES = ['popup-sign-in', 'script'] as const;

/** What the spec writes beside the captures: the version of the extension of the last capture that changed. */
export type GuideCaptured = { extension: string };

/** A sentence cut at its `{key}`: the words, and the keys of the controls between them. */
export function guideParts(sentence: string): ({ text: string } | { control: string })[] {
  return sentence
    .split(/(\{\w+\})/)
    .filter((part) => part !== '')
    .map((part) => (/^\{\w+\}$/.test(part) ? { control: part.slice(1, -1) } : { text: part }));
}

/** The text of a control in a guide: its sentence with each `{name}` replaced by the word of the guide. */
export function controlText(control: GuideControl, translate: (sentence: string) => string): string {
  return translate(control.name).replaceAll(/\{(\w+)\}/g, (whole, name: string) => {
    const value = control.values?.[name];

    return value === undefined ? whole : translate(value);
  });
}

/** Where a guide points the person at the step's capture, from `docs/`. */
export const GUIDE_FOLDER = 'assets/guide';

const START =
  '<!-- guide:start: written from apps/console/app/guide-steps.ts by `node apps/console/guide-docs.ts`. -->';
const END = '<!-- guide:end -->';

/** The steps as Markdown, in English, for `docs/reviewing.md`. */
export function guideMarkdown(captured: GuideCaptured): string {
  const steps = GUIDE_STEPS.map((step, index) => {
    const sentence = guideParts(step.text)
      .map((part) => {
        if ('text' in part) return part.text;
        const control = step.controls[part.control];
        if (control === undefined) throw new Error(`the step ${step.id} names no control ${part.control}`);

        return `**${controlText(control, (sentence) => sentence)}**`;
      })
      .join('');

    return `${index + 1}. ${sentence}\n\n   ![${step.alt}](${GUIDE_FOLDER}/${step.id}.png)`;
  });

  return [
    START,
    '',
    ...steps.flatMap((step) => [step, '']),
    `The captures are of the extension ${captured.extension}, taken by \`e2e/first-note.spec.ts\`.`,
    '',
    END,
  ].join('\n');
}

/** `document` with its block of the guide replaced by `block`. Throws when it holds no block. */
export function withGuideBlock(document: string, block: string): string {
  const start = document.indexOf('<!-- guide:start');
  const end = document.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error('the document holds no block of the guide');

  return `${document.slice(0, start)}${block}${document.slice(end + END.length)}`;
}
