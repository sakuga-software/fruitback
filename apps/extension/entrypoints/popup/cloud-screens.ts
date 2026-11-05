import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { NO_ACCESS_PROBLEM } from '../../src/site-editor.ts';
import { type ResolvedSite, isWildcardPattern } from '../../src/site-patterns.ts';
import { writeSite } from '../../src/sites.ts';
import { describeIdentity } from '../../src/session.ts';
import { currentShortcut } from '../../src/shortcut.ts';
import { showProblem } from '../../src/problem-view.ts';
import {
  type AddFailure,
  type Offer,
  type PlaceIds,
  type SettingsFailure,
  type SiteSettings,
  type Workspace,
  addSite,
  addableFromPopup,
  addableWorkspaces,
  cloudEntry,
  offerFor,
  setSiteSettings,
  sourceOffer,
} from '../../src/cloud.ts';
import { msg, t } from '../../src/i18n.ts';
import { openPanelOrPage, panelApis } from '../../src/side-panel.ts';
import { type Account, keysOfShortcut, showSiteFacts, turnOnScreen, siteOn } from '../../src/popup-view.ts';
import { hostOf, make } from '../../src/kit.ts';
import { changeNotice, destinationScreen } from '../../src/destination-screen.ts';

import { pairedFoot, pairedRow } from './pairing.ts';
import {
  NOT_NOW_WRITING,
  NOT_THERE,
  activateOpenTabs,
  askTab,
  otherCopyLine,
  turnOn,
  visibility,
} from './site-actions.ts';
import { unreachableScreen } from './sign-in.ts';
import {
  app,
  changed,
  CLOUD,
  cloudSeams,
  draws,
  failed,
  openSettings,
  pending,
  type PopupTab,
  refused,
  render,
  sessions,
} from './context.ts';

/** The screens of a site of a workspace (FRU-298): to turn on, to add, and on (FRU-560). */

/** FRU-537: the popup adds a site over https, or the loopback; another http site from the console. */
export const HTTP_SITE = msg('This site is on http. Add it to a workspace from the console, then turn it on here.');

/** The connectors of a workspace in the console, where « + Connect another tool » leads (FRU-600). */
function consoleConnectors(account: Account | undefined, workspace: string): (() => void) | undefined {
  if (account?.console === undefined) return undefined;
  const base = account.console.endsWith('/') ? account.console : `${account.console}/`;
  const url = new URL(`w/${encodeURIComponent(workspace)}/connectors`, base).toString();

  return () => {
    void browser.tabs.create({ url });
    window.close();
  };
}

/** Copies a text with the clipboard of the popup. `false`: the browser refused. */
const copyText = (text: string): Promise<boolean> =>
  navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );

/** The sites of a workspace in the console, where « Change » leads (FRU-298). */
export function consoleSites(account: Account | undefined, workspace: string): (() => void) | undefined {
  if (account?.console === undefined) return undefined;
  const base = account.console.endsWith('/') ? account.console : `${account.console}/`;
  const url = new URL(`w/${encodeURIComponent(workspace)}/sites`, base).toString();

  return () => {
    void browser.tabs.create({ url });
    window.close();
  };
}

/**
 * 2 (FRU-298): a site of a workspace, not on in this browser. The one click (FRU-101): the browser
 * asks for this site only, and the click is the gesture that permission needs, so nothing is awaited
 * before `turnOn` asks.
 */
export function offered(origin: string, offer: Offer, account: Account | undefined): HTMLElement {
  const problem = make(document, 'p', 'problem');
  const turn = (): void => void turnOn(offer.pattern, cloudEntry(offer)).then(refused(problem, turn), failed(problem));
  const change = consoleSites(account, offer.workspace.id);
  // FRU-453: a role that manages the sites chooses here, and each choice is written at once. Written
  // before « Turn on » and not by it: the prompt of the browser can close the popup, and a choice
  // that waited for the click would be lost with it.
  const sources = offer.workspace.sources;
  const save = async (settings: SiteSettings): Promise<boolean> => {
    problem.replaceChildren();
    const set = await setSiteSettings(offer.endpoint, offer.workspace, offer.site.id, settings, cloudSeams());
    if (!set.ok) showProblem(problem, t(SETTINGS_PROBLEM[set.reason]));

    return set.ok;
  };
  const screen = turnOnScreen(document, {
    origin,
    workspace: offer.workspace.name,
    ...(offer.site.destination === undefined ? {} : { destination: offer.site.destination.label }),
    ...(offer.site.destination?.kind === undefined ? {} : { destinationKind: offer.site.destination.kind }),
    visibility: offer.site.visibility,
    ...(account === undefined ? {} : { account }),
    ...(change === undefined ? {} : { onChange: change }),
    ...(sources === undefined
      ? {}
      : {
          choices: {
            sources: { [offer.workspace.id]: sources },
            workspace: offer.workspace.id,
            ...(offer.site.place === undefined ? {} : { place: offer.site.place }),
            loadOffer: (workspace, connector) => sourceOffer(offer.endpoint, workspace, connector, cloudSeams()),
            onVisibility: (visibility) => save({ visibility }),
            onPlace: (place) => save({ place }),
          },
        }),
    onTurnOn: turn,
    onSettings: openSettings,
  });
  screen.querySelector('.action-block')?.append(problem);

  return screen;
}

