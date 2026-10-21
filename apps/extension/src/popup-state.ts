import type { ConnectState } from './connect.ts';
import type { SiteConfig } from './sites.ts';
import { isSecureWorkerEndpoint, isWorkerEndpoint, normalizeWorkerEndpoint } from './endpoint.ts';

/**
 * Which screen the popup draws, out of what it found (FRU-251).
 *
 * The popup reads storage and asks Fruitback; this decides, with nothing to await, so every state
 * of the mock-up and every state beside it has a test of its own. `main.ts` gathers the facts and
 * draws what this answers.
 */

/** The Fruitback of this build, when a build names none: the one Sakuga Software runs. */
export const DEFAULT_CLOUD = 'https://api.fruitback.com';

/**
 * The Fruitback « Sign in to Fruitback » signs in to, out of `WXT_FRUITBACK_CLOUD`, fixed at build.
 *
 * Absent: the default. Empty: none, and the popup offers « Connect it in settings » alone, for a
 * build made for a self-hosted instance. Anything else must be an endpoint a credential may travel
 * to, or there is none: a build with a wrong value must not sign in over plain http.
 */
export function cloudEndpoint(raw: string | undefined): string | undefined {
  if (raw === undefined) return DEFAULT_CLOUD;
  const value = raw.trim();
  if (value === '' || !isWorkerEndpoint(value) || !isSecureWorkerEndpoint(value)) return undefined;

  return normalizeWorkerEndpoint(value);
}

/**
 * Whether a site wants a session this browser does not hold: a site of a workspace of this build's
 * Fruitback, with no session for it. The popup then offers to sign in, and the widget the extension
 * mounts there says so too (FRU-315).
 */
export function wantsSession(site: SiteConfig, cloud: string | undefined, held: Record<string, unknown>): boolean {
  if (cloud === undefined || site.mode !== 'team' || site.mount === undefined || site.endpoint !== cloud) return false;

  return held[cloud] === undefined;
}

/**
 * The session of the account, as the popup found it.
 *
 * `none`: no account here. `ok`: it answers. `ended`: Fruitback refused it (expired, or signed out
 * from the console), and it is forgotten. `unreachable`: Fruitback did not answer, and it is kept.
 */
export type AccountState = 'none' | 'ok' | 'ended' | 'unreachable';

export type PopupFacts = {
  /** The http or https origin of the tab, or nothing for a page Fruitback does not run on. */
  origin?: string;
  /** The tab is a pairing link of a self-hosted worker (FRU-92). */
  pairLink: boolean;
  /** « This is a site to review », « Set up by hand », « Change »: the fields, asked for. */
  editing: boolean;
  /** Whether this build names a Fruitback to sign in to. */
  canSignIn: boolean;
  /** The sign-in that waits, claimed once just now. */
  connect: ConnectState;
  /** A rule of this browser covers the origin. */
  rule: boolean;
  /**
   * The rule is on, and the browser no longer grants its sites (FRU-297): access was removed in the
   * settings of the browser. Asked only for a rule that is on.
   */
  accessRemoved?: boolean;
  /**
   * The rule is of a site of the workspace of this build's Fruitback, and no session of it is held
   * now: it ended, and its widget reads and writes nothing until the person signs in again (FRU-238).
   */
  ruleWantsSession?: boolean;
  /**
   * The rule is of a site of the workspace of this build's Fruitback, and Fruitback did not answer
   * (FRU-319). The site would say « On » while no note can be read or sent there.
   */
  ruleUnreachable?: boolean;
  /** A workspace of a session lists the origin (FRU-101). */
  offer: boolean;
  account: AccountState;
  /** How many sessions this browser holds, of an account and of pairings. */
  sessions: number;
};

export type PopupState =
  | { kind: 'not-web' }
  | { kind: 'pair-link' }
  | { kind: 'connecting'; unanswered: boolean }
  | { kind: 'sign-in-problem'; problem: 'refused' | 'expired' }
  | { kind: 'form' }
  | { kind: 'rule' }
  | { kind: 'no-access' }
  | { kind: 'offer' }
  | { kind: 'unreachable' }
  | { kind: 'new-site' }
  | { kind: 'signed-out'; canSignIn: boolean; ended: boolean };

