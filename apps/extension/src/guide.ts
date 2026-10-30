import { t } from './i18n.ts';

/**
 * The pages of the guide that a state of the extension leads to (FRU-528): `docs/reviewing.md`, as
 * fruitback.com publishes it. A build for a server of one's own leads to the same public guide.
 *
 * `reviewing-doc.test.ts` checks that each anchor here is a heading of `docs/reviewing.md`, so a
 * renamed section breaks the build and not the button.
 */
export const GUIDE = 'https://fruitback.com/reviewing.html';

/** A way to the guide: the words of its button, and the section it opens. */
export type Help = { label: string; href: string };

/** The anchors of `docs/reviewing.md` the buttons open. */
export const GUIDE_ANCHORS = {
  switchOn: '2-switch-a-site-on',
  notAnswering: 'when-fruitback-does-not-answer',
  whoCanAdd: 'who-can-add-a-site-to-a-workspace',
} as const;

const at = (anchor: keyof typeof GUIDE_ANCHORS): string => `${GUIDE}#${GUIDE_ANCHORS[anchor]}`;

/** A page of the browser, where nothing runs: how Fruitback works on a site. */
export function howItWorks(): Help {
  return { label: t('How Fruitback works'), href: at('switchOn') };
}

/** Fruitback did not answer, the access was removed, a read failed, the widget did not start. */
export function whenNotAnswering(): Help {
  return { label: t('What to check when Fruitback does not answer'), href: at('notAnswering') };
}

/** Nobody here may add the site to a workspace. */
export function whoCanAdd(): Help {
  return { label: t('Who can add a site to a workspace?'), href: at('whoCanAdd') };
}

/** The side panel of a page with no note yet. */
export function leaveAndFollow(): Help {
  return { label: t('How to leave and follow notes'), href: at('switchOn') };
}
