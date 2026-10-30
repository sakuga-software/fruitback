import { DEMO_FILES, DEMO_SECONDS, demoLength } from './demo-video.ts';
import { t } from './i18n.ts';
import { alertBox, head, primaryButton, providerButton, secondaryButton } from './kit.ts';
import { type SignInStop, element, linkButton } from './popup-view.ts';

/**
 * The page that opens when the extension is installed (FRU-318).
 *
 * At install Chrome hides the icon in the menu of the extensions, and nothing said what comes next.
 * This page says it: pin Fruitback, then sign in.
 *
 * **The sign-in starts here** (FRU-482). The page is the tab that Chrome shows after the install, and
 * the popup on it offered no sign-in: the person read « click the icon » and found a dead end. The
 * way is the one of the popup (`connect.ts`): the extension asks, the console approves, the word is
 * compared. A build that names no Fruitback keeps the way to the popup.
 *
 * It is an extension page that `tabs.create` opens: no permission, and no entry in the manifest.
 */

/** A site of the workspaces of the account (FRU-483). `on`: a rule of this browser turns it on. */
export type WelcomeSite = { origin: string; on: boolean };

/**
 * Where the sign-in of the page is. `who`: the account, as the head of the popup names it. `sites`:
 * the sites of its workspaces, `unavailable` when Fruitback did not answer, absent while they are
 * read. `problem`: what stopped the last « Turn on ».
 */
export type WelcomeSignIn =
  | { kind: 'signed-out'; stop?: SignInStop }
  | { kind: 'connecting'; word: string; unanswered?: boolean }
  | { kind: 'signed-in'; who: string; sites?: readonly WelcomeSite[] | 'unavailable'; problem?: string };

export type WelcomeOptions = {
  /** Opens the popup of the extension. It rejects where the browser does not let a page open it. */
  openPopup: () => Promise<void>;
  /** `prefers-reduced-motion: reduce`: the demonstration waits for a press on « play » (FRU-531). */
  reducedMotion?: boolean;
  /** Absent in a build that names no Fruitback: the page then leads to the popup. */
  signIn?: {
    state: WelcomeSignIn;
    onSignIn: () => void;
    onStartAgain: () => void;
    /** Asks the browser for the site, turns it on, and opens it (FRU-483). */
    onTurnOn?: (origin: string) => void;
    /** Opens a site that is on already. */
    onOpen?: (origin: string) => void;
    /** The setup of the console, for an account whose workspaces have no site yet. */
    onAddSite?: () => void;
  };
};

/**
 * The page. With the sign-in, the sign-in comes first and the pin is a tip (FRU-484): nothing
 * between the install and the first note needs the pin. With no Fruitback to sign in to, the two
 * steps of before stay, as the popup is the way in.
 */
export function welcomeScreen(document: Document, options: WelcomeOptions): HTMLElement {
  document.title = t('Welcome to Fruitback');
  const root = element(document, 'main', '', 'welcome');
  const top = head(document);
  top.classList.add('welcome-head');

  const title = element(document, 'h1', t('Fruitback is installed'));
  const invited = element(
    document,
    'p',
    t('Invited by a client or a team? Use the email the invitation was sent to.'),
    'welcome-invited',
  );

  if (options.signIn !== undefined) {
    const lead = element(document, 'p', t('Sign in, then turn on a site your team reviews.'), 'lead');
    const tip = element(document, 'p', '', 'welcome-tip');
    tip.append(
      element(document, 'strong', t('Tip:')),
      ` ${t('Pin Fruitback to find it in the toolbar later: open the puzzle piece at the right of the address bar, then press the pin beside Fruitback.')}`,
    );
    root.append(top, title, lead, ...signInPart(document, options.signIn), demo(document, options), invited, tip);

    return root;
  }

  const lead = element(
    document,
    'p',
    t('Pin Fruitback, then sign in. It then works on every site your team reviews.'),
    'lead',
  );
  const steps = element(document, 'ol', '', 'welcome-steps');
  steps.append(
    step(
      document,
      t('Pin Fruitback'),
      t('Open the puzzle piece at the right of the address bar, then press the pin beside Fruitback.'),
    ),
    step(document, t('Sign in'), t('Click the Fruitback icon, then Sign in with email.')),
  );
  root.append(top, title, lead, steps, ...toThePopup(document, options.openPopup), demo(document, options), invited);

  return root;
}

/** A build that names no Fruitback: the popup holds the way in, to a server of one's own. */
function toThePopup(document: Document, openPopup: () => Promise<void>): HTMLElement[] {
  const said = element(document, 'p', '', 'welcome-hint');
  said.setAttribute('role', 'status');
  const open = primaryButton(document, t('Open Fruitback'), () => {
    said.textContent = '';
    void openPopup().catch(() => {
      said.textContent = t('Your browser did not open it from this page: click the Fruitback icon in the toolbar.');
    });
  });

  return [open, said];
}

