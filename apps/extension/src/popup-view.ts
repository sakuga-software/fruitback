import { msg, t } from './i18n.ts';
import { primaryButton, secondaryButton, statusDrop, toggle } from './kit.ts';

/**
 * The parts of the popup of the mock-up of 2026-10-13 (FRU-251): the shell every screen shares, and
 * the screens of a sign-in. No `browser` here: the entrypoint binds what a click does, so every
 * screen is built and read under `node --test` (`popup-view.test.ts`, on happy-dom).
 *
 * The shell is a head (the logo, who is signed in, the gear), a body, and a foot. It is 360 px wide,
 * and its height follows the screen, as a popup of the browser does.
 */

/** Who is signed in, as the head and the foot say it. */
export type Account = { name: string; email?: string; console?: string };

export type ShellOptions = {
  account?: Account;
  onSettings: () => void;
  /** The foot: the account and the console when signed in, else what the screen gives. */
  foot?: HTMLElement;
};

/** The logo of Fruitback, the outlines of the mock-up, in the tokens of the page (`apps/console/app/logo.tsx`). */
const WORD =
  'M86.2 0V-520.7Q86.2 -575.9 106.6 -614.8Q127 -653.6 164.3 -674.4Q201.5 -695.1 251.9 -695.1Q278.2 -695.1 298.1 -691.8Q318.1 -688.5 330 -685.7V-552.9Q321.3 -554.9 310.8 -557Q300.3 -559.1 285.1 -559.1Q259.7 -559.1 246.3 -544.6Q232.8 -530.1 232.8 -498.5V0ZM319.4 -339.8H19.8V-473.8H319.4Z M488.4 -489.1 526.1 -353.7V0H380.1V-489.1ZM494 -273 468.9 -284V-397.3L478.5 -408.9Q490.2 -426.3 512.8 -447.9Q535.4 -469.6 565.6 -485.5Q595.7 -501.4 628 -501.4Q644.1 -501.4 657.1 -499.1Q670 -496.8 677.6 -491.8V-359.2H644.9Q580.8 -359.2 544.4 -338.5Q508 -317.7 494 -273Z M902.4 12.3Q848 12.3 814.3 -4.1Q780.6 -20.5 762.5 -48.5Q744.3 -76.6 737.6 -113.3Q730.8 -150 730.8 -190.8V-489.1H876.8V-199.3Q876.8 -158.1 893.8 -144.3Q910.7 -130.6 935.9 -130.6Q957.6 -130.6 979 -138.2Q1000.4 -145.8 1020.4 -160.6Q1040.4 -175.5 1056.2 -196.4L1081.2 -122.2H1040.2V-489.1H1186.8V0H1078.4L1048.3 -96.8L1098.3 -93Q1074 -64.8 1042.6 -40.6Q1011.1 -16.4 975.9 -2.1Q940.6 12.3 902.4 12.3Z M1429.1 0H1282.5V-489.1H1429.1Z M1743.7 8.4Q1662.7 8.4 1616.4 -31.9Q1570 -72.2 1570 -163.2V-483.1L1568.3 -489.1L1598.1 -606.5H1716V-195.2Q1716 -161 1732 -146.4Q1747.9 -131.9 1773.9 -131.9Q1789.2 -131.9 1802.4 -134.4Q1815.7 -137 1825.2 -140V-3.3Q1807.6 2.4 1788.1 5.4Q1768.7 8.4 1743.7 8.4ZM1493.9 -354.5V-489.1H1825.2V-354.5Z M2182.9 12.3Q2119.2 12.3 2071.3 -19.2Q2023.5 -50.6 1996.5 -108.4Q1969.6 -166.2 1969.6 -245Q1969.6 -327.8 1996 -385.1Q2022.3 -442.4 2069.9 -471.9Q2117.5 -501.4 2181.8 -501.4Q2248.1 -501.4 2299.2 -468.8Q2350.2 -436.1 2379.1 -378.3Q2407.9 -320.4 2407.9 -245Q2407.9 -170.1 2379.4 -111.8Q2350.8 -53.4 2300.3 -20.6Q2249.8 12.3 2182.9 12.3ZM1912.1 0V-681H2058.1V-353.3H2048.6V-124.7H2058.1L2021 0ZM2155.4 -125.4Q2200.4 -125.4 2229.9 -158.8Q2259.4 -192.3 2259.4 -245Q2259.4 -297.3 2229.9 -330.8Q2200.4 -364.3 2155.4 -364.3Q2110.9 -364.3 2080.9 -330.8Q2050.8 -297.3 2050.8 -244.6Q2050.8 -191.9 2080.9 -158.6Q2110.9 -125.4 2155.4 -125.4Z M2622.2 13.4Q2569.2 13.4 2528.8 -7.1Q2488.3 -27.7 2466 -64.9Q2443.6 -102.1 2443.6 -151.3Q2443.6 -202.7 2467.6 -239.4Q2491.6 -276 2532.3 -296Q2573 -316 2623.4 -316Q2695.6 -316 2741 -283.1Q2786.3 -250.2 2801 -187.8L2737.7 -199.2V-313.4Q2737.7 -340.4 2718.7 -360.4Q2699.6 -380.5 2658 -380.5Q2630.6 -380.5 2595.9 -373.7Q2561.3 -366.9 2523.6 -348.6L2481.1 -453.5Q2524.9 -475.2 2575.5 -488.3Q2626 -501.4 2678.8 -501.4Q2746.9 -501.4 2792.7 -477Q2838.6 -452.6 2861.4 -409Q2884.2 -365.3 2884.2 -307.1V0H2764.5L2735.6 -94.7L2801 -114.8Q2784.8 -54.7 2739.9 -20.6Q2695 13.4 2622.2 13.4ZM2667.5 -91.5Q2699.6 -91.5 2719.2 -108Q2738.8 -124.5 2738.8 -151.3Q2738.8 -178.5 2719.2 -194.8Q2699.6 -211.1 2667.5 -211.1Q2634.3 -211.1 2614.9 -194.8Q2595.6 -178.5 2595.6 -151.3Q2595.6 -124.5 2614.9 -108Q2634.3 -91.5 2667.5 -91.5Z M3192.3 12.3Q3117.3 12.3 3060.9 -20.8Q3004.5 -53.9 2973.3 -112Q2942.2 -170.1 2942.2 -245.1Q2942.2 -319.6 2973.3 -377.4Q3004.5 -435.3 3060.9 -468.3Q3117.3 -501.4 3192.3 -501.4Q3273.5 -501.4 3333.8 -461.2Q3394.1 -421 3420.1 -353L3287.6 -294.3Q3273.9 -325.5 3251 -342.7Q3228 -360 3192.7 -360Q3148.6 -360 3118.6 -329.3Q3088.5 -298.6 3088.5 -245.1Q3088.5 -191.1 3118.6 -160.7Q3148.6 -130.3 3192.7 -130.3Q3228 -130.3 3251 -147.3Q3273.9 -164.2 3287.6 -194.9L3420.1 -136.7Q3393.7 -69.3 3333 -28.5Q3272.4 12.3 3192.3 12.3Z M3572.8 -246V-264.5L3773.4 -489.1H3936.8L3715.3 -238.4L3711.4 -285.6L3941.7 0H3771.7ZM3472.1 -681H3617.2V0H3472.1Z';
