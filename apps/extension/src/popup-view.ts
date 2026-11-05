import { language, t } from './i18n.ts';
import {
  type Definition,
  alertBox,
  button,
  definitions,
  dropMark,
  head,
  helpLink,
  hostOf,
  keys,
  linkButton,
  make,
  type MenuItem,
  menuButton,
  primaryButton,
  providerButton,
  secondaryButton,
  siteLine,
  textButton,
} from './kit.ts';
import type { DestinationKind, PlaceIds, Source, SourceOffer } from './cloud.ts';
import { type Help, howItWorks, whoCanAdd } from './guide.ts';
import { option, placeChoice, shownChoice, sourceMark } from './place-choice.ts';
import { CARET, DOTS, EYE, EYE_SLASH, ON, PANEL, PENCIL } from './popup-icons.ts';

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

/** Every screen of the popup, in its shell. */
export function shell(document: Document, options: ShellOptions, ...body: Node[]): HTMLElement {
  const root = make(document, 'div', 'popup');
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

  const main = make(document, 'div', 'popup-body');
  main.append(...body);
  root.append(top, main);

  const foot = options.foot ?? (options.account === undefined ? undefined : accountFoot(document, options.account));
  if (foot !== undefined) root.append(foot);

  return root;
}

/** The foot of a popup that is signed in: the address of the account, and the way to the console. */
export function accountFoot(document: Document, account: Account): HTMLElement {
  const foot = make(document, 'div', 'popup-foot');
  foot.classList.add('popup-foot-account');
  // A person signed in by a name only has no address: the name says who it is.
  foot.append(make(document, 'span', 'who', account.email ?? account.name));
  if (account.console !== undefined) {
    const link = make(document, 'a', '', t('Open the console'));
    link.href = account.console;
    link.target = '_blank';
    link.rel = 'noreferrer';
    foot.append(link);
  }

  return foot;
}

