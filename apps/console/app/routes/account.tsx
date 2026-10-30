import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  type AccountEmail,
  type AccountEmails,
  type ConsoleSession,
  type ExtensionBrowser,
  LINKABLE,
  type Linkable,
  accountEmails,
  addAccountEmail,
  makePrimaryEmail,
  removeAccountEmail,
  type PendingLink,
  type SignInMethods,
  cancelLink,
  confirmLink,
  consoleSessions,
  endConsoleSession,
  endExtensionBrowser,
  extensionBrowsers,
  linkAddress,
  pendingLink,
  renameMe,
  saveLanguage,
  signInMethods,
  signOut,
  signOutEverywhere,
  unlinkProvider,
} from '../api';
import { ago } from '../ago';
import { type Listed, edited } from '../listed';
import { problemOf } from '../problems';
import { Button, Choice, Field, LinkButton, Problem } from '../ui';
import { Disconnect as AsksTwice } from './connector-parts';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * My account, as screen 13 of the mockup of 2026-10-13 draws it (FRU-248, FRU-249): the profile, how
 * the person signs in, the browsers where the console is signed in, and the end of the workspace for
 * its owner.
 *
 * The name is changed here, and a provider linked or unlinked (FRU-249). The browsers of the
 * extension are not listed yet: their route comes with the session of an account (FRU-238).
 */

/** `asking`: the worker has not answered yet. `silent`: it did not say, and nothing is in flight. */
type Asked = SignInMethods | 'asking' | 'silent';

const PROVIDER_NAMES: Readonly<Record<Linkable, string>> = { github: 'GitHub', google: 'Google' };

/** What the page says of one provider. WARNING: « Not set up » only when the worker said so. */
function providerWord(asked: Asked, provider: Linkable): string {
  if (asked === 'asking') return msg('Checking…');
  if (asked === 'silent') return msg('Could not check');
  const known = asked[provider];
  if (known === undefined) return msg('Not set up');

  return known.linked ? msg('Linked') : msg('Not linked');
}

/**
 * Why a provider did not link, by the code the worker puts in the address on the way back (FRU-416):
 * each sentence names the provider and the address of the account, then says what to do.
 *
 * better-auth 1.7.7 writes `email_does_not_match`; `email_doesn't_match` is its spelling of before.
 * It answers an address that the provider did not verify with `unable_to_link_account` (read in
 * `oauth2/link-account.mjs`, and held by a test of the worker). The same code says a write that
 * failed, so its sentence names both causes, and both end with « link again ».
 */
const OTHER_ADDRESS = msg(
  'Your {provider} account does not have the address {email}. Fruitback links only a {provider} account that has the address of your account. In {provider}, choose the account {email}, or keep signing in as you do now.',
);
const NOT_VERIFIED = msg(
  '{provider} did not say that its address is verified. Verify it at {provider}, then link again.',
);
const LINK_PROBLEMS: Readonly<Record<string, string>> = {
  email_does_not_match: OTHER_ADDRESS,
  "email_doesn't_match": OTHER_ADDRESS,
  account_already_linked_to_different_user: msg(
    'This {provider} account already opens another Fruitback account. To link it here, that account must unlink it first, or an administrator of this instance must delete that account.',
  ),
  email_not_verified: NOT_VERIFIED,
  unable_to_link_account: msg(
    '{provider} was not linked. If {provider} has not verified the address of that account, verify it there. Then link again.',
  ),
  identity_required: msg('Your session ended before {provider} was linked. Sign in, then link again.'),
  // FRU-415: a provider of another address is linked, on conditions that the worker reads.
  email_not_found: msg(
    '{provider} gave no address for that account. Fruitback links only an account whose address {provider} verified. Add one at {provider}, then link again.',
  ),
  email_already_used: msg(
    'The address of this {provider} account is the one of another Fruitback account. Fruitback never joins two accounts: link it from that account, or choose another {provider} account.',
  ),
  provider_already_linked: msg(
    'A {provider} account is already linked here. Unlink it first, then link the other one.',
  ),
  link_expired: msg('The link of {provider} waited too long, or was answered in another tab. Link {provider} again.'),
};
/** A code of a failure on the way, not of a refusal: trying again can work. */
const LINK_FAILURES: ReadonlySet<string> = new Set([
  'internal_server_error',
  'link_not_started',
  'unable_to_get_user_info',
  'invalid_code',
]);
const NOT_LINKED = msg('{provider} was not linked.');
const LINK_FAILED = msg('{provider} was not linked. Try again.');
/** A provider that is not in the list of the console, or none: a worker of before sends none. */
const ACCOUNT_NOT_LINKED = msg('The account was not linked.');