const DROP = 'M1355.8 -489.1L1279.6 -565.3A107.7 107.7 0 1 1 1431.9 -565.3Z';

/** The gear of the mock-up, a drawing of its own (FRU-251): sixteen pixels in the button of 36. */
const GEAR =
  'M19.62 10.33 L22.10 10.60 L22.10 13.40 L19.62 13.67 L18.57 16.21 L20.13 18.16 L18.16 20.13 L16.21 18.57 L13.67 19.62 L13.40 22.10 L10.60 22.10 L10.33 19.62 L7.79 18.57 L5.84 20.13 L3.87 18.16 L5.43 16.21 L4.38 13.67 L1.90 13.40 L1.90 10.60 L4.38 10.33 L5.43 7.79 L3.87 5.84 L5.84 3.87 L7.79 5.43 L10.33 4.38 L10.60 1.90 L13.40 1.90 L13.67 4.38 L16.21 5.43 L18.16 3.87 L20.13 5.84 L18.57 7.79 Z M15.10 12 A3.1 3.1 0 1 0 8.90 12 A3.1 3.1 0 1 0 15.10 12 Z';

const SVG = 'http://www.w3.org/2000/svg';

export function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) node.className = className;

  return node;
}

function svg(
  document: Document,
  viewBox: string,
  paths: { d: string; className: string; evenodd?: boolean }[],
): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', viewBox);
  for (const { d, className, evenodd } of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    if (evenodd === true) path.setAttribute('fill-rule', 'evenodd');
    drawing.append(path);
  }

  return drawing;
}

