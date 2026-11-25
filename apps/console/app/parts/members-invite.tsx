import { type FormEvent, useRef, useState } from 'react';
import { type Invitation, type SiteChoice, invitationLink } from '../api';
import { addressesIn, addressesLeft } from '../invite-addresses';
import { copyText } from '../problems';
import { Button, Choice, Dialog, DialogFoot, Field, Problem, RadioCards } from '../ui';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteName } from '../site-address';

/** The roles an invitation gives: the worker refuses the others (FRU-104), and a guest names a site (FRU-250). */
export type InvitedRole = 'guest' | 'member' | 'admin';

/** What one invitation became: the invitation the worker kept, or the sentence of its refusal. */
export type Sent = { ok: true; invitation: Invitation } | { ok: false; problem: string };

/** The three roles of the dialog, in the order of the mockup, each with what it lets its person do. */
const ROLES: readonly { role: InvitedRole; name: string; does: string }[] = [
  { role: 'admin', name: msg('Admin'), does: msg('Sites, members, connectors') },
  { role: 'member', name: msg('Member'), does: msg('Sees and leaves notes') },
  { role: 'guest', name: msg('Guest'), does: msg('Only the site you pick') },
];

/**
 * « Invite people » (FRU-691), the dialog of 480 px of the mockup: « Emails », which takes several
 * addresses; the role as three cards, each with what it lets its person do; « Sites »; and in its
 * foot « Copy invite link », « Cancel » and « Send N invites », which counts the valid addresses.
 *
 * Focus is kept inside, Escape and the close button close it, and focus goes back to « Invite » (the
 * `Dialog` of the kit). What is typed stays when it closes, and through a read that failed (FRU-616):
 * the screen keeps this component mounted. The invitations go one after the other; the addresses that
 * went leave the field, and the ones the worker refused stay in it with their sentence.
 *
 * It opens on « Member » (FRU-250): the sites arrive after the screen, and a form that opened on a
 * guest would grow a field under a press and send a role nobody chose. « Guest » is offered when the
 * workspace has a site, and « Sites » then lists them, one to choose.
 */
export function InviteDialog({
  open,
  onClose,
  sites,
  invite,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  /** The sites of the workspace, once read. */
  sites: readonly SiteChoice[] | undefined;
  /** Sends one invitation. */
  invite: (email: string, role: InvitedRole, site: string | undefined) => Promise<Sent>;
  /** The invitations that the worker kept, in the order they were sent. */
  onInvited: (invitations: readonly Invitation[]) => void;
}) {
  useLocale();
  const [typed, setTyped] = useState('');
  const [role, setRole] = useState<InvitedRole>('member');
  const [site, setSite] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // The refusals of the last send, and how many addresses it sent: one is said alone, several each
  // after its address.
  const [problems, setProblems] = useState<{ sent: number; refused: readonly { email: string; problem: string }[] }>({
    sent: 0,
    refused: [],
  });
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const field = useRef<HTMLInputElement>(null);

  const addresses = addressesIn(typed);
  const count = addresses.valid.length;
  const offersGuest = sites !== undefined && sites.length > 0;
  const chosen: InvitedRole = role === 'guest' && !offersGuest ? 'member' : role;
  const shared = sites?.some((each) => each.id === site) ? site : sites?.[0]?.id;

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || count === 0) return;
    setProblems({ sent: 0, refused: [] });
    setBusy(true);
    const kept: Invitation[] = [];
    const refused: { email: string; problem: string }[] = [];
    for (const email of addresses.valid) {
      const sent = await invite(email, chosen, chosen === 'guest' ? shared : undefined);
      if (sent.ok) kept.push(sent.invitation);
      else refused.push({ email, problem: sent.problem });
    }
    setBusy(false);
    if (kept.length > 0) onInvited(kept);
    // What went leaves the field; what was refused, and what is no address, stays in it.
    setTyped(
      addressesLeft(
        addresses,
        refused.map((each) => each.email),
      ),
    );
    setProblems({ sent: addresses.valid.length, refused });
    if (refused.length === 0 && addresses.invalid.length === 0) return onClose();
    // The button was disabled while it sent, so focus left it: it goes back to the field, where the
    // sentence of the refusal is read next.
    field.current?.focus();
  }

  let label = t('Send invites');
  if (busy) label = t('Sending…');
  else if (count === 1) label = t('Send 1 invite');
  else if (count > 1) label = t('Send {count} invites', { count });

  return (
    <Dialog open={open} onClose={onClose} title={t('Invite people')} closeLabel={t('Close')} size="form" framed>
      <form onSubmit={(event) => void send(event)} aria-label={t('Invite people')} className="flex flex-col">
        <div className="flex flex-col gap-[16px] px-[20px] py-[16px]">
          <Field
            label={t('Emails')}
            someoneElse
            autoFocus
            inputRef={field}
            placeholder={t('name@company.com, another@company.com')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            {...(addresses.invalid.length === 0
              ? {}
              : { hint: t('Not an address, so not sent: {typed}', { typed: addresses.invalid.join(', ') }) })}
          />
          <RadioCards
            label={t('Role')}
            value={chosen}
            onChange={setRole}
            options={ROLES.map((each) => {
              const off = each.role === 'guest' && !offersGuest;

              return {
                value: each.role,
                label: t(each.name),
                detail: off ? t('Add a site first') : t(each.does),
                disabled: off,
              };
            })}
          />
          {chosen === 'guest' && shared !== undefined ? (
            <Choice
              label={t('Sites')}
              value={shared}
              onChange={setSite}
              options={(sites ?? []).map((each) => ({ value: each.id, label: siteName(each.origin) }))}
            />
          ) : (
            // A role other than « Guest » reads every site: the value is set by the role, and drawn as such.
            <Field label={t('Sites')} value={t('Every site')} locked />
          )}
          {problems.refused.length === 0 ? null : (
            <Problem>
              {problems.sent === 1
                ? t(problems.refused[0]!.problem)
                : problems.refused.map((each) => (
                    <span key={each.email} className="block">
                      {each.email}: {t(each.problem)}
                    </span>
                  ))}
            </Problem>
          )}
          {copied === 'refused' ? (
            <Problem>
              {t('The browser refused the copy. The link is {link}: copy it by hand.', { link: invitationLink() })}
            </Problem>
          ) : null}
        </div>
        <DialogFoot>
          <Button
            tone="ghost"
            size="panel"
            onClick={() => void copyText(invitationLink()).then((taken) => setCopied(taken ? 'yes' : 'refused'))}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path
                d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {copied === 'yes' ? t('Copied') : t('Copy invite link')}
          </Button>
          <span className="ml-auto" />
          <Button tone="outline" size="panel" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" size="panel" disabled={busy || count === 0}>
            {label}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
