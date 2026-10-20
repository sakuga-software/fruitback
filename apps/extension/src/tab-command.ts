import {
  type CommandResponseMessage,
  MAX_ID_LENGTH,
  PANEL_LIMITS,
  type PageCounts,
  NOTES_READINGS,
  type NotesReading,
  type PanelNote,
  REPLY_OUTCOMES,
  type ReplyOutcome,
  TAB_COMMANDS,
  type TabCommand,
  parsePageCounts,
  parsePanelNotes,
} from './protocol.ts';

/**
 * The popup's way to the widget of the tab it was opened on (FRU-254): « Leave feedback », « Show
 * every note of the page », and the counts of « On this page ». And the side panel's (FRU-299): the
 * notes of the page, « Show on the page », and « Reply ».
 *
 * popup → `tabs.sendMessage` → the isolated world of the tab (`bridge.content.ts`) → `postMessage`
 * → the main world, which holds the widget. No permission: `tabs.sendMessage` needs none, and the
 * bridge is only there on a site somebody turned on.
 */

export const TAB_COMMAND_TYPE = 'fruitback-tab-command';

/**
 * What the isolated world of a tab sends when the notes of its widget changed (FRU-299). The side
 * panel reads it as « ask for the notes again », and as the note to open. It carries no note.
 */
export const PANEL_EVENT_TYPE = 'fruitback-panel-event';

/** The note to open, from an event of `PANEL_EVENT_TYPE`, or `null` for « read again »; `undefined`: not one. */
export function panelEvent(message: unknown): { open?: string } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, open } = message as Record<string, unknown>;
  if (type !== PANEL_EVENT_TYPE) return undefined;

  return typeof open === 'string' && open !== '' && open.length <= MAX_ID_LENGTH ? { open } : {};
}

/**
 * How long a command waits for the widget. The main world answers at once, or is not there; a
 * reply waits for the worker, then for a read of the page.
 */
export function commandTimeout(command: TabCommand): number {
  return command === 'reply' ? 20_000 : 1_500;
}

/** `note` and `body`: the note of `focus-note` and `reply`, and the text of `reply` (FRU-299). */
export type TabCommandArguments = { note?: string; body?: string };
export type TabCommandRequest = { type: typeof TAB_COMMAND_TYPE; command: TabCommand } & TabCommandArguments;
/**
 * `busy`: the widget is there and said no. Not done and not busy: no widget answered. `notes`: the
 * answer of `notes`; `outcome`: the answer of `reply` (FRU-299).
 */
export type TabCommandAnswer = {
  done: boolean;
  busy?: true;
  counts?: PageCounts;
  notes?: PanelNote[];
  outcome?: ReplyOutcome;
  reading?: NotesReading;
};

/** What the popup, or the side panel, sends. */
export function tabCommand(command: TabCommand, args: TabCommandArguments = {}): TabCommandRequest {
  return {
    type: TAB_COMMAND_TYPE,
    command,
    ...(args.note === undefined ? {} : { note: args.note }),
    ...(args.body === undefined ? {} : { body: args.body }),
  };
}

/** The sender of a runtime message, as `browser.runtime.onMessage` gives it. */
export type Sender = { id?: string; tab?: unknown; url?: string };

/**
 * The command, when it comes from a page of this extension and from nothing else.
 *
 * **A content script is not a page of the extension**: a message from the bridge of another tab
 * carries `sender.tab`, and a reviewed page could have that bridge post for it. Another extension
 * carries another `id`. Both are refused, so only the popup (or the options page) drives a widget.
 */
export function acceptedCommand(
  message: unknown,
  sender: Sender,
  extensionId: string,
  extensionOrigin: string,
): TabCommand | undefined {
  return acceptedRequest(message, sender, extensionId, extensionOrigin)?.command;
}

/** The same, with the note and the text a command of the side panel carries (FRU-299). */
export function acceptedRequest(
  message: unknown,
  sender: Sender,
  extensionId: string,
  extensionOrigin: string,
): ({ command: TabCommand } & TabCommandArguments) | undefined {
  if (sender.id !== extensionId || sender.tab !== undefined) return undefined;
  if (sender.url !== undefined && !sender.url.startsWith(extensionOrigin)) return undefined;
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, command, note, body } = message as Record<string, unknown>;
  if (type !== TAB_COMMAND_TYPE) return undefined;
  const known = TAB_COMMANDS.find((each) => each === command);
  if (known === undefined) return undefined;

  return {
    command: known,
    ...(typeof note === 'string' && note !== '' && note.length <= MAX_ID_LENGTH ? { note } : {}),
    ...(typeof body === 'string' && body.length <= PANEL_LIMITS.text ? { body } : {}),
  };
}

/** The answer, read back: an unknown shape is « not done ». */
export function parseAnswer(value: unknown): TabCommandAnswer {
  if (typeof value !== 'object' || value === null) return { done: false };
  const { done, busy, counts, notes, outcome, reading } = value as Record<string, unknown>;
  const parsed = parsePageCounts(counts);
  const listed = parsePanelNotes(notes);
  const replied = REPLY_OUTCOMES.find((each) => each === outcome);
  const why = NOTES_READINGS.find((each) => each === reading);

  return {
    done: done === true,
    ...(busy === true && done !== true ? { busy: true as const } : {}),
    ...(parsed === undefined ? {} : { counts: parsed }),
    ...(listed === undefined ? {} : { notes: listed }),
    ...(replied === undefined ? {} : { outcome: replied }),
    ...(why === undefined ? {} : { reading: why }),
  };
}

/**
 * The answer the isolated world hands back for a response of the main world: every field the
 * response carries, in one answer (raised in review: `done` and `outcome` travel together).
 */
export function answerOf(message: CommandResponseMessage): TabCommandAnswer {
  return {
    done: message.done,
    ...(message.busy === true ? { busy: true as const } : {}),
    ...(message.counts === undefined ? {} : { counts: message.counts }),
    ...(message.notes === undefined ? {} : { notes: message.notes }),
    ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
    ...(message.reading === undefined ? {} : { reading: message.reading }),
  };
}