/** The logo, a picture named « Fruitback ». */
export function logo(document: Document): SVGSVGElement {
  const drawing = svg(document, '19.8 -749.1 3921.9 762.5', [
    { d: WORD, className: 'logo-word' },
    { d: DROP, className: 'logo-drop' },
  ]);
  drawing.setAttribute('class', 'logo');
  drawing.setAttribute('role', 'img');
  drawing.setAttribute('aria-label', 'Fruitback');

  return drawing;
}

/** The first letter a person reads of a name: a letter or a digit, upper case; « ? » when there is none. */
export function initialOf(name: string): string {
  const letter = [...name.trim()].find((character) => /[\p{L}\p{N}]/u.test(character));

  return letter === undefined ? '?' : letter.toLocaleUpperCase();
}

/** Every screen of the popup, in its shell. */
export function shell(document: Document, options: ShellOptions, ...body: Node[]): HTMLElement {
  const root = element(document, 'div', '', 'popup');

  const head = element(document, 'div', '', 'popup-head');
  head.append(logo(document));
  if (options.account !== undefined) {
    const avatar = element(document, 'span', initialOf(options.account.name), 'avatar');
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', t('Signed in as {name}', { name: options.account.name }));
    head.append(avatar);
  }
  const gear = element(document, 'button', '', 'icon-button');
  gear.type = 'button';
  gear.setAttribute('aria-label', t('Settings and every site'));
  const drawing = svg(document, '0 0 24 24', [{ d: GEAR, className: 'gear', evenodd: true }]);
  drawing.setAttribute('aria-hidden', 'true');
  gear.append(drawing);
  gear.addEventListener('click', options.onSettings);
  head.append(gear);

  const main = element(document, 'div', '', 'popup-body');
  main.append(...body);
  root.append(head, main);

  const foot = options.foot ?? (options.account === undefined ? undefined : accountFoot(document, options.account));
  if (foot !== undefined) root.append(foot);

  return root;
}

/** The foot of a popup that is signed in: the address of the account, and the way to the console. */
export function accountFoot(document: Document, account: Account): HTMLElement {
  const foot = element(document, 'div', '', 'popup-foot');
  foot.classList.add('popup-foot-account');
  // A person signed in by a name only has no address: the name says who it is.
  foot.append(element(document, 'span', account.email ?? account.name, 'who'));
  if (account.console !== undefined) {
    const link = element(document, 'a', t('Open the console'));
    link.href = account.console;
    link.target = '_blank';
    link.rel = 'noreferrer';
    foot.append(link);
  }

  return foot;
}

/** The host of the tab, which every screen of a site starts with. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A main action of the popup: the main button of the kit (FRU-293), 46 px, the corner of 10 px. */
export function action(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = primaryButton(document, label, onClick);
  button.classList.add('action');

  return button;
}

/** A link that reads as a link and is a button: it does something here, it opens no page. */
export function linkButton(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = element(document, 'button', label, 'link-button');
  button.type = 'button';
  button.addEventListener('click', onClick);

  return button;
}

export type SignedOutOptions = {
  origin: string;
  /** No Fruitback to sign in to in this build: the popup sends to the settings alone. */
  canSignIn: boolean;
  /** The session of the account ended: expired, or signed out from the console. */
  ended?: boolean;
  onSignIn: () => void;
  onSettings: () => void;
};

/** 05: nobody is signed in, and no rule covers this site. */
export function signedOut(document: Document, options: SignedOutOptions): HTMLElement {
  const foot = element(document, 'div', `${t('Running your own Fruitback?')} `, 'popup-foot');
  foot.append(linkButton(document, t('Connect it in settings'), options.onSettings));

  return shell(
    document,
    { onSettings: options.onSettings, foot },
    element(document, 'p', hostOf(options.origin), 'host'),
    ...(options.ended === true
      ? [
          element(document, 'h1', t('Your sign-in ended')),
          element(document, 'p', t('Sign in again to see and leave notes here.'), 'lead'),
        ]
      : [
          element(document, 'h1', t('Sign in to see and leave notes here')),
          element(
            document,
            'p',
            t(
              'One account for the console and this extension. The sign-in opens in a tab, and this popup picks it up by itself.',
            ),
            'lead',
          ),
        ]),
    ...(options.canSignIn ? [action(document, t('Sign in to Fruitback'), options.onSignIn)] : []),
  );
}

