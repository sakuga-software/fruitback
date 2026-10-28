/**
 * What the two worlds say to each other (FRU-41, FRU-57).
 *
 * A content script in the **isolated** world can read `chrome.storage` and talk to the background,
 * but it cannot see `__reactFiber$` — React sets that in the page's world, and expando properties do
 * not cross. A content script in the **main** world sees the fibers and has no `chrome.*` at all.
 * So the widget runs in the main world and is told what to do from the isolated one, and
 * `window.postMessage` is the only channel the two share.
 *
 * **The page is on that channel too.** It receives everything we post and can post anything back, so
 * nothing secret may travel here and every message must be parsed rather than trusted. The endpoint
 * and the client id are not secrets — the `<script>` tag mode writes both into the client's own DOM.
 * An identity token (FRU-9) is a secret, which is why none is sent: the relay below carries the
 * request and the background attaches the credential, out of the page's reach.
 */

import type { SiteNote, SiteRead } from '@fruitback/widget';
import { STATUS_COLOR } from '@fruitback/shared';
import type { DockPosition, TransportRequest, TransportResponse } from '@fruitback/widget';
import { isWorkerEndpoint } from './endpoint.ts';

/**
 * The channel, and the version of the protocol it carries (FRU-397). Version 2: each message carries
 * the tag of the copy that posted it (`copy.ts`), and a copy hears no other. A copy of 0.1.0 to 0.3.0
 * speaks on `LEGACY_CHANNEL`: it hears nothing said here, and nothing it says is heard here.
 */
export const CHANNEL = 'fruitback-extension/2';

/** The channel of the copies of before (0.1.0 to 0.3.0), which carried no version and no copy. */
export const LEGACY_CHANNEL = 'fruitback-extension';

/**
 * The request the page asks the extension to make for it, and the answer.
 *
 * The widget's own transport seam (FRU-56), named here rather than re-declared: the relay exists to
 * fill it, and two copies of the shape would drift. Both are plain objects, because neither
 * `Request` nor `Response` survives `postMessage`.
 */
export type RelayRequest = TransportRequest;
export type RelayResponse = TransportResponse;

/**
 * The headers the page is allowed to name, and it is a list of one.
 *
 * An allowlist, so a header a page invents is dropped by default. `Authorization` is the reason:
 * the background builds it from the session, and a page that could name it would choose what
 * credential its own request carries. It is absent from this list rather than refused by it, so
 * there is no spelling to get wrong.
 */
const ALLOWED_HEADERS = ['Content-Type'];

/** The worker refuses a body over 64 KiB (`MAX_BODY_BYTES` in `apps/worker/src/app.ts`). */
const MAX_BODY_BYTES = 64 * 1_024;

/**
 * The longest file of a note in base64 (FRU-332): 10 MB, the most the worker takes of one file
 * (`MAX_ATTACHMENT_BYTES`), is 13 981 016 characters of base64. A longer one is refused here.
 */
export const MAX_FILE_BASE64 = Math.ceil((10 * 1_024 * 1_024) / 3) * 4;

/** Base64, and nothing else: a body that is not base64 goes nowhere. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Long enough for a UUID, short enough that a page cannot post a megabyte of it. */
/**
 * The longest id the channel carries: a request, a note. A note id of the widget is 15 characters
 * (`sd_` and 12 hex), an issue id of a tracker well under this.
 */
export const MAX_ID_LENGTH = 100;

/**
 * How long the background lets one relayed call run before it aborts it.
 *
 * **The abort is the point, not the deadline.** Without it a worker that accepts a connection and
 * never answers leaves the request in flight while the page is told the call failed — and a reviewer
 * told their note failed presses send again, which plants it twice. The worker cannot tell the two
 * apart (FRU-9 gives a note its own id, which dedupes a retry of the *same* request, not a second
 * one). Raised in review.
 */
export const RELAY_CALL_TIMEOUT_MS = 20 * 1_000;

/**
 * How long the page waits for any answer at all.
 *
 * Deliberately longer than the call above, so the ordinary slow worker becomes a refusal the
 * background sends rather than a timeout the page invents. What is left for this one to catch is a
 * service worker that was stopped mid-call and a channel nobody is on.
 */
export const RELAY_ANSWER_TIMEOUT_MS = RELAY_CALL_TIMEOUT_MS + 5 * 1_000;

