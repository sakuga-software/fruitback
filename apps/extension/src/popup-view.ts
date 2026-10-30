import { language, t } from './i18n.ts';
import {
  type Definition,
  alertBox,
  definitions,
  head,
  keys,
  listRow,
  primaryButton,
  providerButton,
  secondaryButton,
  siteLine,
  textButton,
  toggle,
} from './kit.ts';
import type { PlaceIds, Source, SourceOffer } from './cloud.ts';
import { option, placeChoice, shownChoice } from './place-choice.ts';

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
  screen?: 1 | 2 | 3 | 4;
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
    providerButton(document, 'google', options.onSignIn),
    providerButton(document, 'github', options.onSignIn),
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
    refused: [t('The sign-in did not finish.'), t('Someone declined it in the console. Sign in again to retry.')],
    expired: [t('The sign-in did not finish.'), t('The console did not approve it within 15 minutes. Sign in again.')],
    unavailable: [t('Fruitback could not be reached.'), t('Check the connection, then try again.')],
    untrusted: [
      t('The sign-in did not start.'),
      t('Fruitback named a console that is not its own. Tell the person who runs your Fruitback.'),
    ],
    blocked: [
      t('The sign-in did not start.'),
      t(
        'The browser did not give the extension access to Fruitback. Sign in again, and allow it when the browser asks.',
      ),
    ],
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

export type NotAWebPageOptions = {
  onSettings: () => void;
  account?: Account;
  /** The keys of « Leave feedback », as the browser has them. None: the step names the icon alone. */
  shortcut?: string[];
};

/**
 * 4, with nothing wrong (FRU-526): a page of the browser, the store, a PDF. No extension draws there,
 * so the screen says why, and what to do: open a site, then the icon or the keys of the person. It
 * says too that the sites and the notes did not change, since a person who sees « can't » fears so.
 */
export function notAWebPage(document: Document, options: NotAWebPageOptions): HTMLElement {
  const intro = element(document, 'div', '', 'intro');
  intro.append(
    element(document, 'h1', t("Fruitback can't run on this page")),
    element(
      document,
      'p',
      t(
        'This is a page of the browser, like a new tab, the settings, the extension store or a PDF. No extension can draw on it.',
      ),
      'lead',
    ),
  );
  const steps = element(document, 'ul', '', 'not-web-steps');
  const keyNames = options.shortcut ?? [];
  const press = element(document, 'li', '');
  if (keyNames.length > 0) {
    const [before, after] = t('There, click the Fruitback icon, or press {keys}.').split('{keys}');
    press.append(before ?? '', keys(document, keyNames), after ?? '');
  } else {
    press.textContent = t('There, click the Fruitback icon.');
  }
  steps.append(
    element(document, 'li', t('Open a site your team reviews.')),
    press,
    element(document, 'li', t('Nothing changed for your sites and your notes.')),
  );

  return shell(
    document,
    {
      onSettings: options.onSettings,
      screen: 4,
      ...(options.account === undefined ? {} : { account: options.account }),
    },
    intro,
    steps,
  );
}

/** While the popup reads what it needs: nothing to press yet, and a screen reader is told why. */
export function loading(document: Document, options: { onSettings: () => void }): HTMLElement {
  const said = element(document, 'p', t('Loading…'), 'lead');
  said.setAttribute('role', 'status');

  return shell(document, { onSettings: options.onSettings }, said);
}

/** « Who sees the notes », as the mock-up says each visibility. */
export function visibilityWords(visibility: 'members' | 'everyone'): string {
  return visibility === 'everyone' ? t('Everyone who visits the site') : t('Your team and invited guests');
}

export type TurnOnOptions = {
  origin: string;
  /** A site of a workspace that is not on in this browser: its workspace. None: a site of no workspace. */
  workspace?: string;
  /** Where its notes go (FRU-295), when the worker said. None: the line is not drawn. */
  destination?: string;
  visibility: 'members' | 'everyone';
  /**
   * A site of no workspace: the workspaces where the account may add it. None: the screen says who
   * can. More than one: a « Workspace » line with its list.
   */
  workspaces?: { id: string; name: string }[];
  account?: Account;
  /** « Change »: the site in the console. None: no « Change ». */
  onChange?: () => void;
  /**
   * FRU-453: the lines are choices, for a role that changes them. `sources` are the sources of each
   * workspace, by id (for a site of no workspace, the lists follow the workspace chosen). `place` is
   * where the notes go now: `null` for « Fruitback », absent when not known.
   */
  choices?: {
    sources: Record<string, Source[]>;
    workspace?: string;
    place?: PlaceIds | null;
    loadOffer: (workspace: string, connector: string) => Promise<SourceOffer | undefined>;
    /** Answers whether the change holds: `false` puts the list back as it was. */
    onVisibility: (visibility: 'members' | 'everyone') => Promise<boolean>;
    onPlace: (place: PlaceIds | null) => Promise<boolean>;
  };
  /** « Turn on », with the workspace chosen for a site of no workspace. */
  onTurnOn: (workspace?: string) => void;
  onSettings: () => void;
};

