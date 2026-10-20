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

import type { TransportRequest, TransportResponse } from '@fruitback/widget';
import { isWorkerEndpoint } from './endpoint.ts';

export const CHANNEL = 'fruitback-extension';

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

/** Long enough for a UUID, short enough that a page cannot post a megabyte of it. */
const MAX_ID_LENGTH = 100;

/**
 * How long the background lets one relayed call run before it aborts it.
 *
 * **The abort is the point, not the deadline.** Without it a worker that accepts a connection and
 * never answers leaves the request in flight while the page is told the call failed — and a reviewer
 * told their note failed presses send again, which plants it twice. The worker cannot tell the two
 * apart (FRU-9 gives a seed its own id, which dedupes a retry of the *same* request, not a second
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
  area: { left: number; top: number; width: number; height: number; scale: number };
};

/** The address of the picture, or nothing: no picture, for whatever reason. */
export type CaptureResponseMessage = {
  channel: typeof CHANNEL;
  kind: 'capture-response';
  id: string;
  picture?: { url: string; width: number; height: number };
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
  /** The note of `focus-note` and `reply` (FRU-299): the id of its seed. */
  note?: string;
  /** The text of `reply`. */
  body?: string;
};

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
] as const;
export type TabCommand = (typeof TAB_COMMANDS)[number];

const STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type PageCounts = Record<(typeof STAGES)[number], number>;

/** What `reply` answers: the reply is in the store, or why it is not. */
export const REPLY_OUTCOMES = ['sent', 'retry', 'wait', 'signed-out', 'refused'] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

/** A note of the page as the side panel lists it (FRU-299): the `PageNote` of the widget, parsed. */
export type PanelNote = {
  id: string;
  number?: number;
  stage: (typeof STAGES)[number];
  note: string;
  author?: string;
  mine?: true;
  createdAt: string;
  updatedAt: string;
  replies: { author?: string; body: string; createdAt: string }[];
  canReply: boolean;
  placement: 'found' | 'approximate' | 'detached';
};

/** The bounds of what a page may hand the panel: it crosses a world the page writes in. */
export const PANEL_LIMITS = { notes: 500, replies: 200, text: 10_000, name: 200, date: 64 } as const;
const PLACEMENTS = ['found', 'approximate', 'detached'] as const;

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
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
      replies.push({ ...(by === undefined ? {} : { author: by }), body, createdAt: at });
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
    notes.push({
      id,
      ...(number === undefined ? {} : { number }),
      stage,
      note,
      ...(author === undefined ? {} : { author }),
      ...(entry.mine === true ? { mine: true as const } : {}),
      createdAt,
      updatedAt,
      replies,
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
  | AnnounceMessage
  | RelayRequestMessage
  | RelayResponseMessage
  | CaptureRequestMessage
  | CaptureResponseMessage
  | SessionMessage
  | SignInMessage;

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
  if (data.kind === 'ready') return { channel: CHANNEL, kind: 'ready' };
  if (data.kind === 'announce') return { channel: CHANNEL, kind: 'announce' };
  if (data.kind === 'sign-in') return { channel: CHANNEL, kind: 'sign-in' };
  if (data.kind === 'session') {
    return typeof data.signedOut === 'boolean'
      ? { channel: CHANNEL, kind: 'session', signedOut: data.signedOut }
      : undefined;
  }
  if (data.kind === 'relay-request') return parseRelayRequestMessage(data);
  if (data.kind === 'relay-response') return parseRelayResponseMessage(data);
  if (data.kind === 'capture-request') return parseCaptureRequest(data);
  if (data.kind === 'capture-response') return parseCaptureResponse(data);
  if (data.kind === 'command') return parseCommand(data);
  if (data.kind === 'command-response') return parseCommandResponse(data);
  if (data.kind === 'notes-changed') {
    const open = parseId(data.open);

    return { channel: CHANNEL, kind: 'notes-changed', ...(open === undefined ? {} : { open }) };
  }
  if (data.kind !== 'mount') return undefined;

  const { endpoint, clientId, label, relay, locale } = data;
  if (!isWorkerEndpoint(endpoint) || !isNonEmptyString(clientId)) return undefined;

  return {
    channel: CHANNEL,
    kind: 'mount',
    endpoint,
    clientId,
    ...(isNonEmptyString(label) ? { label } : {}),
    ...(isNonEmptyString(locale) && locale.length <= 35 ? { locale } : {}),
    ...(relay === true ? { relay: true } : {}),
  };
}

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

  const { url, method, headers, body } = value;
  if (!isWorkerEndpoint(url)) return undefined;
  if (method !== 'GET' && method !== 'POST') return undefined;
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

function isWithinBodyCap(body: unknown): body is string {
  return typeof body === 'string' && new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES;
}

/** A number a screen can have: finite, and not past a side of 100 000 pixels. */
function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
}

function parseCaptureRequest(data: Record<string, unknown>): CaptureRequestMessage | undefined {
  const id = parseId(data.id);
  if (id === undefined || !isRecord(data.area)) return undefined;
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
  const ok =
    picture !== undefined &&
    isWorkerEndpoint(picture.url) &&
    typeof picture.width === 'number' &&
    typeof picture.height === 'number';

  return {
    channel: CHANNEL,
    kind: 'capture-response',
    id,
    ...(ok
      ? { picture: { url: picture.url as string, width: picture.width as number, height: picture.height as number } }
      : {}),
  };
}

function parseCommand(data: Record<string, unknown>): CommandMessage | undefined {
  const id = parseId(data.id);
  const command = TAB_COMMANDS.find((each) => each === data.command);
  if (id === undefined || command === undefined) return undefined;
  const note = parseId(data.note);
  const body = boundedString(data.body, PANEL_LIMITS.text);

  return {
    channel: CHANNEL,
    kind: 'command',
    id,
    command,
    ...(note === undefined ? {} : { note }),
    ...(body === undefined ? {} : { body }),
  };
}

function parseCommandResponse(data: Record<string, unknown>): CommandResponseMessage | undefined {
  const id = parseId(data.id);
  if (id === undefined) return undefined;
  const counts = parsePageCounts(data.counts);
  const notes = parsePanelNotes(data.notes);
  const outcome = REPLY_OUTCOMES.find((each) => each === data.outcome);

  return {
    channel: CHANNEL,
    kind: 'command-response',
    id,
    done: data.done === true,
    ...(data.busy === true ? { busy: true as const } : {}),
    ...(counts === undefined ? {} : { counts }),
    ...(notes === undefined ? {} : { notes }),
    ...(outcome === undefined ? {} : { outcome }),
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