export type MountMessage = {
  channel: typeof CHANNEL;
  kind: 'mount';
  endpoint: string;
  clientId: string;
  label?: string;
  /**
   * The language of the reviewer's account (FRU-131). Left out, the widget reads the page's own. It
   * is no secret: a locale tag, and the page can read it like the rest of this message.
   */
  locale?: string;
  /**
   * The widget calls the worker through the relay of the reviewer's session (FRU-101): a team-mode
   * entry for a site that embeds nothing. The page can forge this flag, and it buys nothing: the
   * background relays only for a site its own storage says is in team mode.
   */
  relay?: true;
  /**
   * The « Name on my notes » of the preferences (FRU-302), for a widget the extension mounts in
   * private mode: the composer starts with it. The page can read it, like the rest of this message;
   * it is the name the reviewer chose to sign their notes with on these sites.
   */
  name?: string;
};

/**
 * The session of the reviewer for the site of the widget we mounted, as the isolated world reads it
 * (FRU-315): `signedOut` when a site of the workspace of this build's Fruitback has no session. The
 * page can read and forge it, and it buys nothing: it changes what the widget offers, never what
 * the background relays.
 */
export type SessionMessage = {
  channel: typeof CHANNEL;
  kind: 'session';
  signedOut: boolean;
};

/**
 * « Show CSS selectors » of the preferences (FRU-349), for the widget we mounted: the thread of a pin
 * shows the selector of its element, or not. Said apart from the mount, so a change does not build
 * the widget again over a note being written. The page can read and forge it: it changes what a
 * thread shows on this page, and nothing else.
 */
export type SelectorsMessage = {
  channel: typeof CHANNEL;
  kind: 'selectors';
  shown: boolean;
};

/**
 * « Corner of the widget » of the preferences (FRU-443), for the widget we mounted: the dock moves to
 * that corner of the window. Absent: the corner of the widget by default. Said apart from the mount,
 * like `selectors`, so a change does not build the widget again over a note being written. The page
 * can read and forge it: it moves the dock on this page, and nothing else.
 */
export type DockMessage = {
  channel: typeof CHANNEL;
  kind: 'dock';
  position?: DockPosition;
};

/**
 * The corners the widget knows (`DOCK_POSITIONS` of `@fruitback/widget`), written here so the bridge
 * does not import the widget. `protocol.test.ts` holds the two lists equal.
 */
export const DOCK_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const satisfies readonly DockPosition[];

/** A corner the widget knows, or `undefined`. */
export function parseDockPosition(value: unknown): DockPosition | undefined {
  return typeof value === 'string' && (DOCK_POSITIONS as readonly string[]).includes(value)
    ? (value as DockPosition)
    : undefined;
}

/**
 * The widget asks for the sign-in (FRU-315): « Sign in to leave notes », « Sign in », « Sign in
 * again ». The page can forge it too: the background opens the popup, and only for a tab whose site
 * has a rule that wants a session.
 */
export type SignInMessage = {
  channel: typeof CHANNEL;
  kind: 'sign-in';
};

export type UnmountMessage = {
  channel: typeof CHANNEL;
  kind: 'unmount';
};

/**
 * The main world announcing it can receive, sent the other way.
 *
 * Nothing orders the two content scripts against each other, so the isolated one can decide to mount
 * before the listener in the page's world exists — and a `postMessage` with nobody listening is
 * simply lost. The main world therefore says when it is there, rather than the isolated one guessing
 * with a timeout.
 *
 * The page can forge this. The isolated world then posts its decision again, which the main world
 * already applied: it builds nothing for a mount that is the one on screen (FRU-186), so an open
 * composer stays open.
 */
export type ReadyMessage = {
  channel: typeof CHANNEL;
  kind: 'ready';
  /**
   * FRU-397: the hash of the tag of the message and of the address of the copy of the page script
   * (`proofOf`). Absent: the page script could not read its address, and the bridge takes it while
   * no proven one came.
   */
  proof?: string;
  /** The version of the copy of the page script, which a bridge of another copy says in its popup. */
  version?: string;
  /** The page script found the page held by another copy, and stepped aside (FRU-397). */
  heldBy?: { version?: string };
};

/**
 * The bridge asks the page script of its copy to say `ready` again (FRU-397). The bridge hears only
 * the tag of a `ready`, so it asks when it starts: the page script may have said it before the bridge
 * listened. It carries no tag, and every page script on the page answers it.
 */
export type HelloMessage = {
  channel: typeof CHANNEL;
  kind: 'hello';
};

