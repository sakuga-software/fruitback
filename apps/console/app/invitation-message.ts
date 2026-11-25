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

/**
 * The same, for several addresses invited at once (FRU-691): one sentence for the addresses whose
 * message became the same, so the block does not say « this link » once an address.
 */
export const INVITED_SEVERAL: Readonly<Record<Message, string>> = {
  sent: msg('Invitations sent to {emails}. You can also send them this link:'),
  'no-mailer': msg('Invitations kept for {emails}. Send them this link:'),
  held: msg(
    'Invitations kept for {emails}, but no message was sent: too many invitation messages went in a short time. Send them this link:',
  ),
};

/** The sentences of the block of what was invited: one a kind of message, in the order of the first address. */
export function invitedSentences(sent: readonly { email: string; message: Message }[]): readonly {
  message: Message;
  emails: readonly string[];
}[] {
  const groups: { message: Message; emails: string[] }[] = [];
  for (const each of sent) {
    const group = groups.find((one) => one.message === each.message);
    if (group === undefined) groups.push({ message: each.message, emails: [each.email] });
    else group.emails.push(each.email);
  }

  return groups;
}
