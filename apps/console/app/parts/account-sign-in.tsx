import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  LINKABLE,
  type Linkable,
  type PendingLink,
  type SignInMethods,
  cancelLink,
  confirmLink,
  isLinkable,
  linkAddress,
  pendingLink,
  signInMethods,
  unlinkProvider,
} from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { Button, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { PROVIDER_NAMES, Row, SectionHelp, SectionTitle } from './account-rows';
import { Disconnect as AsksTwice } from './connector-parts';

/** `asking`: the worker has not answered yet. `silent`: it did not say, and nothing is in flight. */
type Asked = SignInMethods | 'asking' | 'silent';

/** What the page says of one provider. WARNING: « Not set up » only when the worker said so. */
function providerWord(asked: Asked, provider: Linkable): string {
  if (asked === 'asking') return msg('Checking…');
  if (asked === 'silent') return msg('Not known: reload the page');
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
  if (!isLinkable(provider)) return t(ACCOUNT_NOT_LINKED);
  const named = PROVIDER_NAMES[provider];
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
const NOT_UNLINKED = msg('{provider} is still linked. Try again.');

/**
 * How the person signs in (FRU-249): the email link, and each provider, linked or not. A link comes
 * back from its provider into the address of this page (FRU-415, FRU-416).
 */
export function SignInSection({ workspace, primary }: { workspace: string; primary: string }) {
  useLocale();
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
    isLinkable(params.get('confirm')) ? 'reading' : undefined,
  );
  const [answering, setAnswering] = useState(false);
  const [cancelled, setCancelled] = useState<Linkable | undefined>();
  const asked = useRef(false);
  useEffect(() => {
    if (question !== 'reading' || asked.current) return;
    asked.current = true;
    const provider = params.get('confirm');
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

  return (
    <section aria-labelledby="signin-title">
      <SectionTitle id="signin-title">{t('How you sign in')}</SectionTitle>
      <SectionHelp>{t('Any of these opens the same account, in the console and in the extension.')}</SectionHelp>
      {isLinkable(linked) ? (
        <p role="status" className="mb-[12px] text-small text-muted">
          {t('{provider} is linked to your account.', { provider: PROVIDER_NAMES[linked] })}
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
                <form method="post" action={linkAddress(provider, workspace)}>
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
  );
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
