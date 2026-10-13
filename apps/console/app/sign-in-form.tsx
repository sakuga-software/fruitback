import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Providers, call, offersSignIn, providerStart, requestLink, signInProviders } from './api';
import { locale, msg, t } from './i18n';
import { awaitSignIn } from './tab-signal';
import { Button, Divider, Field, LinkButton, Problem, WideButton } from './ui';
import { useLocale } from './use-locale';

/**
 * The ways to sign in, for every screen that offers them (FRU-235): the sign-in page, the setup, and
 * the screen that connects a browser. A link by e-mail, a provider, the wait for the link, and what a
 * refusal means.
 */

/** What a refused sign-in link means for the person, and what to do. */
export const SEND_PROBLEMS: Record<string, string> = {
  'invalid-email': msg('That is not an e-mail address. Check it and send again.'),
  'too-many-links': msg('Several links went to this address already. Use the last one, or wait fifteen minutes.'),
};

/** Any other refusal, and no answer. */
export const LINK_NOT_SENT = msg('The link could not be sent just now. Try again in a minute.');

/** The state of the sign-in is not in this browser: another browser, or a page left open too long. */
const SIGN_IN_RESTARTED = msg('The sign-in started in another browser, or too long ago. Start it again from here.');
/** better-auth made no account: the worker refuses an address the provider did not verify (FRU-147). */
const NO_VERIFIED_ADDRESS = msg(
  'The provider has no verified address for this account. Verify it there, or use an email link.',
);

/** What the worker says when a sign-in with a provider comes back without a session (FRU-97, FRU-135). */
const PROVIDER_PROBLEMS: Record<string, string> = {
  'google-declined': msg('Google did not sign you in: the access was declined. Try again, or use an email link.'),
  'google-unverified': msg('Google has no verified address for this account. Use an email link.'),
  'google-failed': msg('The sign-in with Google did not finish. Try again, or use an email link.'),
  'github-declined': msg('GitHub did not sign you in: the access was declined. Try again, or use an email link.'),
  'github-unverified': msg(
    'GitHub has no verified primary address for this account. Verify it on GitHub, or use an email link.',
  ),
  'github-failed': msg('The sign-in with GitHub did not finish. Try again, or use an email link.'),
  // The codes of better-auth (FRU-148), read in 1.7.7. They do not name the provider.
  access_denied: msg('The access was declined. Try again, or use an email link.'),
  state_mismatch: SIGN_IN_RESTARTED,
  state_not_found: SIGN_IN_RESTARTED,
  state_invalid: SIGN_IN_RESTARTED,
  please_restart_the_process: SIGN_IN_RESTARTED,
  unable_to_create_user: NO_VERIFIED_ADDRESS,
  account_not_linked: NO_VERIFIED_ADDRESS,
  email_not_verified: NO_VERIFIED_ADDRESS,
  email_not_found: msg('The provider gave no address for this account. Use an email link.'),
  oauth_provider_not_found: msg('This way to sign in is not set up on this Fruitback. Use an email link.'),
};

/** Any other code that a sign-in sends back: it did not finish, and there is still a way in. */
const SIGN_IN_FAILED = msg('The sign-in did not finish. Try again, or use an email link.');

/** What a code that comes back after a sign-in means, or nothing when no code came back. */
export function providerProblem(code: string | null): string | undefined {
  if (code === null || code === '') return undefined;

  return Object.hasOwn(PROVIDER_PROBLEMS, code) ? PROVIDER_PROBLEMS[code] : SIGN_IN_FAILED;
}

/**
 * The providers before the worker says which it has (FRU-135). The build argument of FRU-97 still
 * turns GitHub on at once, so its button does not wait for an answer where it was already shown.
 */
const PROVIDERS_AT_FIRST: Providers = { github: import.meta.env.VITE_FRUITBACK_GITHUB === '1', google: false };

/**
 * The ways this worker signs people in. `closed`: it answered that it has none (FRU-217), so no form
 * is shown: a link asked for there is never sent.
 */
export function useSignInWays(): { providers: Providers; closed: boolean } {
  const [providers, setProviders] = useState(PROVIDERS_AT_FIRST);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let asked = true;
    void signInProviders().then((has) => {
      // A worker that does not answer keeps what the build said: no button is taken away by an outage.
      if (asked && has !== undefined) {
        setProviders((before) => ({ github: before.github || has.github, google: has.google }));
      }
      void offersSignIn().then((offered) => {
        if (asked && offered === false) setClosed(true);
      });
    });

    return () => {
      asked = false;
    };
  }, []);

  return { providers, closed };
}

/** What a screen says in place of its form when the worker signs nobody in (FRU-217). */
export function SignInClosed() {
  useLocale();

  return (
    <Problem>
      {t(
        'Nobody can sign in to this Fruitback yet: its sign-in is not set up. The person who runs it has one setting to add.',
      )}
    </Problem>
  );
}

type EmailFormProps = {
  /** The words of the button: « Email me a link », « Send me a new link ». */
  action: string;
  /** The address typed before, when the person comes back to change it. */
  email: string;
  onEmail: (email: string) => void;
  /** The link left for this address. */
  onSent: (email: string) => void;
  /** A refusal that came from elsewhere, as the code a provider sent back, shown until a link is asked for. */
  problem?: string | undefined;
  /** Runs before the link is asked for: the setup keeps what it needs after the sign-in. */
  before?: () => void;
};

