import type { TabCommand } from './protocol.ts';
import { type TabCommandRequest, tabCommand } from './tab-command.ts';

/**
 * The keyboard shortcut that starts a note (FRU-291).
 *
 * A command of the manifest, so the browser owns the key: it works on any page the extension
 * serves, a person changes it in the shortcut settings of the browser, and the page never sees the
 * keystroke. The widget itself listens to no shortcut: a key on the page would take one from the
 * site under review.
 */

/** The name of the command in the manifest. It is also the command sent to the widget of the tab. */
export const LEAVE_FEEDBACK_COMMAND = 'leave-feedback';

/**
 * The key suggested at install, the one the mock-up of 2026-10-20 shows.
 *
 * On macOS, `Alt` is Option. A browser does not assign a suggested key that another extension
 * already holds: the command is then installed with no key, and the options page says so.
 */
export const SUGGESTED_KEY = 'Alt+Shift+F';

/** The `commands` entry of the manifest. */
export const MANIFEST_COMMANDS = {
  [LEAVE_FEEDBACK_COMMAND]: {
    suggested_key: { default: SUGGESTED_KEY },
    description: 'Leave feedback on this page',
  },
} as const;

/** The command for the widget of the tab, for a command of the manifest. Another name is not ours. */
export function tabCommandFor(command: string): TabCommand | undefined {
  return command === LEAVE_FEEDBACK_COMMAND ? 'leave-feedback' : undefined;
}

/**
 * What `commands.onCommand` does: the command of the popup button, sent to the tab the key was
 * pressed on. A tab with no widget has no bridge to answer, so the refusal is dropped: nothing
 * happens there, as nothing would have been there to click. Answers whether a message was sent.
 */
export function runShortcut(
  command: string,
  tab: { id?: number } | undefined,
  send: (tabId: number, message: TabCommandRequest) => Promise<unknown>,
): boolean {
  const forTab = tabCommandFor(command);
  if (forTab === undefined || tab?.id === undefined) return false;
  void send(tab.id, tabCommand(forTab)).catch(() => undefined);

  return true;
}

/** A command as `commands.getAll()` gives it. */
export type BrowserCommand = { name?: string; shortcut?: string };

/** The key of the command now, or `undefined` when the person removed it or the browser gave none. */
export function currentShortcut(commands: readonly BrowserCommand[]): string | undefined {
  const shortcut = commands.find((command) => command.name === LEAVE_FEEDBACK_COMMAND)?.shortcut;

  return shortcut === undefined || shortcut === '' ? undefined : shortcut;
}

/** Where Chrome, Edge and the other Chromium browsers let a person change the key. */
export const CHROMIUM_SHORTCUTS_URL = 'chrome://extensions/shortcuts';