export const SETTINGS_PROBLEM: Record<SettingsFailure, string> = {
  forbidden: msg('Your role in this workspace does not let you change this site.'),
  'several-places': msg('This site sends to several places. Change them in Fruitback.'),
  'unknown-place': msg('This place is not in the tracker any more. Choose another one.'),
  'signed-out': msg('Your session ended. Sign in again from the Fruitback button, then try again.'),
  unavailable: msg('This site did not change. Try again in a moment.'),
};

/**
 * 2 (FRU-298, FRU-255): a site of no workspace of the account. The workspaces where it may add one
 * are read now; none, and the popup says who can. « Turn on » adds it, then turns it on.
 */
export async function siteOfNoWorkspace(origin: string, account: Account | undefined): Promise<HTMLElement> {
  // FRU-537: an http site that is not the loopback is added from the console, never from here. Said
  // before anything is asked, rather than « Turn on » and « Fruitback did not answer » after.
  if (!addableFromPopup(origin)) {
    return turnOnScreen(document, {
      origin,
      visibility: 'members',
      workspaces: [],
      unaddable: t(HTTP_SITE),
      ...(account === undefined ? {} : { account }),
      onTurnOn: () => undefined,
      onSettings: openSettings,
    });
  }
  const listed = CLOUD === undefined ? [] : await addableWorkspaces(CLOUD, cloudSeams());
  // Fruitback said nothing: that is an outage, not « ask an admin ».
  if (listed === undefined) return unreachableScreen(account);
  const workspaces = listed;
  const problem = make(document, 'p', 'problem');
  // FRU-453: what is chosen here is written once the site is added, before it is turned on.
  const wanted: SiteSettings = {};
  const screen = turnOnScreen(document, {
    origin,
    // A site is added for the members of its workspace: the worker's default.
    visibility: 'members',
    workspaces,
    choices: {
      sources: Object.fromEntries(workspaces.map((each) => [each.id, each.sources ?? []])),
      place: null,
      loadOffer: (workspace, connector) =>
        CLOUD === undefined ? Promise.resolve(undefined) : sourceOffer(CLOUD, workspace, connector, cloudSeams()),
      onVisibility: async (visibility) => {
        wanted.visibility = visibility;

        return true;
      },
      onPlace: async (place) => {
        wanted.place = place;

        return true;
      },
    },
    ...(account === undefined ? {} : { account }),
    onTurnOn: (id) => {
      const workspace = workspaces.find((each) => each.id === id);
      if (workspace !== undefined) addAndTurnOn(origin, workspace, problem, wanted);
    },
    onSettings: openSettings,
  });
  screen.querySelector('.action-block')?.append(problem);

  return screen;
}

/**
 * « Add to {workspace} and turn on ». **The access to the site is asked for first**, in the click:
 * the site is created after, so a refusal creates nothing, and « Grant access » asks again. Then the
 * site, then the rule, as the one click of 06 stores it.
 */