/**
 * « Who sees the notes » as a list of two (FRU-453). Each change goes to `onVisibility`; the
 * entrypoint says when the worker refused it.
 */
function visibilityChoice(
  document: Document,
  visibility: 'members' | 'everyone',
  onVisibility: (visibility: 'members' | 'everyone') => Promise<boolean>,
): HTMLSelectElement {
  const select = element(document, 'select', '');
  select.name = 'visibility';
  select.setAttribute('aria-label', t('Who sees the notes'));
  select.append(
    shownChoice(document),
    ...(['members', 'everyone'] as const).map((value) => option(document, value, visibilityWords(value))),
  );
  select.value = visibility;
  answered(select, () => onVisibility(select.value === 'everyone' ? 'everyone' : 'members'));

  return select;
}

/**
 * A list whose change the worker may refuse: it is off while the change is asked, and goes back to
 * what it was when the answer is `false`.
 */
function answered(select: HTMLSelectElement, change: () => Promise<boolean>): void {
  let held = select.value;
  select.addEventListener('change', () => {
    select.disabled = true;
    void change()
      .catch(() => false)
      .then((holds) => {
        if (holds) held = select.value;
        else select.value = held;
        select.disabled = false;
      });
  });
}

/**
 * 2 · Signed in, site not added (FRU-298): « Turn Fruitback on for this site? ». A site of a
 * workspace that is off in this browser, or a site of no workspace, which « Turn on » adds first.
 */
export function turnOnScreen(document: Document, options: TurnOnOptions): HTMLElement {
  const host = hostOf(options.origin);
  const site = siteLine(document, {
    host,
    state:
      options.workspace === undefined
        ? t('Not in your sites yet')
        : t('In {workspace} · not on in this browser', { workspace: options.workspace }),
    on: false,
  });
  const frame = (...body: Node[]): HTMLElement => {
    const root = shell(
      document,
      {
        onSettings: options.onSettings,
        screen: 2,
        ...(options.account === undefined ? {} : { account: options.account }),
      },
      ...body,
    );
    root.classList.add('popup-turn-on');

    return root;
  };

  const addable = options.workspaces ?? [];
  const [first] = addable;
  // A site of no workspace, and no workspace where the account may add it: who can, and nothing to press.
  if (options.workspace === undefined && first === undefined) {
    return frame(
      hostAsTitle(site),
      element(document, 'p', t('Ask an admin of your workspace to add this site.'), 'lead'),
    );
  }

  const change = (): HTMLButtonElement | undefined =>
    options.onChange === undefined ? undefined : textButton(document, t('Change'), options.onChange);
  const choices = options.choices;
  let chosen = first?.id;
  const entries: Definition[] = [];
  if (choices === undefined && options.destination !== undefined) {
    const where = change();
    entries.push({
      term: t('Notes go to'),
      value: options.destination,
      ...(where === undefined ? {} : { action: where }),
    });
  }
  if (choices === undefined) {
    const who = change();
    entries.push({
      term: t('Who sees the notes'),
      value: visibilityWords(options.visibility),
      ...(who === undefined ? {} : { action: who }),
    });
  }
  const facts = definitions(document, entries);
  /** A line of the list whose value is a field: a `select` in its `dd`. */
  const field = (term: string, input: HTMLElement): HTMLElement => {
    const entry = element(document, 'div', '', 'kit-dl-entry');
    const value = element(document, 'dd', '');
    value.append(input);
    entry.append(element(document, 'dt', term), value);

    return entry;
  };

  // FRU-453: the place, then who sees the notes, each a list. The places follow the workspace chosen.
  let refill: (() => void) | undefined;
  if (choices !== undefined) {
    const workspaceNow = (): string => chosen ?? choices.workspace ?? '';
    const place = placeChoice(document, {
      sources: () => choices.sources[workspaceNow()] ?? [],
      ...(choices.place === undefined ? {} : { place: choices.place }),
      loadOffer: (connector) => choices.loadOffer(workspaceNow(), connector),
      onPlace: choices.onPlace,
    });
    facts.append(
      ...place.entries,
      field(t('Who sees the notes'), visibilityChoice(document, options.visibility, choices.onVisibility)),
    );
    // Another workspace offers other sources: the lists are drawn again, with « Fruitback » chosen.
    refill = place.reset;
  }

  if (addable.length > 1) {
    const select = element(document, 'select', '');
    select.name = 'workspace';
    select.setAttribute('aria-label', t('Workspace'));
    select.append(shownChoice(document), ...addable.map((workspace) => option(document, workspace.id, workspace.name)));
    select.addEventListener('change', () => {
      chosen = select.value;
      refill?.();
    });
    facts.prepend(field(t('Workspace'), select));
  }

  const act = element(document, 'div', '', 'action-block');
  act.append(
    action(document, t('Turn on'), () => options.onTurnOn(options.workspace === undefined ? chosen : undefined)),
    element(document, 'p', t('Your browser will ask to allow this site once.'), 'note'),
  );

  return frame(site, element(document, 'h1', t('Turn Fruitback on for this site?')), facts, act);
}