export type ConnectingOptions = {
  origin: string;
  word: string;
  /** The last claim got no answer: the popup says so, and asks again. */
  unanswered?: boolean;
  onStartAgain: () => void;
  onSettings: () => void;
};

/** A sign-in that waits for the console: the word to check, and the way to start again. */
export function connecting(document: Document, options: ConnectingOptions): HTMLElement {
  const word = element(document, 'p', options.word, 'word');
  // Read out as it is written: « PLUM 47 », not a word of the language around it.
  word.lang = 'en';
  const waiting = element(
    document,
    'p',
    options.unanswered === true
      ? t('Fruitback did not answer. The popup asks again.')
      : t('Waiting for you to connect in the tab…'),
    'lead',
  );
  // Said once, when the screen comes: a screen reader is not told the same sentence at every claim.
  waiting.setAttribute('role', 'status');

  return shell(
    document,
    { onSettings: options.onSettings },
    element(document, 'p', hostOf(options.origin), 'host'),
    element(document, 'h1', t('Check that the tab shows the same word')),
    word,
    waiting,
    linkButton(document, t('Start again'), options.onStartAgain),
  );
}

export type SignInProblemOptions = {
  origin: string;
  problem: 'refused' | 'expired' | 'unavailable' | 'untrusted' | 'blocked';
  onSignIn: () => void;
  onSettings: () => void;
};

/** What became of a sign-in that did not finish, and the one thing to do: sign in again. */
export function signInProblem(document: Document, options: SignInProblemOptions): HTMLElement {
  const said = {
    refused: [t('The sign-in did not finish.'), t('It was refused in the console.')],
    expired: [t('The sign-in did not finish.'), t('The tab was not approved in time.')],
    unavailable: [t('Fruitback did not answer.'), t('Check the connection, then try again.')],
    untrusted: [t('The sign-in did not start.'), t('Fruitback named a console that is not its own.')],
    blocked: [t('The sign-in did not start.'), t('The browser did not give the extension access to Fruitback.')],
  }[options.problem];
  const sentence = element(document, 'p', said[1] ?? '', 'lead');
  sentence.setAttribute('role', 'alert');

  return shell(
    document,
    { onSettings: options.onSettings },
    element(document, 'p', hostOf(options.origin), 'host'),
    element(document, 'h1', said[0] ?? ''),
    sentence,
    action(document, options.problem === 'unavailable' ? t('Try again') : t('Sign in to Fruitback'), options.onSignIn),
  );
}

/** A page the extension cannot run on: a `chrome://` page, the store, a PDF. Nothing is wrong. */
export function notAWebPage(document: Document, options: { onSettings: () => void; account?: Account }): HTMLElement {
  return shell(
    document,
    { onSettings: options.onSettings, ...(options.account === undefined ? {} : { account: options.account }) },
    element(document, 'h1', t('Fruitback works on http and https pages.')),
  );
}

/** While the popup reads what it needs: nothing to press yet, and a screen reader is told why. */
export function loading(document: Document, options: { onSettings: () => void }): HTMLElement {
  const said = element(document, 'p', t('Loading…'), 'lead');
  said.setAttribute('role', 'status');

  return shell(document, { onSettings: options.onSettings }, said);
}

/** The five stages, in the order of the mock-up, with the word of each (the widget's own words). */
const STAGE_WORDS = [
  ['seeded', msg('New')],
  ['green', msg('To do')],
  ['ripening', msg('In progress')],
  ['ripe', msg('Done')],
  ['composted', msg('Closed')],
] as const;

export type Counts = Record<(typeof STAGE_WORDS)[number][0], number>;

function total(counts: Counts): number {
  return STAGE_WORDS.reduce((sum, [stage]) => sum + counts[stage], 0);
}