/** A main action of the popup: the main button of the kit (FRU-293), 46 px, the corner of 10 px. */
export function action(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = primaryButton(document, label, onClick);
  button.classList.add('action');

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
  const intro = make(document, 'div', 'intro');
  intro.append(
    make(
      document,
      'h1',
      '',
      options.ended === true ? t('Your sign-in ended') : t('Comment on any website, right on the page'),
    ),
    make(
      document,
      'p',
      'lead',
      options.ended === true
        ? t('Sign in again to see and leave notes here.')
        : t('Sign in once. Fruitback then works on every site your team reviews.'),
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

  const methods = make(document, 'div', 'methods');
  const others = make(document, 'div', 'method-row');
  others.append(
    providerButton(document, 'google', options.onSignIn),
    providerButton(document, 'github', options.onSignIn),
  );
  methods.append(primaryButton(document, t('Sign in with email'), options.onSignIn), others);
  const invited = make(document, 'div', 'invited');
  invited.append(
    make(document, 'span', '', t('Invited by a client or a team?')),
    make(document, 'span', '', t('Use the email the invitation was sent to.')),
  );
  body.push(methods, invited);

  const foot = make(document, 'div', 'popup-foot');
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
  const word = make(document, 'p', 'word', options.word);
  // Read out as it is written: « PLUM 47 », not a word of the language around it.
  word.lang = 'en';
  const waiting = make(
    document,
    'p',
    'lead',
    options.unanswered === true
      ? t('Fruitback did not answer. The popup asks again.')
      : t('Waiting for you to connect in the tab…'),
  );
  // Said once, when the screen comes: a screen reader is not told the same sentence at every claim.
  waiting.setAttribute('role', 'status');

  return shell(
    document,
    { onSettings: options.onSettings, accountButton: false, screen: 1 },
    make(document, 'h1', '', t('Check that the tab shows the same word')),
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
  /** The section of the guide that says what to check (FRU-528): a button under the actions. */
  help?: Help;
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
    const act = make(document, 'div', 'action-block');
    if (options.primary !== undefined) {
      act.append(primaryButton(document, options.primary.label, options.primary.onClick));
    }
    if (options.secondary !== undefined) {
      act.append(secondaryButton(document, options.secondary.label, options.secondary.onClick));
    }
    body.push(act);
  }
  if (options.help !== undefined) body.push(helpLink(document, options.help));

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
  /** The keys of « Leave a note », as the browser has them. None: the step names the icon alone. */
  shortcut?: string[];
};

/**
 * 4, with nothing wrong (FRU-526): a page of the browser, the store, a PDF. No extension draws there,
 * so the screen says why, and what to do: open a site, then the icon or the keys of the person. It
 * says too that the sites and the notes did not change, since a person who sees « can't » fears so.
 */
export function notAWebPage(document: Document, options: NotAWebPageOptions): HTMLElement {
  const intro = make(document, 'div', 'intro');
  intro.append(
    make(document, 'h1', '', t("Fruitback can't run on this page")),
    make(
      document,
      'p',
      'lead',
      t(
        'This is a page of the browser, like a new tab, the settings, the extension store or a PDF. No extension can draw on it.',
      ),
    ),
  );
  const steps = make(document, 'ul', 'not-web-steps');
  const keyNames = options.shortcut ?? [];
  const press = make(document, 'li', '');
  if (keyNames.length > 0) {
    const [before, after] = t('There, click the Fruitback icon, or press {keys}.').split('{keys}');
    press.append(before ?? '', keys(document, keyNames), after ?? '');
  } else {
    press.textContent = t('There, click the Fruitback icon.');
  }
  steps.append(
    make(document, 'li', '', t('Open a site your team reviews.')),
    press,
    make(document, 'li', '', t('Nothing changed for your sites and your notes.')),
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
    helpLink(document, howItWorks()),
  );
}

/** While the popup reads what it needs: nothing to press yet, and a screen reader is told why. */
export function loading(document: Document, options: { onSettings: () => void }): HTMLElement {
  const said = make(document, 'p', 'lead', t('Loading…'));
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
  /** The provider of `destination`, when the worker named it (FRU-554). None: read from the label. */
  destinationKind?: DestinationKind;
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
  /**
   * A site of no workspace that the popup cannot add (FRU-537): why, in place of « ask an admin »,
   * and nothing to press.
   */
  unaddable?: string;
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
  const select = make(document, 'select', '');
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
  if (options.workspace === undefined && options.unaddable !== undefined) {
    return frame(hostAsTitle(site), make(document, 'p', 'lead', options.unaddable));
  }
  if (options.workspace === undefined && first === undefined) {
    return frame(
      hostAsTitle(site),
      make(document, 'p', 'lead', t('Ask an admin of your workspace to add this site.')),
      helpLink(document, whoCanAdd()),
    );
  }

  const change = (): HTMLButtonElement | undefined =>
    options.onChange === undefined ? undefined : textButton(document, t('Change'), options.onChange);
  const choices = options.choices;
  let chosen = first?.id;
  const entries: Definition[] = [];
  // FRU-530: the line of « Notes go to » with the mark of its provider, as on a site that is on.
  const destination =
    choices === undefined && options.destination !== undefined
      ? destinationEntry(document, options.destination, change(), options.destinationKind)
      : undefined;
  if (choices === undefined) {
    const who = change();
    entries.push({
      term: t('Who sees the notes'),
      value: visibilityWords(options.visibility),
      ...(who === undefined ? {} : { action: who }),
    });
  }
  const facts = definitions(document, entries);
  if (destination !== undefined) facts.prepend(destination);
  /** A line of the list whose value is a field: a `select` in its `dd`. */
  const field = (term: string, input: HTMLElement): HTMLElement => {
    const entry = make(document, 'div', 'kit-dl-entry');
    const value = make(document, 'dd', '');
    value.append(input);
    entry.append(make(document, 'dt', '', term), value);

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
    const select = make(document, 'select', '');
    select.name = 'workspace';
    select.setAttribute('aria-label', t('Workspace'));
    select.append(shownChoice(document), ...addable.map((workspace) => option(document, workspace.id, workspace.name)));
    select.addEventListener('change', () => {
      chosen = select.value;
      refill?.();
    });
    facts.prepend(field(t('Workspace'), select));
  }

  const act = make(document, 'div', 'action-block');
  act.append(
    action(document, t('Turn on'), () => options.onTurnOn(options.workspace === undefined ? chosen : undefined)),
    make(document, 'p', 'note', t('Your browser will ask to allow this site once.')),
  );

  return frame(site, make(document, 'h1', '', t('Turn Fruitback on for this site?')), facts, act);
}

/**
 * The words the worker writes first in the label of a destination (`KIND_NAMES` of the worker's
 * `console-api.ts`, and « Fruitback » in `session-sites.ts`): « Linear · Northwind ».
 */
const KIND_WORDS: [DestinationKind, string][] = [
  ['linear', 'Linear'],
  ['github', 'GitHub'],
  ['rest', 'REST API'],
];

/**
 * The provider and the place of a label: « Linear · Northwind » → linear, « Northwind ».
 *
 * `kind` is the provider as the worker named it (FRU-554): it decides the mark, and the label is then
 * only read for the place. Without it, a worker of before FRU-554, the provider is read from the
 * first words of the label.
 */
export function readDestination(
  label: string,
  kind?: DestinationKind,
): { kind?: DestinationKind; provider?: string; place: string } {
  if (kind === 'fruitback' || (kind === undefined && label === 'Fruitback')) return { kind: 'fruitback', place: label };
  for (const [each, word] of KIND_WORDS) {
    if (kind !== undefined && kind !== each) continue;
    const prefix = `${word} · `;
    if (label.startsWith(prefix)) return { kind: each, provider: word, place: label.slice(prefix.length) };
    if (kind === each) return { kind, provider: word, place: label };
  }

  return { place: label };
}

/**
 * « Notes go to », as a line of a list of terms (FRU-530): the mark of the provider, then the place.
 * The provider is said to a screen reader in words, since the mark is a drawing it skips.
 */
export function destinationEntry(
  document: Document,
  label: string,
  action?: HTMLElement,
  named?: DestinationKind,
): HTMLElement {
  const entry = make(document, 'div', 'kit-dl-entry');
  entry.classList.add('destination-entry');
  const { kind, provider, place } = readDestination(label, named);
  const value = make(document, 'dd', 'destination-value');
  if (kind === 'fruitback') {
    const drop = dropMark(document, 'source-mark');
    drop.dataset.kind = 'fruitback';
    value.append(drop);
  } else if (kind !== undefined) value.append(sourceMark(document, kind));
  if (provider !== undefined) value.append(make(document, 'span', 'visually-hidden', `${provider} · `));
  value.append(make(document, 'span', 'destination-place', place));
  entry.append(make(document, 'dt', '', t('Notes go to')), value);
  if (action !== undefined) {
    const holder = make(document, 'dd', 'kit-dl-action');
    holder.append(action);
    entry.append(holder);
  }

  return entry;
}

/** What changes where the notes of a site go (FRU-530): the lists of « Turn on », for a role that may. */
export type DestinationChange = {
  sources: Source[];
  /** Where the notes go now: `null` for « Fruitback », absent when not known. */
  place?: PlaceIds | null;
  loadOffer: (connector: string) => Promise<SourceOffer | undefined>;
  /** Answers whether the change holds: `false` puts the lists back as they were. */
  onPlace: (place: PlaceIds | null) => Promise<boolean>;
};

/** What the worker says of a site that is on (FRU-295), read after the screen is drawn. */
export type SiteFacts = {
  /** « Linear · Northwind ». */
  destination?: string;
  /** The provider of `destination`, when the worker named it (FRU-554). None: read from the label. */
  destinationKind?: DestinationKind;
  /** The lists that change it (FRU-530). Absent: a role that may not, and no « Change ». */
  change?: DestinationChange;
  /** The notes of the person the team marked done, not checked yet. */
  toCheck?: number;
  /** The notes of the site that are New, To do or In progress. */
  open?: number;
};

export type SiteOnOptions = {
  origin: string;
  workspace: string;
  on: boolean;
  /** The keys of « Leave a note », as the browser has them. None: no line. */
  shortcut?: string[];
  facts?: SiteFacts;
  account?: Account;
  /** The foot, in place of the one of an account: a session of a pairing and its log out (FRU-319). */
  foot?: HTMLElement;
  onToggle: (on: boolean) => void;
  /**
   * « Hide Fruitback on this page » (FRU-444, FRU-590), for a site that is on. Absent: shown, and no
   * button. Hidden, « Leave a note » and the side panel stay, turned off: the page has no widget.
   */
  visibility?: Visibility;
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

/** The state line of a site: « On · Acme ». Where its notes go has its own line (FRU-530). */
function onState(workspace: string, on: boolean): string {
  return on ? t('On · {workspace}', { workspace }) : t('Off · {workspace}', { workspace });
}

/** Whether the widget shows on this origin (FRU-444), and how to change it. */
export type Visibility = { shown: boolean; onChange: (shown: boolean) => void };

/**
 * « Hide Fruitback on this page » (FRU-444, FRU-590): a square button of one icon, pressed while the
 * widget is hidden. Its name stays the same in both states, and `aria-pressed` says the state. The
 * rule stays on; only this origin loses the widget, and gets it back with no prompt.
 */
export function visibilityButton(document: Document, options: Visibility): HTMLButtonElement {
  const node = secondaryButton(document, '', () => options.onChange(!options.shown));
  node.classList.add('icon-button', 'visibility-button');
  node.setAttribute('aria-label', t('Hide Fruitback on this page'));
  node.setAttribute('aria-pressed', String(!options.shown));
  node.title = t('Hide Fruitback on this page');
  node.append(iconOf(document, options.shown ? EYE : EYE_SLASH, 'panel-icon'));

  return node;
}

/** The event that « Change where notes go » of the menu sends to the screen (FRU-599). */
const CHANGE_DESTINATION = 'fruitback-change-destination';

/** A drawing of `popup-icons.ts`, in the colour of the words around it. */
function iconOf(document: Document, d: string, className = 'popup-icon'): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 256 256');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('focusable', 'false');
  drawing.setAttribute('class', className);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', d);
  drawing.append(path);

  return drawing;
}

/**
 * The menu « ⋯ » of a site (FRU-599): what was a second switch, a turn off and « Change ». Each entry
 * says what it keeps. « Change where notes go » waits for the worker (`showSiteFacts`).
 */
function siteMenu(document: Document, options: SiteOnOptions, row: HTMLElement): HTMLElement {
  const items: MenuItem[] = [];
  if (options.on && options.visibility !== undefined) {
    const { shown, onChange } = options.visibility;
    items.push(
      shown
        ? {
            id: 'visibility',
            label: t('Hide the widget on this site'),
            detail: t('Your notes stay. Show it again from here.'),
            onSelect: () => onChange(false),
          }
        : {
            id: 'visibility',
            label: t('Show the widget on this site'),
            detail: t('It comes back on every tab of this site.'),
            onSelect: () => onChange(true),
          },
    );
  }
  if (options.on) {
    items.push(
      {
        id: 'stop',
        label: t('Stop reviewing this site'),
        detail: t('Fruitback goes off here. Your notes are kept.'),
        onSelect: () => options.onToggle(false),
      },
      {
        id: 'destination',
        label: t('Change where notes go'),
        hidden: true,
        onSelect: () => row.dispatchEvent(new CustomEvent(CHANGE_DESTINATION)),
      },
    );
  }
  items.push({ id: 'settings', label: t('All settings for this site'), onSelect: options.onSettings });

  return menuButton(document, { label: t('More for this site'), icon: iconOf(document, DOTS), items }).root;
}

/**
 * 3 · Site on (FRU-298, FRU-599): a launcher. The site and its state, its menu « ⋯ », where the notes
 * go, « Leave a note », and the side panel with what waits. Off, « Turn on » in place of the rest.
 */
export function siteOn(document: Document, options: SiteOnOptions): HTMLElement {
  const host = hostOf(options.origin);
  const row = make(document, 'div', 'site-row');
  row.append(
    hostAsTitle(
      siteLine(document, {
        host,
        state: onState(options.workspace, options.on),
        on: options.on,
      }),
    ),
  );
  if (options.on) {
    const on = make(document, 'span', 'site-on-mark');
    on.setAttribute('role', 'img');
    on.setAttribute('aria-label', t('Fruitback is on for this site'));
    on.title = t('On for this site');
    on.append(iconOf(document, ON));
    row.append(on);
  }
  row.append(siteMenu(document, options, row));

  const body: Node[] = [row];
  if (!options.on) {
    body.push(primaryButton(document, t('Turn on'), () => options.onToggle(true)));
  } else {
    const hidden = options.visibility?.shown === false;
    // FRU-530: where the notes go, above « Leave a note », filled when the worker says it.
    body.push(make(document, 'div', 'site-destination'));
    const leave = make(document, 'div', 'leave-block');
    if (hidden) leave.append(make(document, 'p', 'hidden-line', t('Fruitback is hidden on this page.')));
    const note = primaryButton(document, t('Leave a note'), options.onLeaveFeedback, { size: 'tall' });
    // Hidden, the page has no widget to take a note or to fill the panel.
    note.disabled = hidden;
    leave.append(note);
    const keyNames = hidden ? [] : (options.shortcut ?? []);
    if (keyNames.length > 0) {
      const [before, after] = t('or press {keys} on the page').split('{keys}');
      const line = make(document, 'p', 'shortcut-line');
      line.append(before ?? '', keys(document, keyNames), after ?? '');
      leave.append(line);
    }
    // The side panel, and what waits in it (FRU-599): the popup says how many, the panel checks them.
    const panel = button(document, 'panel-row', '', options.onOpenPanel);
    panel.disabled = hidden;
    const tile = make(document, 'span', 'panel-row-tile');
    tile.append(iconOf(document, PANEL));
    const words = make(document, 'span', 'panel-row-words');
    // Its name is what it shows, the counts included (axe `label-content-name-mismatch`).
    words.append(
      make(document, 'span', 'panel-row-title', t('Show all notes in a sidebar')),
      make(document, 'span', 'panel-counts'),
    );
    const caret = iconOf(document, CARET);
    caret.classList.add('panel-row-caret');
    panel.append(tile, words, caret);
    body.push(leave, panel);
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
 * the worker before it shows « Leave a note ». The state line names the tracker; where the notes go
 * gets its line; the side panel says the open notes and the fixes to check (FRU-599).
 */
export function showSiteFacts(
  screen: HTMLElement,
  options: Pick<SiteOnOptions, 'workspace' | 'on' | 'onOpenPanel'>,
  facts: SiteFacts,
): void {
  const document = screen.ownerDocument;
  const state = screen.querySelector('.kit-site-state');
  if (state !== null) state.textContent = onState(options.workspace, options.on);
  const where = screen.querySelector<HTMLElement>('.site-destination');
  // A role that may change the place gets the line even when the worker named none: « Not known », and
  // the pencil to set it (review of #736).
  const label = facts.destination ?? (facts.change === undefined ? undefined : t('Not known'));
  if (where !== null && label !== undefined) {
    showDestination(where, label, facts.change, facts.destination === undefined ? undefined : facts.destinationKind);
  }
  const counts = screen.querySelector('.panel-counts');
  if (counts === null) return;
  const parts: Node[] = [];
  if (facts.open !== undefined) {
    parts.push(
      document.createTextNode(
        facts.open === 0
          ? t('No open note')
          : plural(facts.open, t('1 open note'), t('{count} open notes', { count: shortCount(facts.open) })),
      ),
    );
  }
  if (facts.toCheck !== undefined && facts.toCheck > 0) {
    if (parts.length > 0) parts.push(document.createTextNode(' · '));
    const dot = make(document, 'span', 'panel-counts-dot');
    dot.setAttribute('aria-hidden', 'true');
    parts.push(
      dot,
      document.createTextNode(
        plural(facts.toCheck, t('1 to check'), t('{count} to check', { count: String(facts.toCheck) })),
      ),
    );
  }
  counts.replaceChildren(...parts);
}

/** « 99+ » above 99: a count of open notes on one line (P7 of FRU-598). */
function shortCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * « Sent to » of a site that is on (FRU-530, FRU-599): the mark of the provider, the provider, its
 * team and its project, and a pencil for a role that may change it. The pencil, and « Change where
 * notes go » of the menu, open the lists of « Turn on » in place of the line. A change the worker
 * refuses puts the lists back.
 */
function showDestination(
  line: HTMLElement,
  label: string,
  change: DestinationChange | undefined,
  kind: DestinationKind | undefined,
): void {
  const document = line.ownerDocument;
  const open = (): void => {
    if (change === undefined) return;
    const { entries } = placeChoice(document, {
      sources: () => change.sources,
      ...(change.place === undefined ? {} : { place: change.place }),
      loadOffer: change.loadOffer,
      onPlace: change.onPlace,
    });
    const lists = make(document, 'dl', 'kit-dl');
    lists.append(...entries);
    line.replaceChildren(lists);
    line.querySelector('select')?.focus();
  };
  const { kind: shown, provider, place } = readDestination(label, kind);
  let mark: SVGSVGElement | undefined;
  if (shown === 'fruitback') {
    mark = dropMark(document, 'source-mark');
    mark.dataset.kind = 'fruitback';
  } else if (shown !== undefined) mark = sourceMark(document, shown);
  const words = make(
    document,
    'span',
    'destination-place',
    [provider, ...place.split(' · ')].filter(Boolean).join(' / '),
  );
  words.title = words.textContent ?? '';
  const sent = make(document, 'span', 'destination-label', t('Sent to'));
  line.replaceChildren(sent, ...(mark === undefined ? [] : [mark]), words);
  if (change !== undefined) {
    const pencil = button(document, 'kit-secondary', '', open);
    pencil.classList.add('destination-change');
    pencil.setAttribute('aria-label', t('Change where notes go'));
    pencil.title = t('Change where notes go');
    pencil.append(iconOf(document, PENCIL));
    line.append(pencil);
    const menuEntry = line.closest('.popup')?.querySelector<HTMLButtonElement>('[data-menu-item="destination"]');
    if (menuEntry) {
      menuEntry.hidden = false;
      const now = make(document, 'span', 'kit-menu-detail', t('Now: {place}', { place: words.textContent ?? '' }));
      menuEntry.querySelector('.kit-menu-detail')?.remove();
      menuEntry.append(now);
    }
    line.closest('.popup')?.querySelector('.site-row')?.addEventListener(CHANGE_DESTINATION, open);
  }
}

/** One or many, by the rules of the language of the popup: « 1 fix », « 2 fixes ». */
function plural(count: number, one: string, other: string): string {
  return new Intl.PluralRules(language()).select(count) === 'one' ? one : other;
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The keys of a shortcut, as the kit draws them: `Alt+Shift+F` → Alt Shift F. Chrome on macOS writes
 * them with no `+`, a sign each (`⌥⇧F`): each sign is then a key of its own.
 */
export function keysOfShortcut(shortcut: string): string[] {
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut.replace(/\s+/gu, '')];

  return parts.map((key) => key.trim()).filter((key) => key !== '');
}