/**
 * Team mode: the extension is here, and it is not mounting anything (FRU-57).
 *
 * The other half of `mount`, sent for a site that embeds its own widget. The main world answers it
 * by putting a transport on the page, so the site's dormant widget has something to call. Nothing
 * travels with it: the endpoint and the client id are the site's own, which is what separates this
 * mode from the private one.
 */
export type AnnounceMessage = {
  channel: typeof CHANNEL;
  kind: 'announce';
};

/**
 * A call the page cannot make itself, on its way to the background (FRU-57).
 *
 * `id` pairs it with its answer. The page shares this channel, so it can send one of these and read
 * the answer to it — which buys it a call to a worker it can already reach, with a credential it
 * never sees. What stops it going further is `relay.ts`, in the background: the origin comes from
 * the sender and the endpoint from storage, neither of them from this message.
 */
export type RelayRequestMessage = {
  channel: typeof CHANNEL;
  kind: 'relay-request';
  id: string;
  request: RelayRequest;
};

export type RelayResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'relay-response';
  id: string;
  response: RelayResponse;
};

/**
 * The widget asks for the picture of an element, on its way to the background (FRU-44).
 *
 * The page can send one of these: it buys a picture of its own tab, sent to the worker of its own
 * entry with a session it never sees, and only when the reviewer granted `activeTab`. The area is
 * the only thing the page decides, and `capture.ts` keeps it inside the capture.
 */
export type CaptureRequestMessage = {
  channel: typeof CHANNEL;
  kind: 'capture-request';
  id: string;
  /** An area of the visible page (FRU-332). Absent: the whole visible page. */
  area?: { left: number; top: number; width: number; height: number; scale: number };
};

/**
 * The capture, as a PNG in base64, or nothing: no capture, for whatever reason (FRU-332). It goes to
 * the worker as a file of the note, through the relay, like any file the person chose.
 */
export type CaptureResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'capture-response';
  id: string;
  picture?: { name: string; type: 'image/png' | 'image/jpeg'; size: number; base64: string };
  /** A capture over the limit of the worker, even as a JPEG: no bytes, its name and its size. */
  tooLarge?: { name: string; size: number };
  /** The browser refused the capture for want of a gesture on the extension (FRU-423). */
  refused?: 'permission';
};

/**
 * What the popup asks of the widget the extension mounted on this tab (FRU-254): choose an element,
 * open the list, or say how many notes of each stage the page shows.
 *
 * The isolated world posts it only for a message of the popup (`tab-command.ts`). The page can post
 * one too, and gains nothing by it: the widget's Shadow root is open, so a page can already press
 * every button of it. No secret travels either way, only five numbers.
 */
export type CommandMessage = {
  channel: typeof CHANNEL;
  kind: 'command';
  id: string;
  command: TabCommand;
  /** The note of `focus-note` and `reply` (FRU-299): its id. */
  note?: string;
  /** The text of `reply`. */
  body?: string;
  /** The verdict of `check` (FRU-300). */
  verdict?: CheckVerdict;
};

/** « Looks fixed » and « Still wrong », as the worker names them (FRU-294). */
export const CHECK_VERDICTS = ['fixed', 'wrong'] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export type CommandResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'command-response';
  id: string;
  /** The widget did it. False when there is no widget of ours here, or it would take somebody's typing. */
  done: boolean;
  /** The widget is there, and said no: somebody writes a note. */
  busy?: true;
  counts?: PageCounts;
  /** The answer of `notes` (FRU-299): the notes the pins show. */
  notes?: PanelNote[];
  /** Why `notes` answered none: no widget of ours on the page, its read not answered, or failed. */
  reading?: NotesReading;
  /** The answer of `reply`: sent, or why not. */
  outcome?: ReplyOutcome;
};

/**
 * FRU-299: the widget the extension mounted says that its notes changed, or which note was opened
 * on the page. It carries no note: the side panel then asks for them with `notes`, as for any read.
 * The page can post one too, and buys a read of its own notes, or an open row.
 */
export type NotesChangedMessage = {
  channel: typeof CHANNEL;
  kind: 'notes-changed';
  open?: string;
};

export const TAB_COMMANDS = [
  'leave-feedback',
  'show-notes',
  'counts',
  // FRU-299: the side panel.
  'notes',
  'focus-note',
  'mark-note',
  'reply',
  // The read of the widget, again: « Try again » of a read that failed.
  'reread',
  // FRU-300: « Looks fixed » / « Still wrong ».
  'check',
  // FRU-307: « Show pins on the page », off and on.
  'hide-pins',
  'show-pins',
  // FRU-423: « Capture with Fruitback » of the context menu.
  'capture-area',
] as const;
export type TabCommand = (typeof TAB_COMMANDS)[number];

const STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
export type PageCounts = Record<(typeof STAGES)[number], number>;

/** Why a widget gave no notes (FRU-299). */
export const NOTES_READINGS = ['no-widget', 'pending', 'failed', 'signed-out'] as const;
export type NotesReading = (typeof NOTES_READINGS)[number];

/** What `reply` answers: the reply is in the store, or why it is not. */
export const REPLY_OUTCOMES = ['sent', 'retry', 'wait', 'signed-out', 'refused'] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

/** A note of the page as the side panel lists it (FRU-299): the `PageNote` of the widget, parsed. */
export type PanelNote = {
  id: string;
  number?: number;
  stage: (typeof STAGES)[number];
  /** The word of its store, Linear's « In Review » (FRU-370). Left out when the store named nothing. */
  stateName?: string;
  /**
   * Its status (FRU-370): the name and the colours a team chose, always of the note's stage. A colour
   * is `#rrggbb`, and a text colour comes only with a colour. Left out, the note is drawn by its stage.
   */
  status?: PanelStatus;
  note: string;
  author?: string;
  mine?: true;
  createdAt: string;
  updatedAt: string;
  /** `fromPage`: written from a page, under a name the page typed (FRU-257); else the tracker's. */
  replies: { author?: string; body: string; createdAt: string; fromPage?: true }[];
  /** Who said it looks fixed, and when (FRU-294). */
  checked?: { by: string; at: string };
  canReply: boolean;
  placement: 'found' | 'approximate' | 'detached';
};

/**
 * The status of a note, as the panel draws it (FRU-370). It keeps its stage: the notes are parsed once
 * by the bridge and again by the panel, and the second parse checks the stage again.
 */
export type PanelStatus = { name: string; stage: PanelNote['stage']; color?: string; textColor?: string };

/** The bounds of what a page may hand the panel: it crosses a world the page writes in. */
export const PANEL_LIMITS = { notes: 500, replies: 200, text: 10_000, name: 200, date: 64 } as const;
const PLACEMENTS = ['found', 'approximate', 'detached'] as const;

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

/**
 * The status of a note from the page, or nothing (FRU-370). The page writes in this world, and a
 * colour goes into a style of the panel: only `#rrggbb` is kept, as `offeredStatuses` keeps it. A
 * status of another stage than its note is dropped, as `statusOf` drops it: the stage wins. A name
 * is required and may be empty: an empty name is the word of the stage (FRU-364). A bad entry loses its
 * status and keeps its note.
 */
function parsePanelStatus(value: unknown, stage: PanelNote['stage']): PanelStatus | undefined {
  if (!isRecord(value) || value.stage !== stage) return undefined;
  const name = boundedString(value.name, PANEL_LIMITS.name);
  if (name === undefined) return undefined;
  const color = typeof value.color === 'string' && STATUS_COLOR.test(value.color) ? value.color : undefined;
  const textColor =
    color !== undefined && typeof value.textColor === 'string' && STATUS_COLOR.test(value.textColor)
      ? value.textColor
      : undefined;

  return {
    name,
    stage,
    ...(color === undefined ? {} : { color }),
    ...(textColor === undefined ? {} : { textColor }),
  };
}

/**
 * The notes, or nothing. An entry that is not a note, or is longer than a note can be, is dropped,
 * and the others are kept; a list longer than `PANEL_LIMITS.notes` is refused whole.
 */
