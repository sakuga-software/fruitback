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
import { Button, Field, LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { ONE_ROW, PROVIDER_NAMES, Row, SectionHelp, SectionTitle } from './account-rows';
import { Disconnect as AsksTwice } from './connector-parts';

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
 * The addresses of the account (FRU-450). `onPrimary` hears the primary one each time it is read or
 * chosen: the page shows it in the other sections at once.
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
  // What is typed stays in the field when the worker refuses it.
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<string | undefined>();
  const [addressStuck, setAddressStuck] = useState<{ email: string; problem: string } | undefined>();
  const [madePrimary, setMadePrimary] = useState<string | undefined>();

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
    setAddressStuck(undefined);
    setMadePrimary(undefined);
    const removed = await removeAccountEmail(email);
    if (!removed.ok && removed.status !== 404) {
      return setAddressStuck({ email, problem: problemOf(removed, ADDRESS_PROBLEMS, ADDRESS_NOT_REMOVED) });
    }
    await readEmails();
  }

  return (
    <section aria-labelledby="addresses-title">
      <SectionTitle id="addresses-title">{t('Addresses')}</SectionTitle>
      <SectionHelp>
        {t(
          'A sign-in link sent to any of them opens your account, and their invitations are yours. Your notes and the messages of Fruitback use the primary one.',
        )}
      </SectionHelp>
      {madePrimary === undefined ? null : (
        <p role="status" className="mb-[12px] text-small text-muted [overflow-wrap:anywhere]">
          {t('{email} is your primary address now. Fruitback sent a message to both addresses.', {
            email: madePrimary,
          })}
        </p>
      )}
      {emails === 'loading' ? (
        <div className={ONE_ROW}>
          <p className="text-small text-muted">{t('Loading…')}</p>
        </div>
      ) : null}
      {emails === 'failed' ? (
        <div className={`${ONE_ROW} gap-[12px]`}>
          <p role="alert" className="min-w-0 flex-1 text-small text-muted">
            {t('The addresses of your account did not load.')} <ReadProblem />
          </p>
          <Button tone="outline" onClick={() => void readEmails()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof emails === 'string' ? null : (
        <>
          <ul className="border-t border-line text-body">
            {emails.emails.map((address) => (
              <Row
                key={address.email}
                title={address.email}
                detail={addressWord(address)}
                under={addressStuck?.email === address.email ? <Problem>{t(addressStuck.problem)}</Problem> : undefined}
              >
                {address.primary ? null : (
                  <span className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px]">
                    <LinkButton space="normal" onClick={() => void choosePrimary(address.email)}>
                      {t('Make primary')}
                    </LinkButton>
                    {address.providers.length === 0 ? (
                      <AsksTwice
                        space="normal"
                        label={t('Remove')}
                        confirmLabel={t('Remove {email}', { email: address.email })}
                        keepLabel={t('Keep it')}
                        consequence={t('A sign-in link sent there no longer opens your account.')}
                        onConfirm={() => void removeEmail(address.email)}
                      />
                    ) : null}
                  </span>
                )}
              </Row>
            ))}
          </ul>
          {emails.canAdd ? (
            <form
              onSubmit={(event) => void addEmail(event)}
              aria-label={t('Add an address')}
              className="mt-[16px] flex flex-wrap items-end gap-[10px]"
            >
              <div className="min-w-0 flex-[999_1_260px]">
                <Field
                  label={t('Add an address')}
                  type="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
              </div>
              <Button tone="outline" type="submit" disabled={adding || newEmail.trim() === ''}>
                {t('Send a link')}
              </Button>
            </form>
          ) : (
            <p className="mt-[12px] text-small text-muted">
              {t('This Fruitback sends no email: an address is added by a linked provider only.')}
            </p>
          )}
          {sentTo === undefined ? null : (
            <p role="status" className="mt-[12px] text-small text-muted [overflow-wrap:anywhere]">
              {t('Fruitback sent a link to {email}. Open it in this browser within a day: the address is added then.', {
                email: sentTo,
              })}
            </p>
          )}
          {addProblem === undefined ? null : (
            <div className="mt-[12px]">
              <Problem>{t(addProblem)}</Problem>
            </div>
          )}
        </>
      )}
    </section>
  );
}
