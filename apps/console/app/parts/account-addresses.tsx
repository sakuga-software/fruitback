import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type AccountEmail,
  type AccountEmails,
  accountEmails,
  addAccountEmail,
  makePrimaryEmail,
  removeAccountEmail,
} from '../api';
import { msg, t } from '../i18n';
import type { Fetched } from '../listed';
import { problemOf } from '../problems';
import { ReadProblem } from '../read-problem';
import { Confirmation } from '../confirm';
import { SettingsIcon } from '../settings-icons';
import { Button, Chip, Dialog, Field, Menu, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { CardNote, ONE_ROW, PROVIDER_NAMES, Row, RowMark, SettingsCard } from './account-rows';

/** Why an address was not sent its link (FRU-450). Whose an address is, the worker does not say. */
const ADD_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-email': msg('Type one email address, like name@company.com.'),
  'email-taken': msg('This address is the one of another Fruitback account. An address opens one account only.'),
  'already-yours': msg('This address is already one of your account.'),
  'too-many-addresses': msg('Too many links were sent in the last hour. Try again later.'),
  'mail-unavailable': msg('The link could not be sent. Try again.'),
};
const NOT_SENT = msg('The link was not sent. Try again.');
/** Why an address is still there, or is still not the primary one. */
const ADDRESS_PROBLEMS: Readonly<Record<string, string>> = {
  'primary-address': msg('This is your primary address. Make another one primary first.'),
  'provider-address': msg('A linked provider gives this address. Unlink it under « How you sign in » to take it away.'),
  'sign-in-again': msg('Sign in again first: the primary address changes only in the day after a sign-in.'),
  'not-found': msg('This address is no longer one of your account. Reload the page.'),
};
const NOT_MADE_PRIMARY = msg('The primary address did not change. Try again.');
const ADDRESS_NOT_REMOVED = msg('The address was not removed. Try again.');

/** What the row of an address says under it: primary, which provider gives it, whether Fruitback proved it. */
function addressWord(address: AccountEmail): string {
  if (address.primary) return t('Primary · on your notes and in the messages of Fruitback');
  const parts = [
    ...address.providers.map((provider) => t('From {provider}', { provider: PROVIDER_NAMES[provider] })),
    ...(address.verified ? [t('Verified by Fruitback')] : []),
  ];

  return parts.join(' · ');
}

/**
 * The addresses of the account (FRU-450), a card of the profile (FRU-692). `onPrimary` hears the
 * primary one each time it is read or chosen: the page shows it in the other cards at once.
 *
 * The primary address says so. Each other one has a menu: « Make primary », and « Remove » for an
 * address no provider gives, which asks twice under its row. « Add » opens a dialog that sends the
 * link that adds an address.
 */