export function parsePanelNotes(value: unknown): PanelNote[] | undefined {
  if (!Array.isArray(value) || value.length > PANEL_LIMITS.notes) return undefined;
  const notes: PanelNote[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = parseId(entry.id);
    const stage = STAGES.find((each) => each === entry.stage);
    const placement = PLACEMENTS.find((each) => each === entry.placement);
    const note = boundedString(entry.note, PANEL_LIMITS.text);
    const createdAt = boundedString(entry.createdAt, PANEL_LIMITS.date);
    const updatedAt = boundedString(entry.updatedAt, PANEL_LIMITS.date);
    const author = entry.author === undefined ? undefined : boundedString(entry.author, PANEL_LIMITS.name);
    // A word, or nothing: a word too long, or not a word, is left out, and the note keeps its stage word.
    const stateName = boundedString(entry.stateName, PANEL_LIMITS.name);
    const number =
      typeof entry.number === 'number' && Number.isSafeInteger(entry.number) && entry.number > 0
        ? entry.number
        : undefined;
    if (!Array.isArray(entry.replies) || entry.replies.length > PANEL_LIMITS.replies) continue;
    const replies: PanelNote['replies'] = [];
    for (const reply of entry.replies) {
      if (!isRecord(reply)) continue;
      const body = boundedString(reply.body, PANEL_LIMITS.text);
      const at = boundedString(reply.createdAt, PANEL_LIMITS.date);
      const by = reply.author === undefined ? undefined : boundedString(reply.author, PANEL_LIMITS.name);
      if (body === undefined || at === undefined || (reply.author !== undefined && by === undefined)) continue;
      replies.push({
        ...(by === undefined ? {} : { author: by }),
        body,
        createdAt: at,
        ...(reply.fromPage === true ? { fromPage: true as const } : {}),
      });
    }
    if (
      id === undefined ||
      stage === undefined ||
      placement === undefined ||
      note === undefined ||
      createdAt === undefined ||
      updatedAt === undefined ||
      (entry.author !== undefined && author === undefined)
    ) {
      continue;
    }
    const checked = isRecord(entry.checked)
      ? {
          by: boundedString(entry.checked.by, PANEL_LIMITS.name),
          at: boundedString(entry.checked.at, PANEL_LIMITS.date),
        }
      : undefined;
    const confirmed =
      checked?.by !== undefined && checked.at !== undefined ? { by: checked.by, at: checked.at } : undefined;
    const status = parsePanelStatus(entry.status, stage);
    notes.push({
      id,
      ...(number === undefined ? {} : { number }),
      stage,
      ...(stateName === undefined || stateName === '' ? {} : { stateName }),
      ...(status === undefined ? {} : { status }),
      note,
      ...(author === undefined ? {} : { author }),
      ...(entry.mine === true ? { mine: true as const } : {}),
      createdAt,
      updatedAt,
      replies,
      ...(confirmed === undefined ? {} : { checked: confirmed }),
      canReply: entry.canReply === true,
      placement,
    });
  }

  return notes;
}

/** Five whole numbers, or nothing. */
export function parsePageCounts(value: unknown): PageCounts | undefined {
  if (!isRecord(value)) return undefined;
  const counts: Partial<PageCounts> = {};
  for (const stage of STAGES) {
    const count = value[stage];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    counts[stage] = count;
  }

  return counts as PageCounts;
}

export type BridgeMessage =
  | MountMessage
  | CommandMessage
  | CommandResponseMessage
  | NotesChangedMessage
  | UnmountMessage
  | ReadyMessage
  | HelloMessage
  | AnnounceMessage
  | RelayRequestMessage
  | RelayResponseMessage
  | CaptureRequestMessage
  | CaptureResponseMessage
  | SessionMessage
  | SelectorsMessage
  | DockMessage
  | SignInMessage
  | SiteNotesRequestMessage
  | SiteNotesResponseMessage;

/**
 * « All pages » of the widget the extension mounts asks for one page of the notes of its site
 * (FRU-470). The page can send one too: `site-notes-relay.ts` says what that buys it. The words of a
 * search and a cursor are all the page decides.
 */
export type SiteNotesRequestMessage = {
  channel: typeof CHANNEL;
  kind: 'site-notes-request';
  id: string;
  query: { q?: string; cursor?: string };
};

export type SiteNotesResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'site-notes-response';
  id: string;
  read: SiteRead;
};

/**
 * Recognise one of our messages, or return `undefined`.
 *
 * Tolerant on purpose and in one direction only: anything that is not exactly a message we sent is
 * refused. The page shares this channel, so a listener that trusted the shape would let any site
 * mount our widget against a worker of its choosing.
 */