function signInPart(document: Document, signIn: NonNullable<WelcomeOptions['signIn']>): HTMLElement[] {
  const { state } = signIn;
  if (state.kind === 'connecting') {
    const word = element(document, 'p', state.word, 'word');
    // Read out as it is written: « PLUM 47 », not a word of the language around it.
    word.lang = 'en';
    const waiting = element(
      document,
      'p',
      state.unanswered === true
        ? t('Fruitback did not answer. The page asks again.')
        : t('Waiting for you to connect in the tab…'),
      'lead',
    );
    waiting.setAttribute('role', 'status');
    const part = element(document, 'section', '', 'welcome-sign-in');
    part.append(
      element(document, 'h2', t('Check that the tab shows the same word')),
      word,
      waiting,
      linkButton(document, t('Start again'), signIn.onStartAgain),
    );

    return [part];
  }

  if (state.kind === 'signed-in') {
    const done = element(document, 'section', '', 'welcome-sign-in');
    const said = element(document, 'p', t('Signed in as {who}.', { who: state.who }), 'welcome-done');
    said.setAttribute('role', 'status');
    done.append(said, ...sitesPart(document, state, signIn));

    return [done];
  }

  const part = element(document, 'section', '', 'welcome-sign-in');
  if (state.stop !== undefined) part.append(alertBox(document, state.stop.title, state.stop.text));
  const others = element(document, 'div', '', 'method-row');
  others.append(
    providerButton(document, 'google', signIn.onSignIn),
    providerButton(document, 'github', signIn.onSignIn),
  );
  part.append(primaryButton(document, t('Sign in with email'), signIn.onSignIn), others);

  return [part];
}

/**
 * The sites to turn on (FRU-483): one site is the one button of the page, several are a list. The
 * browser asks for the access to the site at the click, for that site only.
 */
function sitesPart(
  document: Document,
  state: Extract<WelcomeSignIn, { kind: 'signed-in' }>,
  signIn: NonNullable<WelcomeOptions['signIn']>,
): HTMLElement[] {
  const { sites } = state;
  const elsewhere = () => [
    element(document, 'p', t('Open a site of your team, then click the Fruitback icon.'), 'lead'),
  ];
  if (sites === undefined) return [];
  if (sites === 'unavailable' || signIn.onTurnOn === undefined) return elsewhere();
  if (sites.length === 0) {
    const none = element(document, 'p', t('No site in your workspaces yet.'), 'lead');

    return signIn.onAddSite === undefined ? [none] : [none, primaryButton(document, t('Add a site'), signIn.onAddSite)];
  }

  const button = (site: WelcomeSite, main: boolean): HTMLButtonElement => {
    const host = new URL(site.origin).host;
    const label = site.on ? t('Open {site}', { site: host }) : t('Turn on {site}', { site: host });
    const act = () => (site.on ? signIn.onOpen?.(site.origin) : signIn.onTurnOn?.(site.origin));

    return main && !site.on ? primaryButton(document, label, act) : secondaryButton(document, label, act);
  };
  const part: HTMLElement[] = [];
  if (sites.length === 1) {
    part.push(button(sites[0] as WelcomeSite, true));
  } else {
    const list = element(document, 'ul', '', 'welcome-sites');
    for (const site of sites) {
      const row = element(document, 'li', '');
      row.append(button(site, false));
      list.append(row);
    }
    part.push(element(document, 'p', t('Turn on a site of your workspaces:'), 'lead'), list);
  }
  if (sites.some((site) => !site.on)) {
    part.push(element(document, 'p', t('Chrome asks for access to this site only.'), 'welcome-hint'));
  }
  if (state.problem !== undefined) {
    const problem = element(document, 'p', state.problem, 'problem');
    problem.setAttribute('role', 'alert');
    part.push(problem);
  }

  return part;
}

/**
 * The demonstration (FRU-531): a first note in 16/9, under what the page asks to do now, at the same
 * place in every state. It plays muted and in a loop, and waits behind its poster when the person
 * asked for less motion. The files are in the extension: nothing is fetched.
 */
function demo(document: Document, options: WelcomeOptions): HTMLElement {
  const figure = element(document, 'figure', '', 'welcome-demo');
  const video = document.createElement('video');
  video.setAttribute('poster', DEMO_FILES.poster);
  video.muted = true;
  // The attribute too: autoplay is allowed for a video that is muted from its markup.
  video.setAttribute('muted', '');
  video.loop = true;
  // The attribute, which every engine reads: Safari plays a video with none full screen.
  video.setAttribute('playsinline', '');
  video.controls = true;
  video.preload = options.reducedMotion === true ? 'none' : 'auto';
  video.autoplay = options.reducedMotion !== true;
  video.width = 480;
  video.height = 270;
  for (const [source, type] of [
    [DEMO_FILES.webm, 'video/webm'],
    [DEMO_FILES.mp4, 'video/mp4'],
  ] as const) {
    const each = document.createElement('source');
    each.src = source;
    each.type = type;
    video.append(each);
  }
  const caption = element(document, 'figcaption', t('A first note, from the click to the pin'));
  const length = element(document, 'span', demoLength(DEMO_SECONDS), 'welcome-demo-length');
  length.setAttribute('aria-label', t('{seconds} seconds', { seconds: DEMO_SECONDS }));
  caption.append(' · ', length);
  figure.append(video, caption);

  return figure;
}

function step(document: Document, name: string, text: string): HTMLLIElement {
  const item = element(document, 'li', '');
  item.append(element(document, 'strong', name), element(document, 'span', text));

  return item;
}