export function AddressesSection({ workspace, onPrimary }: { workspace: string; onPrimary: (email: string) => void }) {
  useLocale();
  // No list is not an empty list.
  const [emails, setEmails] = useState<Fetched<AccountEmails>>('loading');
  const readEmails = useCallback(async () => {
    const listed = await accountEmails();
    setEmails(listed.ok ? listed.data : 'failed');
    if (listed.ok) {
      const first = listed.data.emails.find((each) => each.primary);
      if (first !== undefined) onPrimary(first.email);
    }
  }, [onPrimary]);
  useEffect(() => void readEmails(), [readEmails]);
  // What is typed stays in the field when the worker refuses it, and when the dialog closes.
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addProblem, setAddProblem] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<string | undefined>();
  const [addressStuck, setAddressStuck] = useState<{ email: string; problem: string } | undefined>();
  const [madePrimary, setMadePrimary] = useState<string | undefined>();
  // The address whose « Remove » was chosen in its menu: its row asks the second time.
  const [removing, setRemoving] = useState<string | undefined>();

  async function addEmail(event: FormEvent) {
    event.preventDefault();
    if (adding) return;
    setAddProblem(undefined);
    setSentTo(undefined);
    setAdding(true);
    const sent = await addAccountEmail(newEmail.trim());
    setAdding(false);
    if (!sent.ok) return setAddProblem(problemOf(sent, ADD_PROBLEMS, NOT_SENT));
    setSentTo(sent.data.email);
    setNewEmail('');
    setAddOpen(false);
  }

  async function choosePrimary(email: string) {
    setAddressStuck(undefined);
    setMadePrimary(undefined);
    const chosen = await makePrimaryEmail(email, workspace);
    if (!chosen.ok) return setAddressStuck({ email, problem: problemOf(chosen, ADDRESS_PROBLEMS, NOT_MADE_PRIMARY) });
    onPrimary(chosen.data.email);
    setMadePrimary(chosen.data.email);
    await readEmails();
  }

  async function removeEmail(email: string) {
    setRemoving(undefined);
    setAddressStuck(undefined);
    setMadePrimary(undefined);
    const removed = await removeAccountEmail(email);
    if (!removed.ok && removed.status !== 404) {
      return setAddressStuck({ email, problem: problemOf(removed, ADDRESS_PROBLEMS, ADDRESS_NOT_REMOVED) });
    }
    await readEmails();
  }

  /** Under the row of an address: the second time of « Remove », or why its action did not go through. */
  function rowUnder(email: string) {
    if (removing === email)
      return (
        <Confirmation
          confirmLabel={t('Remove {email}', { email })}
          keepLabel={t('Keep it')}
          consequence={t('A sign-in link sent there no longer opens your account.')}
          onConfirm={() => void removeEmail(email)}
          onKeep={() => setRemoving(undefined)}
        />
      );
    if (addressStuck?.email === email) return <Problem>{t(addressStuck.problem)}</Problem>;

    return undefined;
  }

  const add =
    typeof emails === 'object' && emails.canAdd ? (
      <Button
        tone="outline"
        size="small"
        onClick={() => {
          setAddProblem(undefined);
          setAddOpen(true);
        }}
      >
        <SettingsIcon name="add" size={14} />
        {t('Add')}
      </Button>
    ) : undefined;

  return (
    <SettingsCard
      id="addresses-title"
      icon="mail"
      title={t('Addresses')}
      {...(add === undefined ? {} : { actions: add })}
    >
      {emails === 'loading' ? (
        <div className={ONE_ROW}>
          <p className="text-tiny text-muted">{t('Loading…')}</p>
        </div>
      ) : null}
      {emails === 'failed' ? (
        <div className={ONE_ROW}>
          <p role="alert" className="min-w-0 flex-1 text-tiny text-muted">
            {t('The addresses of your account did not load.')} <ReadProblem />
          </p>
          <Button tone="outline" size="small" onClick={() => void readEmails()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof emails === 'string' ? null : (
        <>
          <ul>
            {emails.emails.map((address) => (
              <Row
                key={address.email}
                icon={<RowMark name="mail" />}
                title={address.email}
                detail={addressWord(address)}
                under={rowUnder(address.email)}
              >
                {address.primary ? (
                  <Chip>{t('Primary')}</Chip>
                ) : (
                  <Menu
                    trigger="icon"
                    triggerLabel={t('More for {email}', { email: address.email })}
                    items={[
                      { id: 'primary', label: t('Make primary') },
                      ...(address.providers.length === 0 ? [{ id: 'remove', label: t('Remove'), danger: true }] : []),
                    ]}
                    onAction={(id) => {
                      if (id === 'primary') return void choosePrimary(address.email);
                      setAddressStuck(undefined);
                      setRemoving(address.email);
                    }}
                  >
                    <SettingsIcon name="more" />
                  </Menu>
                )}
              </Row>
            ))}
          </ul>
          {madePrimary === undefined ? null : (
            <CardNote status>
              {t('{email} is your primary address now. Fruitback sent a message to both addresses.', {
                email: madePrimary,
              })}
            </CardNote>
          )}
          {sentTo === undefined ? null : (
            <CardNote status>
              {t('Fruitback sent a link to {email}. Open it in this browser within a day: the address is added then.', {
                email: sentTo,
              })}
            </CardNote>
          )}
          {emails.canAdd ? null : (
            <CardNote>{t('This Fruitback sends no email: an address is added by a linked provider only.')}</CardNote>
          )}
        </>
      )}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('Add an address')}
        closeLabel={t('Close')}
        size="sm"
      >
        <form
          onSubmit={(event) => void addEmail(event)}
          aria-label={t('Add an address')}
          className="flex flex-col gap-[12px]"
        >
          <p className="text-hint text-muted">
            {t(
              'A sign-in link sent to any of them opens your account, and their invitations are yours. Your notes and the messages of Fruitback use the primary one.',
            )}
          </p>
          <Field
            label={t('Address')}
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
          />
          {addProblem === undefined ? null : <Problem>{t(addProblem)}</Problem>}
          <div className="flex flex-wrap justify-end gap-[8px]">
            <Button tone="outline" size="small" onClick={() => setAddOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button size="small" type="submit" disabled={adding || newEmail.trim() === ''}>
              {t('Send a link')}
            </Button>
          </div>
        </form>
      </Dialog>
    </SettingsCard>
  );
}
