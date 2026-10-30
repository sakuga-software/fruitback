import type { PanelNote } from '../src/protocol.ts';
import {
  type Account,
  connecting,
  loading,
  notAWebPage,
  problem,
  signInStop,
  signedOut,
  siteOn,
  turnOnScreen,
} from '../src/popup-view.ts';
import { STAGE_FILTERS, type SearchState } from '../src/search-options.ts';
import { type PanelNotes, type PanelOptions, type PanelState, panelPage } from '../src/side-panel.ts';
import { type WelcomeSignIn, welcomeScreen } from '../src/welcome.ts';

/**
 * The states of the gallery (FRU-523): each screen of the extension, built by its own view of `src/`
 * with made-up data. The gallery is served over https, where the widget of Fruitback can run: the
 * pages of the extension itself are `chrome-extension://`, where no widget runs.
 *
 * A view that the entrypoint builds itself (the options page, the rule editor of the popup) is not
 * here: it has no function to call.
 */
export type Surface = 'popup' | 'welcome' | 'panel';
export type GalleryState = { id: string; title: string; build: (document: Document) => HTMLElement };

const nothing = () => undefined;
const account: Account = { name: 'Ana Duval', email: 'ana@acme.dev', console: 'https://app.fruitback.com' };
const SITE = 'https://staging.acme.dev';

function popupStates(): GalleryState[] {
  const base = { onSettings: nothing };
  const on = {
    origin: SITE,
    workspace: 'Acme',
    shortcut: ['⌥', '⇧', 'F'],
    account,
    onToggle: nothing,
    onLeaveFeedback: nothing,
    onOpenPanel: nothing,
    onSettings: nothing,
  };
  const turnOn = { origin: SITE, visibility: 'members' as const, account, onTurnOn: nothing, onSettings: nothing };

  return [
    { id: 'loading', title: 'Loading', build: (d) => loading(d, base) },
    {
      id: 'signed-out',
      title: 'Signed out',
      build: (d) => signedOut(d, { ...base, canSignIn: true, onSignIn: nothing }),
    },
    {
      id: 'signed-out-ended',
      title: 'Signed out · the sign-in ended',
      build: (d) => signedOut(d, { ...base, canSignIn: true, ended: true, onSignIn: nothing }),
    },
    {
      id: 'signed-out-self-hosted',
      title: 'Signed out · a build with no Fruitback Cloud',
      build: (d) => signedOut(d, { ...base, canSignIn: false, onSignIn: nothing }),
    },
    ...(['refused', 'expired', 'unavailable', 'untrusted', 'blocked'] as const).map((stop) => ({
      id: `sign-in-${stop}`,
      title: `Sign-in stopped · ${stop}`,
      build: (d: Document) => signedOut(d, { ...base, canSignIn: true, stop: signInStop(stop), onSignIn: nothing }),
    })),
    {
      id: 'connecting',
      title: 'Connecting · the word to check',
      build: (d) => connecting(d, { ...base, word: 'PLUM 42', onStartAgain: nothing }),
    },
    {
      id: 'connecting-unanswered',
      title: 'Connecting · Fruitback did not answer',
      build: (d) => connecting(d, { ...base, word: 'PLUM 42', unanswered: true, onStartAgain: nothing }),
    },
    {
      id: 'not-web',
      title: 'Not a web page',
      build: (d) => notAWebPage(d, { ...base, account, shortcut: ['⌥', '⇧', 'F'] }),
    },
    {
      id: 'not-web-no-keys',
      title: 'Not a web page · no keys set',
      build: (d) => notAWebPage(d, { ...base, account }),
    },
    {
      id: 'unreachable',
      title: 'Fruitback cannot be reached',
      build: (d) =>
        problem(d, {
          ...base,
          account,
          title: "Fruitback can't reach api.fruitback.com",
          text: 'Check the connection, then try again.',
          primary: { label: 'Try again', onClick: nothing },
        }),
    },
    {
      id: 'no-access',
      title: 'Site on · the browser removed its access',
      build: (d) =>
        problem(d, {
          ...base,
          account,
          site: SITE,
          title: "Fruitback can't open this page",
          text: 'Access to staging.acme.dev was removed in your browser settings. Your notes are safe.',
          primary: { label: 'Allow access again', onClick: nothing },
          secondary: { label: 'Turn off for this site', onClick: nothing },
        }),
    },
    {
      id: 'turn-on-workspace',
      title: 'Turn on · a site of the workspace, off here',
      build: (d) =>
        turnOnScreen(d, { ...turnOn, workspace: 'Acme', destination: 'Linear · Acme web', onChange: nothing }),
    },
    {
      id: 'turn-on-new-site',
      title: 'Turn on · a site of no workspace',
      build: (d) => turnOnScreen(d, { ...turnOn, workspaces: [{ id: 'acme', name: 'Acme' }] }),
    },
    {
      id: 'turn-on-pick-workspace',
      title: 'Turn on · a site of no workspace, two workspaces',
      build: (d) =>
        turnOnScreen(d, {
          ...turnOn,
          workspaces: [
            { id: 'acme', name: 'Acme' },
            { id: 'northwind', name: 'Northwind' },
          ],
        }),
    },
    {
      id: 'turn-on-choices',
      title: 'Turn on · an admin chooses where notes go',
      build: (d) =>
        turnOnScreen(d, {
          ...turnOn,
          workspace: 'Acme',
          choices: {
            sources: { '': [] },
            place: null,
            loadOffer: async () => undefined,
            onVisibility: async () => true,
            onPlace: async () => true,
          },
        }),
    },
    {
      id: 'turn-on-ask-admin',
      title: 'Turn on · nobody here can add the site',
      build: (d) => turnOnScreen(d, { ...turnOn, workspaces: [] }),
    },
    {
      id: 'site-on',
      title: 'Site on · with what waits',
      build: (d) =>
        siteOn(d, {
          ...on,
          on: true,
          visibility: { shown: true, onChange: nothing },
          facts: { destination: 'Linear · Acme web', toCheck: 2, open: 7 },
        }),
    },
    {
      id: 'site-on-quiet',
      title: 'Site on · nothing open',
      build: (d) => siteOn(d, { ...on, on: true, visibility: { shown: true, onChange: nothing }, facts: { open: 0 } }),
    },
    {
      id: 'site-on-reading',
      title: 'Site on · before the worker answers',
      build: (d) => siteOn(d, { ...on, on: true, visibility: { shown: true, onChange: nothing } }),
    },
    {
      id: 'site-hidden',
      title: 'Site on · hidden on this page',
      build: (d) => siteOn(d, { ...on, on: true, visibility: { shown: false, onChange: nothing } }),
    },
    { id: 'site-off', title: 'Site off', build: (d) => siteOn(d, { ...on, on: false }) },
  ];
}