export function parseBridgeMessage(data: unknown): BridgeMessage | undefined {
  if (!isRecord(data) || data.channel !== CHANNEL) return undefined;

  if (data.kind === 'unmount') return { channel: CHANNEL, kind: 'unmount' };
  if (data.kind === 'ready') return parseReady(data);
  if (data.kind === 'hello') return { channel: CHANNEL, kind: 'hello' };
  if (data.kind === 'announce') return { channel: CHANNEL, kind: 'announce' };
  if (data.kind === 'sign-in') return { channel: CHANNEL, kind: 'sign-in' };
  if (data.kind === 'session') {
    return typeof data.signedOut === 'boolean'
      ? { channel: CHANNEL, kind: 'session', signedOut: data.signedOut }
      : undefined;
  }
  if (data.kind === 'selectors') {
    return typeof data.shown === 'boolean' ? { channel: CHANNEL, kind: 'selectors', shown: data.shown } : undefined;
  }
  if (data.kind === 'dock') {
    // Absent is the default corner. A value that is not a corner is no message: it moves nothing.
    if (data.position === undefined) return { channel: CHANNEL, kind: 'dock' };
    const position = parseDockPosition(data.position);

    return position === undefined ? undefined : { channel: CHANNEL, kind: 'dock', position };
  }
  if (data.kind === 'relay-request') return parseRelayRequestMessage(data);
  if (data.kind === 'relay-response') return parseRelayResponseMessage(data);
  if (data.kind === 'capture-request') return parseCaptureRequest(data);
  if (data.kind === 'site-notes-request') return parseSiteNotesRequest(data);
  if (data.kind === 'site-notes-response') {
    const id = parseId(data.id);
    const read = parsePageSiteRead(data.read);

    return id === undefined || read === undefined
      ? undefined
      : { channel: CHANNEL, kind: 'site-notes-response', id, read };
  }
  if (data.kind === 'capture-response') return parseCaptureResponse(data);
  if (data.kind === 'command') return parseCommand(data);
  if (data.kind === 'command-response') return parseCommandResponse(data);
  if (data.kind === 'notes-changed') {
    const open = parseId(data.open);

    return { channel: CHANNEL, kind: 'notes-changed', ...(open === undefined ? {} : { open }) };
  }
  if (data.kind !== 'mount') return undefined;

  const { endpoint, clientId, label, relay, locale, name } = data;
  if (!isWorkerEndpoint(endpoint) || !isNonEmptyString(clientId)) return undefined;

  return {
    channel: CHANNEL,
    kind: 'mount',
    endpoint,
    clientId,
    ...(isNonEmptyString(label) ? { label } : {}),
    ...(isNonEmptyString(locale) && locale.length <= 35 ? { locale } : {}),
    ...(relay === true ? { relay: true } : {}),
    ...(isNonEmptyString(name) && name.length <= NAME_MAX ? { name } : {}),
  };
}

/** A proof is 16 hexadecimal digits (`proofOf`); a version, digits and dots. */
function parseReady(data: Record<string, unknown>): ReadyMessage {
  const { proof, version, heldBy } = data;
  const held = isRecord(heldBy) ? parseVersion(heldBy.version) : undefined;

  return {
    channel: CHANNEL,
    kind: 'ready',
    ...(typeof proof === 'string' && /^[0-9a-f]{16}$/.test(proof) ? { proof } : {}),
    ...(parseVersion(version) === undefined ? {} : { version: version as string }),
    ...(isRecord(heldBy) ? { heldBy: held === undefined ? {} : { version: held } } : {}),
  };
}

/** A version as a manifest writes it: one to four numbers with dots, at most 32 characters. */
export function parseVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 32 && /^\d+(?:\.\d+){0,3}$/.test(value) ? value : undefined;
}

/** The longest name the widget keeps for a reporter (`REPORTER_NAME_MAX` of its config). */
export const NAME_MAX = 120;

/** The storage key of « Name on my notes » (FRU-302), in the local area of the extension. */
export const NOTES_NAME_KEY = 'notesName';

/** The storage key of « Show CSS selectors » (FRU-349), in the local area. Absent: off. */
export const SHOW_SELECTORS_KEY = 'showSelectors';

/** The storage key of « Corner of the widget » (FRU-443), in the local area. Absent: the default corner. */
export const DOCK_POSITION_KEY = 'dockPosition';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRelayRequestMessage(data: Record<string, unknown>): RelayRequestMessage | undefined {
  const id = parseId(data.id);
  const request = parseRelayRequest(data.request);
  if (id === undefined || request === undefined) return undefined;

  return { channel: CHANNEL, kind: 'relay-request', id, request };
}

/**
 * The request, rebuilt field by field.
 *
 * Never a spread of what arrived. The page writes this object, the background reads it, and a field
 * that travelled because nobody named it is a field nobody checked.
 */
export function parseRelayRequest(value: unknown): RelayRequest | undefined {
  if (!isRecord(value)) return undefined;

  const { url, method, headers, body, encoding } = value;
  if (!isWorkerEndpoint(url)) return undefined;
  if (method !== 'GET' && method !== 'POST') return undefined;
  // FRU-332: the bytes of a file, in base64, sent as bytes by the background.
  if (encoding !== undefined) {
    if (encoding !== 'base64' || method !== 'POST' || !isFileBody(body)) return undefined;

    return { url, method, headers: allowedHeaders(headers), body, encoding };
  }
  if (body !== undefined && !isWithinBodyCap(body)) return undefined;

  return {
    url,
    method,
    headers: allowedHeaders(headers),
    ...(typeof body === 'string' ? { body } : {}),
  };
}

