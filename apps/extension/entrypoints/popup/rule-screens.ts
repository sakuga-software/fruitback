import { browser } from 'wxt/browser';
import {
  MODES_GUIDE,
  NOTES_NEED_SESSION,
  READ_NEEDS_SESSION,
  WORKER_NOT_FOUND,
  probeRead,
} from '../../src/read-probe.ts';
import { matchPatternFor } from '../../src/registration.ts';
import { complaint, pairingFragment, pairingLinkIn, siteFrom } from '../../src/site-form.ts';
import { type ResolvedSite, isWildcardPattern } from '../../src/site-patterns.ts';
import { type SiteConfig, type SiteMode, writeSite } from '../../src/sites.ts';
import { whenNotAnswering } from '../../src/guide.ts';
import { showProblem } from '../../src/problem-view.ts';
import { msg, t } from '../../src/i18n.ts';
import { type Account, problem, visibilityButton } from '../../src/popup-view.ts';
import { hostOf, make } from '../../src/kit.ts';

import { activateOpenTabs, turnOn, visibility } from './site-actions.ts';
import { actions, failed, field, openSettings, refused, render } from './context.ts';

/** The screens of a rule typed in the popup (FRU-41, FRU-43): its form, its switch, its access (FRU-560). */

/**
 * 4 · A problem, with its fix (FRU-297): the rule is on, and the browser took its access away.
 *
 * « Allow access again » asks in the click itself: an await before `permissions.request` would lose
 * the gesture. « Turn off for this site » keeps the rule, off.
 */
export function siteWithoutAccess(
  origin: string,
  { pattern, site }: ResolvedSite,
  account: Account | undefined,
): HTMLElement {
  const host = hostOf(origin);
  const screen = problem(document, {
    site: origin,
    title: t("Fruitback can't open this page"),
    text: t('Access to {host} was removed in your browser settings. Your notes are safe.', { host }),
    primary: {
      label: t('Allow access again'),
      onClick: () =>
        void browser.permissions
          .request({ origins: [matchPatternFor(pattern)] })
          .then(async (granted) => {
            if (!granted) return;
            await activateOpenTabs(pattern);
            await render();
          })
          .catch(failed(said)),
    },
    secondary: {
      label: t('Turn off for this site'),
      onClick: () => void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(said)),
    },
    help: whenNotAnswering(),
    onSettings: openSettings,
    ...(account === undefined ? {} : { account }),
  });
  const said = make(document, 'p', 'problem');
  screen.querySelector('.popup-body')?.append(said);

  return screen;
}

export const NO_RULE = msg('No rule covers this origin, so Fruitback does nothing here.');
/**
 * Why a private-mode site shows no note on a worker that reads `authenticated` (FRU-66), and, in both
 * modes, a rule whose worker is not at its address (FRU-395).
 *
 * The line is empty until the worker answers, and stays empty unless the answer is a `401`. The
 * popup does not wait for it: the switch must not sit behind a worker that is slow.
 */
export function readability(site: SiteConfig, pageUrl: string): HTMLElement {
  const line = make(document, 'p', 'problem');
  if (!site.enabled) return line;

  // FRU-395: in both modes, a worker that is not at the address of the rule. The client is the one
  // the widget reads with, when the rule names one.
  const clientId = site.mode === 'private' ? site.clientId : site.mount?.clientId;
  void probeRead({ endpoint: site.endpoint, clientId }, pageUrl, { fetch: (url, init) => fetch(url, init) }).then(
    (answer) => {
      if (answer === 'not-found') {
        line.append(t(WORKER_NOT_FOUND));

        return;
      }
      if (site.mode !== 'private') return;
      if (answer !== 'wants-a-session' && answer !== 'members-only') return;

      const guide = make(document, 'a', '', t('Which mode can read it'));
      guide.href = MODES_GUIDE;
      guide.target = '_blank';
      guide.rel = 'noreferrer';
      // FRU-330: a site whose notes are « Members only » refuses the notes of private mode too.
      const sentence = answer === 'members-only' ? NOTES_NEED_SESSION : READ_NEEDS_SESSION;
      line.append(`${t(sentence)} `, guide);
    },
  );

  return line;
}

/**
 * Ask for the mode, and for what that mode cannot work without.
 *
 * The client id is asked for in private mode only. In team mode the site embeds its own widget and
 * declares its own client id, and a second one stored here would be a value nothing reads.
 */