function welcomeStates(): GalleryState[] {
  const signIn = (state: WelcomeSignIn) => ({
    openPopup: async () => undefined,
    signIn: { state, onSignIn: nothing, onStartAgain: nothing, onTurnOn: nothing, onOpen: nothing, onAddSite: nothing },
  });
  const signedIn = (more: Partial<Extract<WelcomeSignIn, { kind: 'signed-in' }>>): WelcomeSignIn => ({
    kind: 'signed-in',
    who: 'ana@acme.dev',
    ...more,
  });

  return [
    { id: 'signed-out', title: 'Signed out', build: (d) => welcomeScreen(d, signIn({ kind: 'signed-out' })) },
    {
      id: 'sign-in-refused',
      title: 'Sign-in stopped · refused',
      build: (d) => welcomeScreen(d, signIn({ kind: 'signed-out', stop: signInStop('refused') })),
    },
    {
      id: 'connecting',
      title: 'Connecting · the word to check',
      build: (d) => welcomeScreen(d, signIn({ kind: 'connecting', word: 'PLUM 42' })),
    },
    {
      id: 'connecting-unanswered',
      title: 'Connecting · Fruitback did not answer',
      build: (d) => welcomeScreen(d, signIn({ kind: 'connecting', word: 'PLUM 42', unanswered: true })),
    },
    {
      id: 'signed-in-reading',
      title: 'Signed in · reading the sites',
      build: (d) => welcomeScreen(d, signIn(signedIn({}))),
    },
    {
      id: 'signed-in-one-site',
      title: 'Signed in · one site to turn on',
      build: (d) => welcomeScreen(d, signIn(signedIn({ sites: [{ origin: SITE, on: false }] }))),
    },
    {
      id: 'signed-in-site-on',
      title: 'Signed in · the site is on',
      build: (d) => welcomeScreen(d, signIn(signedIn({ sites: [{ origin: SITE, on: true }] }))),
    },
    {
      id: 'signed-in-sites',
      title: 'Signed in · several sites',
      build: (d) =>
        welcomeScreen(
          d,
          signIn(
            signedIn({
              sites: [
                { origin: SITE, on: true },
                { origin: 'https://preview.acme.dev', on: false },
                { origin: 'https://northwind.example', on: false },
              ],
            }),
          ),
        ),
    },
    {
      id: 'signed-in-no-site',
      title: 'Signed in · no site yet',
      build: (d) => welcomeScreen(d, signIn(signedIn({ sites: [] }))),
    },
    {
      id: 'signed-in-unavailable',
      title: 'Signed in · Fruitback did not answer',
      build: (d) => welcomeScreen(d, signIn(signedIn({ sites: 'unavailable' }))),
    },
    {
      id: 'signed-in-problem',
      title: 'Signed in · the site could not be turned on',
      build: (d) =>
        welcomeScreen(
          d,
          signIn(
            signedIn({
              sites: [{ origin: SITE, on: false }],
              problem: 'The browser did not give access to this site.',
            }),
          ),
        ),
    },
    {
      id: 'self-hosted',
      title: 'A build with no Fruitback Cloud',
      build: (d) => welcomeScreen(d, { openPopup: async () => undefined }),
    },
  ];
}