/** What the worker says of a site that is on (FRU-295), read after the screen is drawn. */
export type SiteFacts = {
  /** « Linear · Northwind ». */
  destination?: string;
  /** The notes of the person the team marked done, not checked yet. */
  toCheck?: number;
  /** The notes of the site that are New, To do or In progress. */
  open?: number;
};

export type SiteOnOptions = {
  origin: string;
  workspace: string;
  on: boolean;
  /** The keys of « Leave feedback », as the browser has them. None: no line. */
  shortcut?: string[];
  facts?: SiteFacts;
  account?: Account;
  /** The foot, in place of the one of an account: a session of a pairing and its log out (FRU-319). */
  foot?: HTMLElement;
  onToggle: (on: boolean) => void;
  /**
   * « Show Fruitback on this page » (FRU-444), for a site that is on. Absent: shown, and no switch.
   * Hidden, the screen offers neither « Leave feedback » nor the side panel: the page has no widget.
   */
  visibility?: { shown: boolean; onChange: (shown: boolean) => void };
  onLeaveFeedback: () => void;
  /** Opens the side panel: « Show all notes in a sidebar », and a click on a line. */
  onOpenPanel: () => void;
  onSettings: () => void;
};

/**
 * The host of a screen with no other title, as its `h1` (axe `page-has-heading-one`): screen 3, and
 * screen 2 with nothing to turn on. It keeps the size of the host of the kit.
 */
function hostAsTitle(site: HTMLElement): HTMLElement {
  const host = site.querySelector('.kit-site-host');
  if (host === null) return site;
  const title = site.ownerDocument.createElement('h1');
  title.className = host.className;
  title.textContent = host.textContent;
  host.replaceWith(title);

  return site;
}

/** The state line of a site that is on: where its notes go, or its workspace. */
function onState(workspace: string, on: boolean, destination: string | undefined): string {
  if (!on) return t('Off · {workspace}', { workspace });
  // « Linear · Northwind » → « Linear »: the tracker, as the mock-up says it under the host.
  const tracker = destination?.split(' · ')[0]?.trim();

  return tracker === undefined || tracker === ''
    ? t('On · {workspace}', { workspace })
    : t('On · notes go to {tracker}', { tracker });
}

/**
 * « Show Fruitback on this page » (FRU-444): the words, and the switch they name. The rule stays on;
 * only this origin loses the widget, and gets it back with no prompt.
 */
export function visibilityRow(
  document: Document,
  options: { shown: boolean; onChange: (shown: boolean) => void },
): HTMLElement {
  const row = element(document, 'div', '', 'visibility-row');
  const words = element(document, 'span', t('Show Fruitback on this page'), 'visibility-words');
  // The visible words are the name of the switch, so a voice command says what it reads.
  words.setAttribute('aria-hidden', 'true');
  row.append(
    words,
    toggle(document, {
      checked: options.shown,
      label: t('Show Fruitback on this page'),
      onChange: options.onChange,
    }),
  );

  return row;
}