/** « 3 new, 2 to do, 4 in progress, 2 done, 1 closed »: the name of the bar, and its caption. */
export function countsSentence(counts: Counts, separator: string): string {
  return STAGE_WORDS.map(([stage, word]) => `${counts[stage]} ${t(word).toLocaleLowerCase()}`).join(separator);
}

export type SiteInWorkspaceOptions = {
  origin: string;
  workspace: string;
  visibility: 'members' | 'everyone';
  /** The counts of the site (FRU-237), when Fruitback gave them. */
  counts?: Counts;
  /** « Chrome », « Firefox »: the browser that asks for the access. */
  browserName: string;
  account?: Account;
  onTurnOn: () => void;
  onSettings: () => void;
};

/** 06: a site of a workspace of the account, not turned on in this browser. One click. */
export function siteInWorkspace(document: Document, options: SiteInWorkspaceOptions): HTMLElement {
  const heading = element(document, 'div', '', 'site-heading');
  heading.append(
    element(document, 'h1', hostOf(options.origin)),
    element(
      document,
      'p',
      options.visibility === 'everyone'
        ? t('In {workspace} · everyone sees the notes', { workspace: options.workspace })
        : t('In {workspace} · members see the notes', { workspace: options.workspace }),
      'subtitle',
    ),
  );

  const body: Node[] = [heading];
  if (options.counts !== undefined) body.push(siteCounts(document, options.counts));

  const act = element(document, 'div', '', 'action-block');
  act.append(
    action(document, t('Turn on here'), options.onTurnOn),
    element(document, 'p', t('{browser} asks for access to this site only.', { browser: options.browserName }), 'note'),
  );
  body.push(act);

  return shell(
    document,
    { onSettings: options.onSettings, ...(options.account === undefined ? {} : { account: options.account }) },
    ...body,
  );
}

function siteCounts(document: Document, counts: Counts): HTMLElement {
  const block = element(document, 'div', '', 'site-counts');
  const all = total(counts);
  block.append(
    element(
      document,
      'p',
      all === 1 ? t('1 note waits on this site') : t('{count} notes wait on this site', { count: String(all) }),
      'site-total',
    ),
  );
  if (all > 0) {
    const bar = element(document, 'div', '', 'stage-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', countsSentence(counts, ', '));
    for (const [stage] of STAGE_WORDS) {
      if (counts[stage] === 0) continue;
      const segment = element(document, 'span', '', `stage-${stage}`);
      segment.style.flex = String(counts[stage]);
      bar.append(segment);
    }
    const detail = element(document, 'p', countsSentence(counts, ' · '), 'site-detail');
    // Said by the bar already: read once.
    detail.setAttribute('aria-hidden', 'true');
    block.append(bar, detail);
  }

  return block;
}

export type SiteOnOptions = {
  origin: string;
  workspace: string;
  on: boolean;
  /** What the widget of the tab shows now, or nothing when it did not say. */
  pageCounts?: Counts;
  account?: Account;
  onToggle: (on: boolean) => void;
  onLeaveFeedback: () => void;
  onShowEveryNote: () => void;
  onSettings: () => void;
};

/** 07: a site of a workspace, turned on here: the switch, the notes of the page, and two actions. */
export function siteOn(document: Document, options: SiteOnOptions): HTMLElement {
  const host = hostOf(options.origin);
  const titles = element(document, 'div', '', 'site-heading');
  titles.append(
    element(document, 'h1', host),
    element(
      document,
      'p',
      options.on
        ? t('On · {workspace}', { workspace: options.workspace })
        : t('Off · {workspace}', { workspace: options.workspace }),
      'subtitle',
    ),
  );
  const onOff = toggle(document, {
    checked: options.on,
    label: t('Fruitback on {host}', { host }),
    onChange: options.onToggle,
  });
  const row = element(document, 'div', '', 'site-row');
  row.append(titles, onOff);

  const body: Node[] = [row];
  // Off: the widget left the tab, so there is nothing of the page to count and nothing to ask of it.
  if (options.on) {
    if (options.pageCounts !== undefined) body.push(pageSection(document, options.pageCounts));
    const act = element(document, 'div', '', 'action-block');
    const every = secondaryButton(document, t('Show every note of the page'), options.onShowEveryNote);
    act.append(action(document, t('Leave feedback'), options.onLeaveFeedback), every);
    body.push(act);
  }

  const root = shell(
    document,
    { onSettings: options.onSettings, ...(options.account === undefined ? {} : { account: options.account }) },
    ...body,
  );
  root.classList.add('popup-site-on');

  return root;
}