const NOW = Date.parse('2026-10-30T10:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function note(id: string, more: Partial<PanelNote>): PanelNote {
  return {
    id,
    stage: 'new',
    note: '',
    createdAt: ago(3),
    updatedAt: ago(3),
    replies: [],
    canReply: true,
    placement: 'found',
    ...more,
  };
}

const NOTES: PanelNote[] = [
  note('n1', {
    number: 12,
    note: 'The price is hard to read on the dark card, and the discount badge covers it on mobile.',
    author: 'Ana Duval',
    mine: true,
  }),
  note('n2', {
    number: 9,
    stage: 'progress',
    stateName: 'In Progress',
    note: 'The button « Ajouter » jumps when the cart opens.',
    author: 'Marc Petit',
    replies: [{ author: 'Léa (dev)', body: 'On it, the animation moves the layout.', createdAt: ago(1) }],
  }),
  note('n3', {
    number: 7,
    stage: 'todo',
    note: 'The footer links are too close together on mobile.',
    author: 'Ana Duval',
    placement: 'approximate',
  }),
  note('n4', {
    number: 4,
    stage: 'done',
    stateName: 'Done',
    note: 'Typo in the hero: « formulles ».',
    author: 'Ana Duval',
    mine: true,
    updatedAt: ago(0.5),
  }),
  note('n5', {
    number: 2,
    stage: 'closed',
    note: 'The logo is blurry on retina screens.',
    author: 'Marc Petit',
    placement: 'detached',
    checked: { by: 'Ana Duval', at: ago(20) },
  }),
];

function panelStates(): GalleryState[] {
  const handlers = {
    onClose: nothing,
    onLeave: nothing,
    onTab: nothing,
    onToggle: nothing,
    onShow: nothing,
    onReplyOpen: nothing,
    onReplyInput: nothing,
    onReplySend: nothing,
    onReplyCancel: nothing,
    onRetry: nothing,
    onReload: nothing,
    onSettings: nothing,
    onVerdict: nothing,
    onSearch: nothing,
  };
  const panel =
    (state: PanelState, more: Partial<PanelOptions> = {}) =>
    (d: Document) =>
      panelPage(d, { ...handlers, state, tab: 'open', now: NOW, ...more });
  const onWith = (notes: PanelNotes): PanelState => ({
    kind: 'on',
    host: 'staging.acme.dev',
    where: 'Acme',
    notes,
  });
  const search: SearchState = { scope: 'page', q: '', stage: STAGE_FILTERS[0], pinsShown: true, path: '/' };
  const searchHandlers = {
    onScope: nothing,
    onQuery: nothing,
    onStage: nothing,
    onSiteNote: nothing,
    onSiteRetry: nothing,
    onMore: nothing,
    onPins: nothing,
  } as unknown as NonNullable<PanelOptions['search']>['handlers'];

  return [
    {
      id: 'not-on',
      title: 'Not on for this page',
      build: panel({ kind: 'not-on' }, { onOpenPopup: nothing }),
    },
    {
      id: 'not-on-toolbar',
      title: 'Not on for this page · the popup cannot open from here',
      build: panel({ kind: 'not-on' }),
    },
    {
      id: 'site-widget',
      title: 'The site runs its own Fruitback',
      build: panel({ kind: 'site-widget', host: 'acme.dev' }),
    },
    { id: 'reading', title: 'Reading the notes', build: panel(onWith('reading')) },
    { id: 'failed', title: 'The read failed', build: panel(onWith('failed')) },
    { id: 'reload', title: 'The page must be reloaded', build: panel(onWith('reload')) },
    { id: 'not-started', title: 'The widget did not start', build: panel(onWith('not-started')) },
    {
      id: 'signed-out',
      title: 'The session of the site ended',
      build: panel(onWith('signed-out'), { onOpenPopup: nothing }),
    },
    { id: 'empty', title: 'No note on this page', build: panel(onWith([])) },
    { id: 'open', title: 'Open notes', build: panel(onWith(NOTES)) },
    { id: 'open-row', title: 'Open notes · a row open', build: panel(onWith(NOTES), { open: 'n2' }) },
    {
      id: 'replying',
      title: 'Open notes · a reply being written',
      build: panel(onWith(NOTES), { open: 'n1', replying: { id: 'n1', text: 'Same on the light card.' } }),
    },
    { id: 'finished', title: 'Finished notes', build: panel(onWith(NOTES), { tab: 'finished' }) },
    {
      id: 'search',
      title: 'Search and options',
      build: panel(onWith(NOTES), { search: { state: search, handlers: searchHandlers } }),
    },
  ];
}

/** Every state of each surface, in the order the gallery shows them. */
export const GALLERY: Record<Surface, () => GalleryState[]> = {
  popup: popupStates,
  welcome: welcomeStates,
  panel: panelStates,
};