/** 3 · Site on (FRU-298): the switch, « Leave feedback », what waits, and the side panel. */
export function siteOn(document: Document, options: SiteOnOptions): HTMLElement {
  const host = hostOf(options.origin);
  const row = element(document, 'div', '', 'site-row');
  row.append(
    hostAsTitle(
      siteLine(document, {
        host,
        state: onState(options.workspace, options.on, options.facts?.destination),
        on: options.on,
      }),
    ),
    toggle(document, {
      checked: options.on,
      label: t('Fruitback on {host}', { host }),
      word: options.on ? t('On') : t('Off'),
      onChange: options.onToggle,
    }),
  );

  const body: Node[] = [row];
  if (options.on && options.visibility !== undefined) body.push(visibilityRow(document, options.visibility));
  // Off, or hidden here: the widget left the tab, so there is nothing to leave and nothing to show.
  if (options.on && options.visibility?.shown !== false) {
    // FRU-529: what waits stays under the site; « Leave feedback » goes to the bottom of the body,
    // with the side panel beside it as a square button of one icon, and the keys under both.
    const waiting = element(document, 'div', '', 'site-lines');
    const leave = element(document, 'div', '', 'leave-block');
    const actions = element(document, 'div', '', 'leave-row');
    const panel = secondaryButton(document, '', options.onOpenPanel);
    panel.classList.add('panel-button');
    panel.setAttribute('aria-label', t('Show all notes in a sidebar'));
    panel.title = t('Show all notes in a sidebar');
    panel.append(panelIcon(document));
    actions.append(primaryButton(document, t('Leave feedback'), options.onLeaveFeedback, { size: 'tall' }), panel);
    leave.append(actions);
    const keyNames = options.shortcut ?? [];
    if (keyNames.length > 0) {
      const [before, after] = t('or press {keys} on the page').split('{keys}');
      const line = element(document, 'p', '', 'shortcut-line');
      line.append(before ?? '', keys(document, keyNames), after ?? '');
      leave.append(line);
    }
    body.push(waiting, leave);
  }

  const root = shell(
    document,
    {
      onSettings: options.onSettings,
      screen: 3,
      ...(options.account === undefined ? {} : { account: options.account }),
      ...(options.foot === undefined ? {} : { foot: options.foot }),
    },
    ...body,
  );
  root.classList.add('popup-site-on');
  if (options.facts !== undefined) showSiteFacts(root, options, options.facts);

  return root;
}

/**
 * What the worker says of the site, added to a screen 3 already drawn: the popup does not wait for
 * the worker before it shows the switch. The state line names the tracker; « fixes to check » is
 * drawn above 0, « open notes » whenever it is known.
 */
export function showSiteFacts(
  screen: HTMLElement,
  options: Pick<SiteOnOptions, 'workspace' | 'on' | 'onOpenPanel'>,
  facts: SiteFacts,
): void {
  const document = screen.ownerDocument;
  const state = screen.querySelector('.kit-site-state');
  if (state !== null) state.textContent = onState(options.workspace, options.on, facts.destination);
  const lines = screen.querySelector('.site-lines');
  if (lines === null) return;
  const rows: HTMLElement[] = [];
  if (facts.toCheck !== undefined && facts.toCheck > 0) {
    rows.push(
      listRow(document, {
        title: plural(
          facts.toCheck,
          t('1 fix to check'),
          t('{count} fixes to check', { count: String(facts.toCheck) }),
        ),
        subtitle: t('Marked done by the team'),
        stage: 'done',
        onClick: options.onOpenPanel,
      }),
    );
  }
  if (facts.open !== undefined) {
    rows.push(
      listRow(document, {
        title:
          facts.open === 0
            ? t('No open note')
            : plural(facts.open, t('1 open note'), t('{count} open notes', { count: String(facts.open) })),
        subtitle: t('New, to do or in progress'),
        stage: 'progress',
        onClick: options.onOpenPanel,
      }),
    );
  }
  lines.replaceChildren(...rows);
}

/** One or many, by the rules of the language of the popup: « 1 fix », « 2 fixes ». */
function plural(count: number, one: string, other: string): string {
  return new Intl.PluralRules(language()).select(count) === 'one' ? one : other;
}

const SVG = 'http://www.w3.org/2000/svg';

/** The panel of « Show all notes in a sidebar », 20 px, in the colour of its button. */
function panelIcon(document: Document): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', 'panel-icon');
  const frame = document.createElementNS(SVG, 'rect');
  for (const [name, value] of [
    ['x', '2'],
    ['y', '3'],
    ['width', '12'],
    ['height', '10'],
    ['rx', '2'],
  ] as const) {
    frame.setAttribute(name, value);
  }
  const bar = document.createElementNS(SVG, 'path');
  bar.setAttribute('d', 'M6 3v10');
  for (const shape of [frame, bar]) {
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.4');
  }
  drawing.append(frame, bar);

  return drawing;
}

/**
 * The keys of a shortcut, as the kit draws them: `Alt+Shift+F` → Alt Shift F. Chrome on macOS writes
 * them with no `+`, a sign each (`⌥⇧F`): each sign is then a key of its own.
 */
export function keysOfShortcut(shortcut: string): string[] {
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut.replace(/\s+/gu, '')];

  return parts.map((key) => key.trim()).filter((key) => key !== '');
}