/**
 * The address and the button that sends a link to it.
 *
 * WARNING: nothing here clears the field. A link that is refused leaves the address as it was typed,
 * with the reason under it (`CLAUDE.md`: no error path clears a field).
 */
export function EmailForm({ action, email, onEmail, onSent, problem: given, before }: EmailFormProps) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(given);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // The button is never dimmed for an empty field, as on the mockup: the form says what is missing.
    if (email.trim() === '') return setProblem(SEND_PROBLEMS['invalid-email']);
    setBusy(true);
    setProblem(undefined);
    before?.();
    const sent = await requestLink(email, locale());
    setBusy(false);
    if (sent.ok) return onSent(email.trim());

    setProblem(SEND_PROBLEMS[sent.error] ?? LINK_NOT_SENT);
  }

  return (
    // `noValidate`: the browser would stop the form with its own bubble, in its own language, and the
    // sentence of the console would never show (FRU-167). The field stays required for a screen reader.
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3.5">
      <Field
        label={t('Work email')}
        type="email"
        autoComplete="email"
        placeholder="you@studio.com"
        value={email}
        onChange={(event) => onEmail(event.target.value)}
        required
      />
      <Button type="submit" wide disabled={busy}>
        {busy ? t('Sending…') : t(action)}
      </Button>
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </form>
  );
}

/**
 * The providers this worker signs people in with, under « or ». A provider the worker does not offer
 * has no button, and with none there is nothing here, not even the word.
 */
export function ProviderButtons({ providers }: { providers: Providers }) {
  useLocale();
  if (!providers.google && !providers.github) return null;

  return (
    <>
      <Divider className="my-5.5">{t('or')}</Divider>
      <div className="flex flex-col gap-2.5">
        {providers.google ? (
          <WideButton onClick={() => (window.location.href = providerStart('google'))}>
            {t('Continue with Google')}
          </WideButton>
        ) : null}
        {providers.github ? (
          <WideButton onClick={() => (window.location.href = providerStart('github'))}>
            {t('Continue with GitHub')}
          </WideButton>
        ) : null}
      </div>
    </>
  );
}

/** A sentence with one value in bold: the words around `{name}` come from the translation. */
export function withStrong(sentence: string, name: string, value: string): ReactNode {
  const [before = '', after = ''] = t(sentence).split(`{${name}}`);

  return (
    <>
      {before}
      <strong className="font-semibold">{value}</strong>
      {after}
    </>
  );
}

/** How long before a link can be asked for again (A25 of the inventory of the mockup): a minute. */
const AGAIN_SECONDS = 60;

/** « 0:41 »: what is left, in minutes and seconds. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * « Send again in 0:41 », then « Send again »: a second link to the same address, a minute after the
 * first one at the earliest. The ceiling of the worker stays (3 links per address per quarter of an
 * hour), and its sentence is shown when it refuses.
 */
export function useSendAgain(email: string): {
  label: string;
  disabled: boolean;
  problem: string | undefined;
  send: () => void;
} {
  useLocale();
  const [left, setLeft] = useState(AGAIN_SECONDS);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // The moment the last link left: the count is read from the clock, so a tab that slept is right.
  const since = useRef(Date.now());

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, AGAIN_SECONDS - Math.floor((Date.now() - since.current) / 1000)));
    const timer = setInterval(tick, 1000);

    return () => clearInterval(timer);
  }, []);

  function send() {
    setBusy(true);
    setProblem(undefined);
    void requestLink(email, locale()).then((sent) => {
      setBusy(false);
      if (!sent.ok) return setProblem(SEND_PROBLEMS[sent.error] ?? LINK_NOT_SENT);
      since.current = Date.now();
      setLeft(AGAIN_SECONDS);
    });
  }

  const waiting = left > 0 ? t('Send again in {time}', { time: clock(left) }) : t('Send again');

  return { label: busy ? t('Sending…') : waiting, disabled: busy || left > 0, problem, send };
}

/**
 * Goes on by itself when the link is opened in another tab (FRU-235): that tab says so
 * (`tab-signal.ts`), and this one asks the worker who is signed in. The same question is asked when
 * the tab comes back to the front, for a browser that told it nothing.
 *
 * `carryOn` runs once, with a session: never on the word of another tab alone.
 */
export function useCarryOn(carryOn: () => void): void {
  const latest = useRef(carryOn);
  latest.current = carryOn;

  useEffect(() => {
    let done = false;
    const signedIn = async () => {
      if (done) return false;
      const me = await call('GET', '/console/me', undefined, { quiet: true });

      return me.ok;
    };
    const once = () => {
      if (done) return;
      done = true;
      latest.current();
    };
    const stop = awaitSignIn(signedIn, once);
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      void signedIn().then((yes) => {
        if (yes) once();
      });
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);

    return () => {
      done = true;
      stop();
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
}

/** « Use another address »: back to the form, with the address still in it. */
export function AnotherAddress({ onBack }: { onBack: () => void }) {
  useLocale();

  return (
    <LinkButton space="loose" onClick={onBack}>
      {t('Use another address')}
    </LinkButton>
  );
}