/**
 * The notes of the page, added to a screen 07 already drawn (FRU-254): the popup does not wait for
 * the widget of the tab before it shows the switch. Nothing for a screen that is off, or that has them.
 */
export function showPageCounts(screen: HTMLElement, counts: Counts): void {
  const actions = screen.querySelector('.popup-body > .action-block');
  if (actions === null || screen.querySelector('.page-notes') !== null) return;
  actions.before(pageSection(screen.ownerDocument, counts));
}

function pageSection(document: Document, counts: Counts): HTMLElement {
  const section = element(document, 'section', '', 'page-notes');
  const title = element(document, 'h2', '');
  title.id = 'page-notes-title';
  section.setAttribute('aria-labelledby', title.id);
  const all = total(counts);
  title.append(
    element(document, 'span', t('On this page')),
    element(document, 'span', all === 1 ? t('1 note') : t('{count} notes', { count: String(all) }), 'page-total'),
  );
  const list = element(document, 'ul', '');
  for (const [stage, word] of STAGE_WORDS) {
    const item = element(document, 'li', '');
    const drop = statusDrop(document, { stage });
    const count = element(document, 'span', String(counts[stage]), 'count');
    // A zero in the muted grey, still at 5.28:1.
    count.classList.toggle('zero', counts[stage] === 0);
    item.append(drop, element(document, 'span', t(word), 'stage-word'), count);
    list.append(item);
  }
  section.append(title, list);

  return section;
}

export type NewSiteOptions = {
  origin: string;
  /** The workspaces where the account may add a site. None: the popup says who can. */
  workspaces: { id: string; name: string }[];
  browserName: string;
  account?: Account;
  onAdd: (workspace: string) => void;
  onSettings: () => void;
};

/** 08 (FRU-255): a site of no workspace of the account. Add it to one, and turn it on. */
export function newSite(document: Document, options: NewSiteOptions): HTMLElement {
  const heading = element(document, 'div', '', 'site-heading');
  heading.append(
    element(document, 'h1', hostOf(options.origin)),
    element(document, 'p', t('Not in a workspace yet'), 'subtitle'),
  );

  const [only] = options.workspaces;
  if (only === undefined) {
    return shell(
      document,
      { onSettings: options.onSettings, ...(options.account === undefined ? {} : { account: options.account }) },
      heading,
      element(document, 'p', t('Ask an admin of your workspace to add this site.'), 'lead'),
    );
  }

  const form = element(document, 'form', '', 'site-form');
  form.noValidate = true;
  let chosen = only;
  const fields: Node[] = [];
  // One workspace: no list, its name is in the button.
  if (options.workspaces.length > 1) {
    const label = element(document, 'label', t('Workspace'), 'field');
    const select = element(document, 'select', '');
    select.name = 'workspace';
    for (const workspace of options.workspaces) {
      const option = element(document, 'option', workspace.name);
      option.value = workspace.id;
      select.append(option);
    }
    label.append(select);
    fields.push(label);
    select.addEventListener('change', () => {
      chosen = options.workspaces.find((workspace) => workspace.id === select.value) ?? only;
      submit.textContent = addLabel(chosen.name);
    });
  }

  const submit = primaryButton(document, addLabel(only.name), undefined, { type: 'submit' });
  submit.classList.add('action');
  const act = element(document, 'div', '', 'action-block');
  act.append(
    submit,
    element(document, 'p', t('{browser} asks for access to this site only.', { browser: options.browserName }), 'note'),
  );
  form.append(
    element(
      document,
      'p',
      t(
        'Add it to review it. Nothing goes on the site: members with the extension see the notes, visitors see nothing.',
      ),
      'lead',
    ),
    ...fields,
    act,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    options.onAdd(chosen.id);
  });

  const root = shell(
    document,
    { onSettings: options.onSettings, ...(options.account === undefined ? {} : { account: options.account }) },
    heading,
    form,
  );
  root.classList.add('popup-new-site');

  return root;
}

function addLabel(workspace: string): string {
  return t('Add to {workspace} and turn on', { workspace });
}