export function decide(facts: PopupFacts): PopupState {
  // A `chrome://` page, the store, a PDF viewer: nothing is wrong, and nothing can run there.
  if (facts.origin === undefined) return { kind: 'not-web' };
  if (facts.pairLink && !facts.editing) return { kind: 'pair-link' };

  // A sign-in in progress is what the person came back for, whatever the page.
  if (facts.connect === 'waiting' || facts.connect === 'unavailable') {
    return { kind: 'connecting', unanswered: facts.connect === 'unavailable' };
  }
  // Said once: the request is forgotten, and the next popup is the screen of before.
  if (facts.connect === 'refused' || facts.connect === 'expired') {
    return { kind: 'sign-in-problem', problem: facts.connect };
  }

  if (facts.editing) return { kind: 'form' };
  // A rule of this browser is what runs here: its switch comes before anything about an account.
  // The rule needs a session that is gone: signing in again is the one thing that makes it work.
  if (facts.rule && facts.ruleWantsSession === true) {
    return { kind: 'signed-out', canSignIn: facts.canSignIn, ended: facts.account === 'ended' };
  }
  // The rule is on and the browser took its access away: the one thing to do is to give it back.
  if (facts.rule && facts.accessRemoved === true) return { kind: 'no-access' };
  // Its Fruitback does not answer: « On » would say all is well while nothing reaches it (FRU-319).
  if (facts.rule && facts.ruleUnreachable === true) return { kind: 'unreachable' };
  if (facts.rule) return { kind: 'rule' };
  if (facts.offer) return { kind: 'offer' };

  if (facts.account === 'ended') return { kind: 'signed-out', canSignIn: facts.canSignIn, ended: true };
  if (facts.account === 'unreachable') return { kind: 'unreachable' };
  // 08 (FRU-255): signed in, on a site of no workspace: add it to one, or say who can.
  if (facts.account === 'ok') return { kind: 'new-site' };
  // Nobody signed in and nothing paired: the one question is to sign in (05). A self-hosted instance
  // is one link away, on the settings page.
  if (facts.sessions === 0) return { kind: 'signed-out', canSignIn: facts.canSignIn, ended: false };

  return { kind: 'form' };
}

/**
 * The four screens of the mock-up of 2026-10-20 (FRU-297), and the page of the extension.
 *
 * 1 · signed out (with the word of a sign-in, and what stopped one); 2 · a site not added here;
 * 3 · a site on; 4 · a problem, with its fix. `page`: what the page of the extension takes over
 * (FRU-301, FRU-302). Until that page has them, `form` and `pair-link` keep their screen of before.
 */
export type PopupScreen = 1 | 2 | 3 | 4 | 'page';

/** Every kind `decide` answers, written once: `screenOf` and its test read this list. */
export const POPUP_KINDS = [
  'not-web',
  'pair-link',
  'connecting',
  'sign-in-problem',
  'form',
  'rule',
  'no-access',
  'offer',
  'unreachable',
  'new-site',
  'signed-out',
] as const satisfies readonly PopupState['kind'][];

// The list above holds every kind of the union: a kind added to `PopupState` and not here fails here.
type Missing = Exclude<PopupState['kind'], (typeof POPUP_KINDS)[number]>;
const everyKindListed: [Missing] extends [never] ? true : Missing = true;
void everyKindListed;

/** The screen of each kind. A `Record` over the union: a kind with no screen does not compile. */
export const SCREEN_OF: Readonly<Record<PopupState['kind'], PopupScreen>> = {
  'signed-out': 1,
  connecting: 1,
  'sign-in-problem': 1,
  offer: 2,
  'new-site': 2,
  rule: 3,
  'no-access': 4,
  unreachable: 4,
  'not-web': 4,
  form: 'page',
  'pair-link': 'page',
};

export function screenOf(state: PopupState): PopupScreen {
  return SCREEN_OF[state.kind];
}

/** The kinds of a table that have no screen: the check `popup-state.test.ts` plants a violation in. */
export function unmapped(table: Partial<Record<PopupState['kind'], PopupScreen>>): PopupState['kind'][] {
  return POPUP_KINDS.filter((kind) => table[kind] === undefined);
}
