import { msg, t } from './i18n.ts';
import { alertBox, head, primaryButton, secondaryButton, siteLine, statusDrop, toggle } from './kit.ts';

/**
 * The screens of the popup. The shell and the screens 1 and 4 are those of the mock-up of 2026-10-20
 * (FRU-297); the screens 2 and 3 are those of 2026-10-13 (FRU-251, FRU-254, FRU-255) until FRU-298.
 * No `browser` here: the entrypoint binds what a click does, so every screen is built and read under
 * `node --test` (`popup-view.test.ts`, on happy-dom).
 *
 * The shell is the head of the kit (the drop, « Fruitback », the button of the account), a body and
 * a foot. It is 380 px wide and at least 580 px tall, as the mock-up draws it, so the window does not
 * jump from one screen to the next.
 */

/** Who is signed in, as the head and the foot say it. */
export type Account = { name: string; email?: string; console?: string };

export type ShellOptions = {
  account?: Account;
  /** The button of the account opens the page of the extension. */
  onSettings: () => void;
  /** The foot: the account and the console when signed in, else what the screen gives. */
  foot?: HTMLElement;
  /** Screen 1 has no button of the account: its foot leads to the page of the extension. */
  accountButton?: boolean;
  /** The screen of the mock-up the shell holds, for its measures. */
  screen?: 1 | 4;
};

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

/** Every screen of the popup, in its shell. */
export function shell(document: Document, options: ShellOptions, ...body: Node[]): HTMLElement {
  const root = element(document, 'div', '', 'popup');
  if (options.screen !== undefined) root.classList.add(`popup-screen-${options.screen}`);

  const top = head(
    document,
    options.accountButton === false
      ? {}
      : {
          ...(options.account === undefined ? {} : { account: { name: options.account.name } }),
          onAccount: options.onSettings,
        },
  );
  top.classList.add('popup-head');

  const main = element(document, 'div', '', 'popup-body');
  main.append(...body);
  root.append(top, main);

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

/** What a sign-in that did not finish says, above the ways to sign in again. */
export type SignInStop = { title: string; text: string };

export type SignedOutOptions = {
  /** No Fruitback to sign in to in this build: the popup leads to the page of the extension alone. */
  canSignIn: boolean;
  /** The session of the account ended: expired, or signed out from the console. */
  ended?: boolean;
  /** A sign-in that did not finish: said in an alert, above the ways to sign in again. */
  stop?: SignInStop;
  onSignIn: () => void;
  onSettings: () => void;
};

/**
 * 1 · Signed out (FRU-297). E-mail, Google and GitHub all start the sign-in of the console, which
 * offers its own methods: the extension has no surface of authentication of its own.
 */
export function signedOut(document: Document, options: SignedOutOptions): HTMLElement {
  const intro = element(document, 'div', '', 'intro');
  intro.append(
    element(
      document,
      'h1',
      options.ended === true ? t('Your sign-in ended') : t('Comment on any website, right on the page'),
    ),
    element(
      document,
      'p',
      options.ended === true
        ? t('Sign in again to see and leave notes here.')
        : t('Sign in once. Fruitback then works on every site your team reviews.'),
      'lead',
    ),
  );
  const body: Node[] = [intro];
  if (options.stop !== undefined) body.push(alertBox(document, options.stop.title, options.stop.text));

  const own = t('Use your own Fruitback server');
  if (!options.canSignIn) {
    // A build made for a self-hosted instance: the one way in is the page of the extension.
    body.push(primaryButton(document, own, options.onSettings));

    return shell(document, { onSettings: options.onSettings, accountButton: false, screen: 1 }, ...body);
  }

  const methods = element(document, 'div', '', 'methods');
  const others = element(document, 'div', '', 'method-row');
  others.append(
    secondaryButton(document, 'Google', options.onSignIn),
    secondaryButton(document, 'GitHub', options.onSignIn),
  );
  methods.append(primaryButton(document, t('Sign in with email'), options.onSignIn), others);
  const invited = element(document, 'div', '', 'invited');
  invited.append(
    element(document, 'span', t('Invited by a client or a team?')),
    element(document, 'span', t('Use the email the invitation was sent to.')),
  );
  body.push(methods, invited);

  const foot = element(document, 'div', '', 'popup-foot');
  foot.append(linkButton(document, own, options.onSettings));

  return shell(document, { onSettings: options.onSettings, accountButton: false, foot, screen: 1 }, ...body);
}

export type ConnectingOptions = {
  word: string;
  /** The last claim got no answer: the popup says so, and asks again. */
  unanswered?: boolean;
  onStartAgain: () => void;
  onSettings: () => void;
};

/** 1, while the console has not answered: the word to check, and the way to start again. */
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
    { onSettings: options.onSettings, accountButton: false, screen: 1 },
    element(document, 'h1', t('Check that the tab shows the same word')),
    word,
    waiting,
    linkButton(document, t('Start again'), options.onStartAgain),
  );
}

export type SignInProblem = 'refused' | 'expired' | 'unavailable' | 'untrusted' | 'blocked';

/** What stopped a sign-in, in two sentences: the title of the alert, and its words. */
export function signInStop(problem: SignInProblem): SignInStop {
  const said: Record<SignInProblem, [string, string]> = {
    refused: [t('The sign-in did not finish.'), t('It was refused in the console.')],
    expired: [t('The sign-in did not finish.'), t('The tab was not approved in time.')],
    unavailable: [t('Fruitback did not answer.'), t('Check the connection, then try again.')],
    untrusted: [t('The sign-in did not start.'), t('Fruitback named a console that is not its own.')],
    blocked: [t('The sign-in did not start.'), t('The browser did not give the extension access to Fruitback.')],
  };
  const [title, text] = said[problem];

  return { title, text };
}

export type ProblemOptions = {
  /** The site the problem is about: its tile, its host, and « Paused ». */
  site?: string;
  title: string;
  text?: string;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  account?: Account;
  onSettings: () => void;
};

/** 4 · A problem, with its fix (FRU-297): what is wrong in an alert, and what to do at the foot. */
export function problem(document: Document, options: ProblemOptions): HTMLElement {
  const body: Node[] = [];
  if (options.site !== undefined) {
    body.push(siteLine(document, { host: hostOf(options.site), state: t('Paused'), on: true, paused: true }));
  }
  body.push(alertBox(document, options.title, options.text ?? ''));
  if (options.primary !== undefined || options.secondary !== undefined) {
    const act = element(document, 'div', '', 'action-block');
    if (options.primary !== undefined) {
      act.append(primaryButton(document, options.primary.label, options.primary.onClick));
    }
    if (options.secondary !== undefined) {
      act.append(secondaryButton(document, options.secondary.label, options.secondary.onClick));
    }
    body.push(act);
  }

  return shell(
    document,
    {
      onSettings: options.onSettings,
      screen: 4,
      ...(options.account === undefined ? {} : { account: options.account }),
    },
    ...body,
  );
}

/** 4, with nothing wrong: a `chrome://` page, the store, a PDF. Nothing can run there, and no button. */
export function notAWebPage(document: Document, options: { onSettings: () => void; account?: Account }): HTMLElement {
  return shell(
    document,
    {
      onSettings: options.onSettings,
      screen: 4,
      ...(options.account === undefined ? {} : { account: options.account }),
    },
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
