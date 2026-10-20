/**
 * The widget of a tab asks for the sign-in (FRU-315), through the isolated world, to the background,
 * which opens the popup: the popup is where a sign-in starts and where its word is compared.
 *
 * A content script sends it, so the page can have it sent: `acceptedSignIn` takes it only from a
 * tab, of this extension, and the background opens the popup only for a site whose rule wants a
 * session it does not have. At worst a page opens the popup of the extension over itself.
 */
export const SIGN_IN_TYPE = 'fruitback-sign-in';

export const SIGN_IN_REQUEST = { type: SIGN_IN_TYPE } as const;

/** The sender of a runtime message, as `browser.runtime.onMessage` gives it. */
export type SignInSender = { id?: string; tab?: { id?: number; url?: string; windowId?: number } };

/** The tab that asked, when the message is ours and comes from a tab of this extension's content scripts. */
export function acceptedSignIn(message: unknown, sender: SignInSender, extensionId: string): SignInSender['tab'] {
  if (sender.id !== extensionId || sender.tab === undefined) return undefined;
  if (typeof message !== 'object' || message === null) return undefined;

  return (message as { type?: unknown }).type === SIGN_IN_TYPE ? sender.tab : undefined;
}