export function addAndTurnOn(
  origin: string,
  workspace: Workspace,
  problem: HTMLElement,
  wanted: SiteSettings = {},
): void {
  if (CLOUD === undefined) return;
  const endpoint = CLOUD;
  const again = (): void => addAndTurnOn(origin, workspace, problem, wanted);
  for (const button of app?.querySelectorAll('button') ?? []) button.disabled = true;
  const done = (): void => {
    for (const button of app?.querySelectorAll('button') ?? []) button.disabled = false;
  };

  // FRU-454: remembered before the prompt, which can close this popup: the background then adds the
  // site and turns it on when the access arrives, and nobody clicks « Turn on » twice. WARNING: not
  // awaited, an await before `permissions.request` loses the gesture.
  void pending
    .rememberAdd(origin, {
      endpoint,
      workspace: { id: workspace.id, name: workspace.name },
      ...(Object.keys(wanted).length === 0 ? {} : { settings: wanted }),
    })
    .catch(() => undefined);
  // Only the intent of this site: another click may have written another one since (raised in review).
  const forget = (): Promise<void> => pending.forgetAdd(origin).catch(() => undefined);
  void (async () => {
    const granted = await browser.permissions.request({ origins: [matchPatternFor(origin)] }).catch(() => false);
    if (!granted) {
      // Refused: no site is added later by surprise, if the access comes another way.
      await forget();
      done();
      showProblem(problem, NO_ACCESS_PROBLEM, { grant: again });

      return;
    }
    const added = await addSite(endpoint, workspace, origin, cloudSeams());
    if (!added.ok) {
      await forget();
      // Drawn again, with the buttons off until then: on, a second click would add once more while the
      // popup reads the session (raised in review).
      if (added.reason === 'signed-out') {
        await render();

        return;
      }
      done();
      showProblem(problem, t(ADD_PROBLEM[added.reason]));

      return;
    }
    // FRU-453: what was chosen on the screen, before the rule. A refusal stops here: the site is in
    // the workspace, as members only and with no place, and « Turn on » again adds nothing more.
    if (wanted.visibility === 'everyone' || (wanted.place !== undefined && wanted.place !== null)) {
      const set = await setSiteSettings(endpoint, workspace, added.offer.site.id, wanted, cloudSeams());
      if (!set.ok) {
        await forget();
        done();
        showProblem(problem, t(SETTINGS_PROBLEM[set.reason]));

        return;
      }
    }
    try {
      await writeSite(origin, cloudEntry(added.offer));
      // Done here: the background has nothing left to finish.
      await forget();
      await activateOpenTabs(origin);
    } catch (error) {
      await forget();
      // The site is in the workspace now, and the rule is not here: drawn again, the popup shows
      // what is true, the site of the workspace and its « Turn on here » (raised in review).
      console.error('[fruitback] the site was added, and its rule was not stored', error);
      await render();

      return;
    }
    await render();
  })().catch((error: unknown) => {
    void forget();
    done();
    failed(problem)(error);
  });
}

export const ADD_PROBLEM: Record<Exclude<AddFailure, 'signed-out'>, string> = {
  forbidden: msg('Your role in this workspace does not let you add a site.'),
  'rate-limited': msg('Too many sites were added in the last hour. Try again later.'),
  unavailable: msg('The site was not added. Try again in a moment.'),
  'insecure-origin': HTTP_SITE,
};

/**
 * A rule this extension stored for a site of a workspace, on its own origin: the screen of the
 * switch (07). A wildcard of previews keeps the screen of before, whose words say that it switches
 * every site the rule covers: the switch of 07 is about this tab only.
 */
export function isWorkspaceSite({ pattern, site }: ResolvedSite): boolean {
  return site.mode === 'team' && site.mount !== undefined && !isWildcardPattern(pattern);
}