/**
 * The sentence of a link that the worker refused. Both values come from the address, which anybody
 * writes: the code is read in own keys only (`?error=constructor` is no method of Object), and the
 * provider in the closed list `LINKABLE`. Neither is ever shown as it is written there.
 */
function linkProblem(code: string, provider: string | null, email: string): string {
  if (provider === null || !(LINKABLE as readonly string[]).includes(provider)) return t(ACCOUNT_NOT_LINKED);
  const named = PROVIDER_NAMES[provider as Linkable];
  if (Object.hasOwn(LINK_PROBLEMS, code)) return t(LINK_PROBLEMS[code] as string, { provider: named, email });

  return t(LINK_FAILURES.has(code) ? LINK_FAILED : NOT_LINKED, { provider: named });
}

/** Why a provider is still there after « Unlink ». */
const UNLINK_PROBLEMS: Readonly<Record<string, string>> = {
  'last-sign-in': msg('This is the last way you sign in here: link another one first.'),
  'sign-in-again': msg('Sign in again first: a way to sign in changes only in the day after a sign-in.'),
  // FRU-450: the provider alone proves the primary address.
  'primary-address': msg(
    '{provider} gives your primary address. Make another address primary first, under « Addresses ».',
  ),
};

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
  'not-found': msg('This address is no longer one of your account.'),
};
const ADDRESS_NOT_CHANGED = msg('Nothing changed. Try again.');
const NOT_UNLINKED = msg('{provider} is still linked. Try again.');

const NAME_PROBLEMS: Readonly<Record<string, string>> = {
  'invalid-name': msg('A name is one line of 1 to 80 characters.'),
};
const NAME_NOT_KEPT = msg('Your name was not changed. Try again.');

/** « 12 Oct », as the mockup writes the day a browser connected. */
function dayOf(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(locale() === 'fr' ? 'fr' : 'en-GB', { day: 'numeric', month: 'short' });
}

/** A day and a time, in the language of the console. */
function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** What the row of an address says under it: primary, which provider gives it, whether Fruitback proved it. */
function addressWord(address: AccountEmail): string {
  if (address.primary) return t('Primary · on your notes and in the messages of Fruitback');
  const parts = [
    ...address.providers.map((provider) => t('From {provider}', { provider: PROVIDER_NAMES[provider] })),
    ...(address.verified ? [t('Verified by Fruitback')] : []),
  ];

  return parts.join(' · ');
}

