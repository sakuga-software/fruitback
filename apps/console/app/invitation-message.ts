import type { Invitation } from './api.ts';
import { msg } from './i18n.ts';

/** What became of the message of an invitation that the worker kept. */
export type Message = 'sent' | 'no-mailer' | 'held';

/**
 * `held`: the worker sends mail, and sent none for this one: the address, the person who invites or
 * the workspace is past its count. The invitation is kept all the same, and its link is given by hand.
 */
export function messageOf(invitation: Invitation, mails: boolean): Message {
  if (!mails) return 'no-mailer';

  return invitation.mailed === false ? 'held' : 'sent';
}

export const INVITED: Readonly<Record<Message, string>> = {
  sent: msg('Invitation sent to {email}. You can also send them this link:'),
  'no-mailer': msg('Invitation kept for {email}. Send them this link:'),
  held: msg(
    'Invitation kept for {email}, but no message was sent: too many invitation messages went in a short time. Send them this link:',
  ),
};
