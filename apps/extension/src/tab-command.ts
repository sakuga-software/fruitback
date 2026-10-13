import { type PageCounts, TAB_COMMANDS, type TabCommand, parsePageCounts } from './protocol.ts';

/**
 * The popup's way to the widget of the tab it was opened on (FRU-254): « Leave feedback », « Show
 * every note of the page », and the counts of « On this page ».
 *
 * popup → `tabs.sendMessage` → the isolated world of the tab (`bridge.content.ts`) → `postMessage`
 * → the main world, which holds the widget. No permission: `tabs.sendMessage` needs none, and the
 * bridge is only there on a site somebody turned on.
 */

export const TAB_COMMAND_TYPE = 'fruitback-tab-command';

export type TabCommandRequest = { type: typeof TAB_COMMAND_TYPE; command: TabCommand };
export type TabCommandAnswer = { done: boolean; counts?: PageCounts };

/** What the popup sends. */
export function tabCommand(command: TabCommand): TabCommandRequest {
  return { type: TAB_COMMAND_TYPE, command };
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
  if (sender.id !== extensionId || sender.tab !== undefined) return undefined;
  if (sender.url !== undefined && !sender.url.startsWith(extensionOrigin)) return undefined;
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, command } = message as Record<string, unknown>;
  if (type !== TAB_COMMAND_TYPE) return undefined;

  return TAB_COMMANDS.find((each) => each === command);
}

/** The answer, read back: an unknown shape is « not done ». */
export function parseAnswer(value: unknown): TabCommandAnswer {
  if (typeof value !== 'object' || value === null) return { done: false };
  const { done, counts } = value as Record<string, unknown>;
  const parsed = parsePageCounts(counts);

  return { done: done === true, ...(parsed === undefined ? {} : { counts: parsed }) };
}