export async function siteOfWorkspaceOn(
  origin: string,
  { pattern, site }: ResolvedSite,
  tab: PopupTab | undefined,
  account: Account | undefined,
): Promise<HTMLElement> {
  const workspace = site.mode === 'team' ? (site.mount?.workspace ?? '') : '';
  // A session of a pairing with that worker: the head names its person when no account is held, and
  // the foot says it with its « Log out » (FRU-319). The session of the account is not one: it is
  // the head and the foot of the account, and it logs out on the page of the extension.
  const held = (await sessions.list())[site.endpoint];
  const paired = held === undefined || held.account === true ? undefined : held;
  const person = account ?? (paired === undefined ? undefined : { name: describeIdentity(paired.identity) });
  const problem = make(document, 'p', 'problem');
  // FRU-296: the panel of the browser, opened in this click (before any `await`: the browser opens it
  // only in a gesture). A browser with no panel shows the list of the widget in the page. « Show all
  // notes in a sidebar », and a click on « fixes to check » or « open notes » (FRU-298).
  const openPanel = (): void =>
    void openPanelOrPage(
      panelApis(browser),
      { ...(tab?.id === undefined ? {} : { tabId: tab.id }) },
      async () => (await askTab(tab, 'show-notes')).done,
    ).then((shown) => (shown === 'nothing' ? showProblem(problem, t(NOT_THERE)) : window.close()));
  // FRU-291: the keys of « Leave a note », as the person set them. None: no line.
  const shortcut = currentShortcut(await browser.commands.getAll().catch(() => []));
  const screen = siteOn(document, {
    origin,
    workspace,
    on: site.enabled,
    visibility: await visibility(origin),
    ...(shortcut === undefined ? {} : { shortcut: keysOfShortcut(shortcut) }),
    ...(person === undefined ? {} : { account: person }),
    ...(paired === undefined || account !== undefined ? {} : { foot: pairedFoot(site.endpoint, paired.identity) }),
    onToggle: (on) => {
      if (!on) {
        void writeSite(pattern, { ...site, enabled: false }).then(() => render(), failed(problem));

        return;
      }
      const turn = (): void =>
        void turnOn(pattern, { ...site, enabled: true }).then(refused(problem, turn), failed(problem));
      turn();
    },
    // The widget takes over the tab: the popup would stand over the page somebody is about to click.
    // It goes only when the widget did it: otherwise it stays, and says why.
    onLeaveFeedback: () =>
      void askTab(tab, 'leave-feedback').then(({ done, busy }) => {
        if (done) window.close();
        // Said only when the widget is there and said no: no answer is a page that is not ready.
        else showProblem(problem, t(busy === true ? NOT_NOW_WRITING : NOT_THERE));
      }),
    onOpenPanel: openPanel,
    onSettings: openSettings,
  });
  screen.querySelector('.popup-body')?.append(problem, otherCopyLine(tab, site.enabled));
  // FRU-600: « Where notes go » saved, and screen 3 drawn again: it says what changed, once.
  if (changed.text !== undefined) {
    screen.querySelector('.popup-body')?.prepend(changeNotice(document, changed.text));
    delete changed.text;
  }
  // An account and a pairing with another worker (FRU-319): the foot is the account's, so the
  // pairing keeps its row and its « Log out » in the body.
  if (paired !== undefined && account !== undefined) {
    screen.querySelector('.popup-body')?.append(pairedRow(site.endpoint, paired.identity));
  }
  // FRU-298: where the notes go, the fixes to check and the open notes of the site, as the worker
  // lists them (FRU-295), added when it answers: the screen does not wait for it, and a worker that
  // does not answer leaves the lines out rather than zeros. Not for a screen that is gone by then.
  if (site.enabled) {
    const screenNow = draws.drawn;
    void offerFor(origin, cloudSeams())
      .catch(() => undefined)
      .then((listed) => {
        if (listed === undefined || screenNow !== draws.drawn) return;
        const { notes, destination, toCheck } = listed.site;
        // FRU-600: « Where notes go », a screen of its own, opened from the line and from the menu.
        const showScreen = (sources: typeof listed.workspace.sources): void => {
          draws.drawn += 1;
          app?.replaceChildren(
            destinationScreen(document, {
              host: hostOf(origin),
              workspace,
              ...(sources === undefined ? {} : { sources }),
              ...(listed.site.place === undefined ? {} : { place: listed.site.place }),
              ...(destination === undefined ? {} : { label: destination.label }),
              ...(destination?.kind === undefined ? {} : { kind: destination.kind }),
              loadOffer: (connector: string) =>
                sourceOffer(listed.endpoint, listed.workspace.id, connector, cloudSeams()),
              onSave: async (place: PlaceIds | null, said: string) => {
                const set = await setSiteSettings(
                  listed.endpoint,
                  listed.workspace,
                  listed.site.id,
                  { place },
                  cloudSeams(),
                );
                if (!set.ok) return false;
                changed.text = t('New notes now go to {place}', { place: said });
                await render();

                return true;
              },
              onBack: () => void render(),
              ...(consoleConnectors(account, listed.workspace.id) === undefined
                ? {}
                : { onConnect: consoleConnectors(account, listed.workspace.id) as () => void }),
              copy: copyText,
            }),
          );
          app?.querySelector<HTMLElement>('input:checked, .destination-back')?.focus();
        };
        // FRU-530: a role that may change where the notes go gets the sources of the workspace, and
        // « Change » writes through the route of « Turn on » (FRU-453): no route of its own.
        const sources = listed.workspace.sources;
        const change =
          sources === undefined
            ? undefined
            : {
                sources,
                ...(listed.site.place === undefined ? {} : { place: listed.site.place }),
                loadOffer: (connector: string) =>
                  sourceOffer(listed.endpoint, listed.workspace.id, connector, cloudSeams()),
                onPlace: async (place: PlaceIds | null) => {
                  problem.replaceChildren();
                  const set = await setSiteSettings(
                    listed.endpoint,
                    listed.workspace,
                    listed.site.id,
                    { place },
                    cloudSeams(),
                  );
                  if (!set.ok) showProblem(problem, t(SETTINGS_PROBLEM[set.reason]));

                  return set.ok;
                },
                open: () => showScreen(sources),
              };
        showSiteFacts(
          screen,
          { workspace, on: site.enabled, onOpenPanel: openPanel },
          {
            ...(destination === undefined ? {} : { destination: destination.label }),
            ...(destination?.kind === undefined ? {} : { destinationKind: destination.kind }),
            ...(change === undefined ? {} : { change }),
            ...(change === undefined ? { locked: () => showScreen(undefined) } : {}),
            ...(toCheck === undefined ? {} : { toCheck }),
            ...(notes === undefined ? {} : { open: notes.new + notes.todo + notes.progress }),
          },
        );
      });
  }

  return screen;
}