export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  // The primary address (FRU-450): the person can choose another one here, and this page shows it at once.
  const [primary, setPrimary] = useState(me.account.email);
  const navigate = useNavigate();
  // What the worker signs people in with (FRU-135). A provider is on or "not set up" only when the
  // worker said so: a slow answer and no answer prove neither, and each has its own word.
  const [providers, setProviders] = useState<Asked>('asking');
  const readMethods = useCallback(async () => {
    const asked = await signInMethods();
    setProviders(asked.ok ? asked.data : 'silent');
  }, []);
  useEffect(() => void readMethods(), [readMethods]);

  // The way back of a link: `?linked=<provider>` or `?error=<code>`, said once, then taken away.
  const [params, setParams] = useSearchParams();
  const [linked, setLinked] = useState(() => params.get('linked'));
  // The provider of a link that was refused (FRU-416): it stays with its sentence until the next gesture.
  const [linkError, setLinkError] = useState(() => {
    const code = params.get('error');

    return code === null ? null : { code, provider: params.get('provider') };
  });
  useEffect(() => {
    if (params.has('linked') || params.has('error') || params.has('provider') || params.has('confirm')) {
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  // FRU-415: `?confirm=<provider>`, a link that came back from the provider and that the worker keeps
  // until the person says yes. The question names the provider account the worker read there.
  const [question, setQuestion] = useState<PendingLink | 'reading' | undefined>(() =>
    (LINKABLE as readonly (string | null)[]).includes(params.get('confirm')) ? 'reading' : undefined,
  );
  const [answering, setAnswering] = useState(false);
  const [cancelled, setCancelled] = useState<Linkable | undefined>();
  const asked = useRef(false);
  useEffect(() => {
    if (question !== 'reading' || asked.current) return;
    asked.current = true;
    const provider = params.get('confirm') as Linkable;
    void pendingLink().then((read) => {
      if (read.ok && read.data !== 'none') return setQuestion(read.data);
      setQuestion(undefined);
      setLinkError({ code: read.ok ? 'link_expired' : 'internal_server_error', provider });
    });
  }, [question, params]);

  async function answerLink(yes: boolean) {
    if (typeof question !== 'object' || answering) return;
    const { provider } = question;
    setAnswering(true);
    const answer = yes ? await confirmLink() : await cancelLink();
    setAnswering(false);
    setQuestion(undefined);
    if (!yes) {
      setCancelled(provider);
    } else if (answer.ok) {
      setLinked(provider);
    } else {
      // Own keys only (`linkProblem`): the code is read in `LINK_PROBLEMS`, never shown as written.
      setLinkError({ code: answer.status === 404 ? 'link_expired' : answer.error, provider });
    }
    await readMethods();
  }
  const [unlinkStuck, setUnlinkStuck] = useState<{ provider: Linkable; problem: string } | undefined>();

  async function unlink(provider: Linkable) {
    setUnlinkStuck(undefined);
    setLinkError(null);
    const gone = await unlinkProvider(provider);
    if (!gone.ok && gone.status !== 404) {
      // Own keys only (`problemOf`): a code named `constructor` must not find a method of `Object`.
      setUnlinkStuck({ provider, problem: problemOf(gone, UNLINK_PROBLEMS, NOT_UNLINKED) });
    }
    await readMethods();
  }

  // The name on the notes. What is typed stays when the worker refuses it.
  const [name, setName] = useState(me.account.name ?? '');
  const [nameProblem, setNameProblem] = useState<string | undefined>();
  // The name the worker keeps, and what is in the field now: an answer reads them when it lands, and
  // not as they were when the name left.
  const kept = useRef(me.account.name ?? '');
  const typed = useRef(name);
  typed.current = name;
  // One name on its way at a time: Enter, then leaving the field before the answer, sent it twice.
  const saving = useRef(false);
  async function saveName(event?: FormEvent) {
    event?.preventDefault();
    const sent = typed.current.trim();
    if (saving.current || sent === kept.current.trim()) return;
    saving.current = true;
    setNameProblem(undefined);
    const saved = await renameMe(sent);
    saving.current = false;
    if (!saved.ok) {
      // A newer text typed while this one was on its way is sent in its turn: the refusal was of the
      // name before it.
      if (typed.current.trim() !== sent) return void saveName();
      return setNameProblem(problemOf(saved, NAME_PROBLEMS, NAME_NOT_KEPT));
    }
    kept.current = saved.data.account.name ?? sent;
    // What was typed while the name was on its way stays in the field, and leaves in its turn: the
    // answer never writes over it.
    if (typed.current.trim() !== sent) return void saveName();
    setName(kept.current);
  }
  const [unsent, setUnsent] = useState(false);

  // The browsers where the console is signed in. No list is not an empty list (FRU-162).
  // The browsers of the extension come in the same list, read together: the rows are drawn once, and
  // nothing under them moves when the second answer comes (FRU-271).
  const [sessions, setSessions] = useState<Listed<ConsoleSession>>('loading');
  // The browsers of the extension that could not be read do not take the browsers of the console
  // with them: those stay, with their « Disconnect », and a line says what is missing.
  const [extensions, setExtensions] = useState<ExtensionBrowser[]>([]);
  const [extensionsFailed, setExtensionsFailed] = useState(false);
  const read = useCallback(async () => {
    setSessions('loading');
    const [listed, connected] = await Promise.all([consoleSessions(), extensionBrowsers()]);
    setExtensions(connected.ok ? connected.data : []);
    setExtensionsFailed(!connected.ok);
    setSessions(listed.ok ? listed.data : 'failed');
  }, []);
  const [extensionStuck, setExtensionStuck] = useState<string | undefined>();

  async function disconnectExtension(browser: ExtensionBrowser) {
    setExtensionStuck(undefined);
    const ended = await endExtensionBrowser(browser.id);
    if (ended === 'failed') return setExtensionStuck(browser.id);
    if (ended === 'unknown') {
      // Ended since the list was read, or a worker with no such route: only the list says which.
      const connected = await extensionBrowsers();
      // A list that could not be read says nothing of this browser: the line of a failed read says so.
      if (!connected.ok) return setExtensionsFailed(true);
      // A list read now says what the line of a read that failed before did not.
      setExtensionsFailed(false);
      if (connected.data.some((each) => each.id === browser.id)) return setExtensionStuck(browser.id);
      return setExtensions(connected.data);
    }
    setExtensions((current) => current.filter((each) => each.id !== browser.id));
  }
  useEffect(() => void read(), [read]);
  // The browser whose session did not end, by the id of its session.
  const [stuck, setStuck] = useState<string | undefined>();

  async function disconnect(session: ConsoleSession) {
    setStuck(undefined);
    const ended = await endConsoleSession(session.id);
    if (ended === 'unknown') {
      // Ended since the list was read, or a worker with no such route: only the list says which.
      const listed = await consoleSessions();
      if (!listed.ok || listed.data.some((each) => each.id === session.id)) return setStuck(session.id);
      return setSessions(listed.data);
    }
    if (ended === 'failed') return setStuck(session.id);
    // A list that was not read stays what it is (`edited`).
    setSessions((current) => edited(current, (items) => items.filter((each) => each.id !== session.id)));
  }

  // The addresses of the account (FRU-450). No list is not an empty list.
  const [emails, setEmails] = useState<AccountEmails | 'loading' | 'failed'>('loading');
  const readEmails = useCallback(async () => {
    const listed = await accountEmails();
    setEmails(listed.ok ? listed.data : 'failed');
    if (listed.ok) {
      const first = listed.data.emails.find((each) => each.primary);
      if (first !== undefined) setPrimary(first.email);
    }
  }, []);
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
    const chosen = await makePrimaryEmail(email, workspace.id);
    if (!chosen.ok)
      return setAddressStuck({ email, problem: problemOf(chosen, ADDRESS_PROBLEMS, ADDRESS_NOT_CHANGED) });
    setPrimary(chosen.data.email);
    setMadePrimary(chosen.data.email);
    await readEmails();
  }

  async function removeEmail(email: string) {
    setAddressStuck(undefined);
    setMadePrimary(undefined);
    const removed = await removeAccountEmail(email);
    if (!removed.ok && removed.status !== 404) {
      return setAddressStuck({ email, problem: problemOf(removed, ADDRESS_PROBLEMS, ADDRESS_NOT_CHANGED) });
    }
    await readEmails();
  }

  const [stillIn, setStillIn] = useState<'here' | 'everywhere' | undefined>();

  async function leave() {
    setStillIn(undefined);
    if (await signOut()) return navigate('/setup', { replace: true });
    // The worker did not say that the session ended: it can still be good (FRU-204).
    setStillIn('here');
  }

  async function leaveEverywhere() {
    setStillIn(undefined);
    if (await signOutEverywhere()) return navigate('/setup', { replace: true });
    // As above: no browser is said to be signed out when the worker did not say so.
    setStillIn('everywhere');
  }

  // This browser first, then the others, the one used last first.
  const browsers =
    typeof sessions === 'string'
      ? []
      : [...sessions].sort(
          (one, other) => Number(other.current) - Number(one.current) || other.lastUsedAt.localeCompare(one.lastUsedAt),
        );

  return (
    <>
      <PageHead title={t('My account')} lead={t('Your name on notes, your addresses, how you sign in, and where.')} />
      {/* The mockup puts 40 px between the head and each section: the head has 28 px under it. */}
      <div className="flex flex-col gap-[40px] pt-[12px]">
        <section aria-labelledby="profile-title" className="flex flex-col gap-[14px]">
          <SectionTitle id="profile-title">{t('Profile')}</SectionTitle>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-[14px]">
            {/* Kept when the field is left, or by Enter: the mockup draws no button. */}
            <form onSubmit={(event) => void saveName(event)} onBlur={() => void saveName()} className="min-w-0">
              <Field
                label={t('Name shown on notes')}
                value={name}
                maxLength={80}
                autoComplete="name"
                hint={primary}
                onChange={(event) => setName(event.target.value)}
              />
            </form>
            <div>
              <Choice
                label={t('Language')}
                hint={t('The language of the console, and of the e-mails Fruitback sends you.')}
                value={locale()}
                options={LOCALES.map((each) => ({ value: each.tag, label: each.name }))}
                onChange={(tag) => {
                  // The screen changes at once. The account keeps the choice for the e-mails and for
                  // the next browser. When it did not hear it, say so: the choice stays in this browser
                  // and is sent again at the next visit.
                  setUnsent(false);
                  void chooseLanguage(tag, saveLanguage).then((heard) => setUnsent(!heard));
                }}
              />
            </div>
          </div>
          {nameProblem === undefined ? null : <Problem>{t(nameProblem)}</Problem>}
          {unsent ? (
            <Problem>
              {t(
                'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.',
              )}
            </Problem>
          ) : null}
        </section>

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
                {t('Fruitback did not answer. The addresses of your account could not be read.')}
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
                    under={
                      addressStuck?.email === address.email ? <Problem>{t(addressStuck.problem)}</Problem> : undefined
                    }
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
                  {t(
                    'Fruitback sent a link to {email}. Open it in this browser within a day: the address is added then.',
                    {
                      email: sentTo,
                    },
                  )}
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

        <section aria-labelledby="signin-title">
          <SectionTitle id="signin-title">{t('How you sign in')}</SectionTitle>
          <SectionHelp>{t('Any of these opens the same account, in the console and in the extension.')}</SectionHelp>
          {linked !== null && (LINKABLE as readonly string[]).includes(linked) ? (
            <p role="status" className="mb-[12px] text-small text-muted">
              {t('{provider} is linked to your account.', { provider: PROVIDER_NAMES[linked as Linkable] })}
            </p>
          ) : null}
          {linkError === null ? null : (
            <div className="mb-[12px]">
              <Problem>{linkProblem(linkError.code, linkError.provider, primary)}</Problem>
            </div>
          )}
          {cancelled === undefined ? null : (
            <p role="status" className="mb-[12px] text-small text-muted">
              {t('{provider} was not linked.', { provider: PROVIDER_NAMES[cancelled] })}
            </p>
          )}
          {question === 'reading' ? <p className="mb-[12px] text-small text-muted">{t('Checking…')}</p> : null}
          {typeof question === 'object' ? (
            <LinkQuestion
              provider={PROVIDER_NAMES[question.provider]}
              email={question.email}
              account={primary}
              answering={answering}
              onAnswer={(yes) => void answerLink(yes)}
            />
          ) : null}
          {/* The three rows are drawn before the worker answers, so nothing under them moves when it does. */}
          <ul className="border-t border-line text-body">
            <Row title={t('Email link')} detail={primary}>
              <span className="text-small leading-auto text-muted">
                {typeof providers === 'object' && !providers.email ? t('Not sent by this Fruitback') : t('Always on')}
              </span>
            </Row>
            {LINKABLE.map((provider) => {
              const known = typeof providers === 'object' ? providers[provider] : undefined;
              const named = PROVIDER_NAMES[provider];

              return (
                <Row
                  key={provider}
                  title={named}
                  detail={t(providerWord(providers, provider))}
                  under={
                    unlinkStuck?.provider === provider ? (
                      <Problem>{t(unlinkStuck.problem, { provider: named })}</Problem>
                    ) : undefined
                  }
                >
                  {known?.linked === true ? (
                    <AsksTwice
                      space="normal"
                      label={t('Unlink')}
                      confirmLabel={t('Unlink {provider}', { provider: named })}
                      keepLabel={t('Keep it')}
                      consequence={t('You no longer sign in with {provider}. Your account and its notes stay.', {
                        provider: named,
                      })}
                      onConfirm={() => void unlink(provider)}
                    />
                  ) : null}
                  {known?.linked === false ? (
                    // An outlined button of 40 px, as the mockup draws it, that leads to the worker. A
                    // form: the worker starts a link on a `POST` of the console only (FRU-415).
                    <form method="post" action={linkAddress(provider, workspace.id)}>
                      <Button tone="outline" type="submit">
                        {t('Link {provider}', { provider: named })}
                      </Button>
                    </form>
                  ) : null}
                </Row>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="where-title">
          <SectionTitle id="where-title">{t('Where you are signed in')}</SectionTitle>
          <SectionHelp>{t('Disconnect a browser you no longer use. It stops showing notes at once.')}</SectionHelp>
          {sessions === 'loading' ? (
            <div className={ONE_ROW}>
              <p className="text-small text-muted">{t('Loading…')}</p>
            </div>
          ) : null}
          {sessions === 'failed' ? (
            <div className={`${ONE_ROW} gap-[12px]`}>
              <p role="alert" className="min-w-0 flex-1 text-small text-muted">
                {t('Fruitback did not answer. The browsers where you are signed in could not be read.')}
              </p>
              <Button tone="outline" onClick={() => void read()}>
                {t('Try again')}
              </Button>
            </div>
          ) : null}
          {typeof sessions === 'string' ? null : (
            <ul className="border-t border-line text-body">
              {browsers.map((session) =>
                session.current ? (
                  <Row key={session.id} title={titleOf(session)} detail={t('Active now')}>
                    <span className="text-small leading-auto text-muted">{t('This browser')}</span>
                  </Row>
                ) : (
                  <Row
                    key={session.id}
                    title={titleOf(session)}
                    detail={t('Signed in {since} · used {last}', {
                      since: moment(session.createdAt),
                      last: moment(session.lastUsedAt),
                    })}
                    under={
                      stuck === session.id ? (
                        <Problem>
                          {t('This browser is still signed in: Fruitback did not end its session. Try again.')}
                        </Problem>
                      ) : undefined
                    }
                  >
                    <LinkButton space="normal" onClick={() => void disconnect(session)}>
                      {t('Disconnect')}
                    </LinkButton>
                  </Row>
                ),
              )}
              {[...extensions]
                .sort((one, other) => other.usedAt.localeCompare(one.usedAt))
                .map((browser) => (
                  <Row
                    key={browser.id}
                    title={t('Extension · {browser}', { browser: browser.browser })}
                    detail={t('Connected {day} · used {last}', {
                      day: dayOf(browser.connectedAt),
                      last: ago(browser.usedAt),
                    })}
                    under={
                      extensionStuck === browser.id ? (
                        <Problem>
                          {t('This extension is still connected: Fruitback did not end its session. Try again.')}
                        </Problem>
                      ) : undefined
                    }
                  >
                    <AsksTwice
                      space="normal"
                      label={t('Disconnect')}
                      confirmLabel={t('Disconnect the extension in {browser}', { browser: browser.browser })}
                      keepLabel={t('Keep it')}
                      consequence={t(
                        'It stops showing notes at once. It connects again from its popup, with your approval here.',
                      )}
                      onConfirm={() => void disconnectExtension(browser)}
                    />
                  </Row>
                ))}
              {extensionsFailed ? (
                <li className={`${ONE_ROW} gap-[12px] border-t-0`}>
                  <p role="alert" className="min-w-0 flex-1 text-small text-muted">
                    {t('Fruitback did not answer. The browsers of the extension could not be read.')}
                  </p>
                  <Button tone="outline" onClick={() => void read()}>
                    {t('Try again')}
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
        </section>

        <section aria-label={t('Sign out')} className="flex flex-wrap items-center gap-x-[20px] gap-y-[12px]">
          <Button tone="outline" size="page" inset={18} onClick={() => void leave()}>
            {t('Sign out')}
          </Button>
          <AsksTwice
            space="loose"
            label={t('Sign out everywhere')}
            confirmLabel={t('Sign out of every browser')}
            keepLabel={t('Stay signed in')}
            consequence={t(
              'Every browser where the console is signed in to your account is signed out, this one too. The extension stays connected.',
            )}
            onConfirm={() => void leaveEverywhere()}
          />
          {stillIn === undefined ? null : (
            <div className="w-full">
              <Problem>
                {stillIn === 'here'
                  ? t('You are still signed in: Fruitback did not confirm the sign-out. Try again.')
                  : t(
                      'You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.',
                    )}
              </Problem>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * « Console · Chrome on macOS », as the worker names the browser of a session (FRU-249). A worker of
 * before, or a browser it could not name, reads as this browser or another one.
 */
function titleOf(session: ConsoleSession): string {
  const named = session.browser !== undefined && session.browser !== 'A browser' ? session.browser : undefined;
  if (named !== undefined) return t('Console · {browser}', { browser: named });

  return session.current ? t('Console · this browser') : t('Console · another browser');
}

/** The title of a section: the section is named by it. */
function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-section font-bold">
      {children}
    </h2>
  );
}

/** What a section is for, under its title. */
function SectionHelp({ children }: { children: string }) {
  return <p className="mt-[4px] mb-[12px] text-small text-muted">{children}</p>;
}

/**
 * The question of a link that came back from the provider (FRU-415): it names the provider account
 * that the worker read there, and nothing is linked before « Link this account ». It is asked on the
 * way back, and not before the provider: only the provider knows which of its accounts the person
 * chooses. The worker sends an alert to the address of the account after the link.
 */
function LinkQuestion({
  provider,
  email,
  account,
  answering,
  onAnswer,
}: {
  provider: string;
  email: string;
  account: string;
  answering: boolean;
  onAnswer: (yes: boolean) => void;
}) {
  useLocale();

  return (
    <section
      aria-labelledby="link-question"
      className="mb-[12px] rounded-[12px] border border-line p-[16px] [overflow-wrap:anywhere]"
    >
      <p id="link-question" className="text-body leading-auto font-semibold">
        {t('Link the {provider} account {email} to your Fruitback account?', { provider, email })}
      </p>
      <p className="mt-[4px] text-small text-muted">
        {t('It will open this account, as your email link does. Fruitback sends a message to {account} to say so.', {
          account,
        })}
      </p>
      <div className="mt-[12px] flex flex-wrap gap-[8px]">
        <Button disabled={answering} onClick={() => onAnswer(true)}>
          {t('Link this account')}
        </Button>
        <Button tone="quiet" disabled={answering} onClick={() => onAnswer(false)}>
          {t('Cancel')}
        </Button>
      </div>
    </section>
  );
}

/**
 * The box of a list of one row, where there is no list yet: its two rules, and the height of a row.
 *
 * WARNING: the list of the browsers arrives after the screen is drawn, and « Sign out » is under it.
 * While the list is read, and when it could not be, its place is the one of the row of this browser,
 * which every list has. So the buttons do not move under a press: a press that starts before a
 * button moves and ends after is lost. `e2e/console-account.spec.ts` holds the list back to see it.
 * A second browser still adds its row under the first.
 */
const ONE_ROW = 'box-content flex min-h-[56px] flex-wrap items-center border-y border-line py-[8px]';

/**
 * A row of a list of the account: a name, a line under it, and at its end a state or one action. The
 * mockup sizes it by its content: 56 px at the least inside its padding.
 */
function Row({
  title,
  detail,
  under,
  children,
}: {
  title: string;
  detail: string;
  /** Under the row: why its action did not go through. */
  under?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="box-content flex min-h-[56px] flex-wrap items-center gap-x-[16px] gap-y-[4px] border-b border-line py-[8px]">
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="block leading-auto font-semibold">{title}</span>
        <span className="block text-hint leading-auto text-muted [overflow-wrap:anywhere]">{detail}</span>
      </span>
      {children ?? null}
      {under === undefined ? null : <div className="w-full">{under}</div>}
    </li>
  );
}