function parseRelayResponseMessage(data: Record<string, unknown>): RelayResponseMessage | undefined {
  const id = parseId(data.id);
  const response = parseRelayResponse(data.response);
  if (id === undefined || response === undefined) return undefined;

  return { channel: CHANNEL, kind: 'relay-response', id, response };
}

export function parseRelayResponse(value: unknown): RelayResponse | undefined {
  if (!isRecord(value)) return undefined;

  const { ok, status, body } = value;
  if (typeof ok !== 'boolean' || typeof status !== 'number' || !Number.isFinite(status)) return undefined;
  if (typeof body !== 'string') return undefined;

  return { ok, status, body };
}

function allowedHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const headers: Record<string, string> = {};
  for (const name of ALLOWED_HEADERS) {
    const given = Object.entries(value).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (typeof given === 'string') headers[name] = given;
  }

  return headers;
}

function isFileBody(body: unknown): body is string {
  // A length that is not a multiple of 4 is no base64 that `atob` reads: refused here, with a clear
  // refusal, rather than thrown in the background (raised by the balanced review of #433).
  return (
    typeof body === 'string' &&
    body.length > 0 &&
    body.length % 4 === 0 &&
    body.length <= MAX_FILE_BASE64 &&
    BASE64.test(body)
  );
}

function isWithinBodyCap(body: unknown): body is string {
  return typeof body === 'string' && new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES;
}

/** A number a screen can have: finite, and not past a side of 100 000 pixels. */
function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
}

function parseCaptureRequest(data: Record<string, unknown>): CaptureRequestMessage | undefined {
  const id = parseId(data.id);
  if (id === undefined) return undefined;
  // FRU-332: no area is the whole visible page.
  if (data.area === undefined) return { channel: CHANNEL, kind: 'capture-request', id };
  if (!isRecord(data.area)) return undefined;
  const { left, top, width, height, scale } = data.area;
  if (![left, top, width, height].every(isCoordinate)) return undefined;
  if (typeof scale !== 'number' || !(scale > 0 && scale <= 8)) return undefined;

  return {
    channel: CHANNEL,
    kind: 'capture-request',
    id,
    area: { left: left as number, top: top as number, width: width as number, height: height as number, scale },
  };
}

function parseCaptureResponse(data: Record<string, unknown>): CaptureResponseMessage | undefined {
  const id = parseId(data.id);
  if (id === undefined) return undefined;
  const picture = isRecord(data.picture) ? data.picture : undefined;
  const large = isRecord(data.tooLarge) ? data.tooLarge : undefined;
  const tooLarge =
    large !== undefined &&
    typeof large.name === 'string' &&
    large.name.length > 0 &&
    large.name.length <= 120 &&
    typeof large.size === 'number' &&
    Number.isSafeInteger(large.size) &&
    large.size > 0
      ? { name: large.name, size: large.size }
      : undefined;
  const name = picture?.name;
  const size = picture?.size;
  const base64 = picture?.base64;
  const ok =
    picture !== undefined &&
    (picture.type === 'image/png' || picture.type === 'image/jpeg') &&
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 120 &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    isFileBody(base64);

  return {
    channel: CHANNEL,
    kind: 'capture-response',
    id,
    ...(ok ? { picture: { name, type: picture.type as 'image/png' | 'image/jpeg', size, base64 } } : {}),
    ...(!ok && tooLarge !== undefined ? { tooLarge } : {}),
    ...(!ok && tooLarge === undefined && data.refused === 'permission' ? { refused: 'permission' as const } : {}),
  };
}