export function form(origin: string, found?: ResolvedSite, draft?: SiteConfig): HTMLElement {
  const site = found?.site;
  // The fields show the entry, or what was typed for a site that has none yet.
  const shown = site ?? draft;
  // A wildcard entry is saved under its own pattern, so the change reaches every site it covers.
  const pattern = found?.pattern ?? origin;
  const mode = modeField(shown?.mode ?? 'private');
  const endpoint = field(t('Server address'), 'https://feedback.acme.dev');
  const clientId = field(t('Client id'), 'acme');
  const save = make(document, 'button', '', site === undefined ? t('Turn on for this site') : t('Save'));
  const problem = make(document, 'p', 'problem');

  endpoint.input.value = shown?.endpoint ?? '';
  clientId.input.value = shown !== undefined && shown.mode === 'private' ? shown.clientId : '';

  const showFields = (): void => {
    clientId.label.hidden = mode.select.value === 'team';
  };
  mode.select.addEventListener('change', showFields);
  showFields();

  save.addEventListener('click', () => {
    const values = {
      mode: mode.select.value === 'team' ? ('team' as const) : ('private' as const),
      endpoint: endpoint.input.value.trim(),
      clientId: clientId.input.value.trim(),
    };

    // Said out loud rather than refused in silence. The bridge applies the same rule before it
    // mounts, so an endpoint that fails here would have been stored, shown as **On**, and then
    // ignored by a page that reported nothing — which reads as a broken extension. Raised in review.
    const wrong = complaint(values, pattern);
    // FRU-395: a pairing link where the worker goes. Its pairing is on the page of the extension.
    const link = pairingLinkIn(values.endpoint);
    showProblem(problem, wrong, {
      ...(link === undefined
        ? {}
        : {
            pair: () => {
              void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}${pairingFragment(link)}` });
              window.close();
            },
          }),
    });
    if (wrong !== '') return;

    // `enabled` is kept: changing the endpoint of a site that is switched off must not switch it on.
    const formed = siteFrom(values, site?.enabled ?? true);
    // The form knows two modes and no mount (FRU-101). Saving a site of a workspace with its endpoint
    // unchanged keeps the widget the extension mounts there, which the form cannot show.
    const next: SiteConfig =
      formed.mode === 'team' && site?.mode === 'team' && site.mount !== undefined && formed.endpoint === site.endpoint
        ? { ...formed, mount: site.mount }
        : formed;

    // And a site that stays off must not ask for access or run anything. `turnOn` requests the host
    // permission and injects both scripts into the open tab, neither of which belongs to saving an
    // entry nobody has switched on. Raised in review.
    if (!next.enabled) {
      void writeSite(pattern, next).then(() => render(), failed(problem));

      return;
    }

    const turn = (): void => void turnOn(pattern, next).then(refused(problem, turn), failed(problem));
    turn();
  });

  const wrapper = document.createElement('div');
  wrapper.append(mode.label, endpoint.label, clientId.label, save, problem);

  return wrapper;
}

/** Configured: the switch, and what it is switching. */
export function status({ pattern, site }: ResolvedSite, shown?: Awaited<ReturnType<typeof visibility>>): HTMLElement {
  // A wildcard entry switches every site it covers, so the button must not say "here".
  const wide = isWildcardPattern(pattern);
  const off = wide ? t('Turn off for every site this rule covers') : t('Turn off here');
  const on = wide ? t('Turn on for every site this rule covers') : t('Turn on here');
  const toggle = make(document, 'button', '', site.enabled ? off : on);
  const problem = make(document, 'p', 'problem');
  toggle.addEventListener('click', () => {
    if (site.enabled) {
      void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(problem));

      return;
    }

    const turn = (): void =>
      void turnOn(pattern, { ...site, enabled: true }).then(refused(problem, turn), failed(problem));
    turn();
  });

  const change = make(document, 'button', '', t('Change'));
  change.className = 'secondary';
  change.addEventListener('click', () => void render(true));

  // The sentence of a rule that covers many sites is longer than the popup: that button may wrap.
  if (wide) toggle.classList.add('long');
  // FRU-590: « Hide Fruitback on this page » beside them, for this origin only, while the rule is on.
  const buttons =
    site.enabled && shown !== undefined
      ? actions(change, toggle, visibilityButton(document, shown))
      : actions(change, toggle);

  const row = document.createElement('div');
  row.className = 'row';
  row.append(make(document, 'span', 'state', `${site.enabled ? t('On') : t('Off')} · ${describeSite(site)}`), buttons);

  const wrapper = document.createElement('div');
  wrapper.append(row);
  if (site.enabled && shown?.shown === false) {
    wrapper.append(make(document, 'p', 'hidden-line', t('Fruitback is hidden on this page.')));
  }
  wrapper.append(problem);

  return wrapper;
}

/** What this entry is switching, in one phrase: a client id in private mode, the mode in team. */
export function describeSite(site: SiteConfig): string {
  if (site.mode === 'private') return site.clientId;
  if (site.mount !== undefined) {
    return t('workspace · {name}', { name: site.mount.workspace ?? site.mount.clientId });
  }

  return t("team mode · the site's own widget");
}

export function modeField(current: SiteMode): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const select = document.createElement('select');
  for (const [value, text] of [
    ['private', 'Private · the extension shows the widget'],
    ['team', 'Team · the site embeds it, the extension adds your session'],
  ]) {
    const option = document.createElement('option');
    option.value = value as string;
    // The label stays English in the list above: the guide is checked against it.
    option.textContent = t(text as string);
    select.append(option);
  }

  select.value = current;

  const wrapper = document.createElement('label');
  wrapper.append(t('Mode'), select);

  return { label: wrapper, select };
}