function parseCommand(data: Record<string, unknown>): CommandMessage | undefined {
  const id = parseId(data.id);
  const command = TAB_COMMANDS.find((each) => each === data.command);
  if (id === undefined || command === undefined) return undefined;
  const note = parseId(data.note);
  const body = boundedString(data.body, PANEL_LIMITS.text);
  const verdict = CHECK_VERDICTS.find((each) => each === data.verdict);

  return {
    channel: CHANNEL,
    kind: 'command',
    id,
    command,
    ...(note === undefined ? {} : { note }),
    ...(body === undefined ? {} : { body }),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

function parseCommandResponse(data: Record<string, unknown>): CommandResponseMessage | undefined {
  const id = parseId(data.id);
  if (id === undefined) return undefined;
  const counts = parsePageCounts(data.counts);
  const notes = parsePanelNotes(data.notes);
  const outcome = REPLY_OUTCOMES.find((each) => each === data.outcome);
  const reading = NOTES_READINGS.find((each) => each === data.reading);

  return {
    channel: CHANNEL,
    kind: 'command-response',
    id,
    done: data.done === true,
    ...(data.busy === true ? { busy: true as const } : {}),
    ...(counts === undefined ? {} : { counts }),
    ...(notes === undefined ? {} : { notes }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(reading === undefined ? {} : { reading }),
  };
}

function parseId(value: unknown): string | undefined {
  return isNonEmptyString(value) && value.length <= MAX_ID_LENGTH ? value : undefined;
}

/**
 * The status a refusal carries: no worker answered, so there is no HTTP status to report.
 *
 * Also how the background tells its own refusals from a worker's `4xx` when it logs one — the only
 * place a reason is ever read.
 */
export const REFUSED_STATUS = 0;

/**
 * A refusal, in the shape the widget already treats as a failed call.
 *
 * `embed.ts` reads `ok` and nothing else, so a refusal and an unreachable worker are the same event
 * to it: the pins on screen stay, and a note keeps its text. The reason is for whoever reads the
 * console, never for the widget.
 */
export function relayRefusal(reason: string): RelayResponse {
  return { ok: false, status: REFUSED_STATUS, body: reason };
}

/** The words and the cursor, and nothing else (FRU-470). As long as the side panel lets them be. */
function parseSiteNotesRequest(data: Record<string, unknown>): SiteNotesRequestMessage | undefined {
  const id = parseId(data.id);
  const query = isRecord(data.query) ? data.query : undefined;
  if (id === undefined || query === undefined) return undefined;
  const { q, cursor } = query;
  if (q !== undefined && (typeof q !== 'string' || q.length > SITE_QUERY_MAX)) return undefined;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > SITE_CURSOR_MAX)) {
    return undefined;
  }

  return {
    channel: CHANNEL,
    kind: 'site-notes-request',
    id,
    query: { ...(q === undefined || q === '' ? {} : { q }), ...(cursor === undefined ? {} : { cursor }) },
  };
}

const SITE_QUERY_MAX = 200;
const SITE_CURSOR_MAX = 500;
const SITE_TEXT_MAX = 2_000;
const SITE_NOTES_MAX = 50;
const SITE_STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;

/**
 * A page of notes for « All pages », rebuilt field by field (FRU-470): it crossed from the background
 * to the bridge, and from the bridge to the page. A bad note costs that note.
 */
export function parsePageSiteRead(value: unknown): SiteRead | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok === false) {
    const { reason } = value;

    return reason === 'signed-out' || reason === 'unavailable' || reason === 'failed'
      ? { ok: false, reason }
      : undefined;
  }
  if (value.ok !== true) return undefined;
  const { notes, total, next } = value;
  if (!Array.isArray(notes) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return undefined;
  const parsed = notes.slice(0, SITE_NOTES_MAX).flatMap((note) => {
    const one = parsePageSiteNote(note);

    return one === undefined ? [] : [one];
  });
  const cursor = typeof next === 'string' && next.length > 0 && next.length <= SITE_CURSOR_MAX ? next : undefined;

  return { ok: true, notes: parsed, total, ...(cursor === undefined ? {} : { next: cursor }) };
}

function parsePageSiteNote(value: unknown): SiteNote | undefined {
  if (!isRecord(value)) return undefined;
  const short = (field: unknown, max = SITE_TEXT_MAX): string | undefined =>
    typeof field === 'string' && field.length <= max ? field : undefined;
  const note = short(value.note, 200);
  const excerpt = short(value.excerpt);
  const stage = SITE_STAGES.find((each) => each === value.stage);
  const createdAt = short(value.createdAt, 64);
  const page = isRecord(value.page) ? value.page : {};
  const url = short(page.url);
  const path = short(page.path);
  if (note === undefined || note === '' || excerpt === undefined || stage === undefined) return undefined;
  if (createdAt === undefined || url === undefined || path === undefined) return undefined;
  const author = short(value.author, 200);
  const reference = short(value.reference, 200);

  return {
    note,
    excerpt,
    page: { url, path },
    stage,
    ...(author === undefined || author === '' ? {} : { author }),
    ...(reference === undefined || reference === '' ? {} : { reference }),
    createdAt,
  };
}
