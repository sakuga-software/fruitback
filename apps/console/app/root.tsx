import { useEffect, useState } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { type Left, call, checkTab, onLeft, onReachability, onSignedOut } from './api';
import './app.css';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { Button, Field } from './ui';

/** The name of the product, in the title of the page. A name, not a sentence: it is not translated. */
const PRODUCT = 'Fruitback';

/**
 * WARNING: no `t` here. This is rendered once in English when the console is built, and again in the
 * browser. `t` reads the language of the browser, so a sentence here would not match the page that
 * was built. `messages.test.ts` fails on a `t` in this function or in `HydrateFallback`.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{PRODUCT}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/* The address of the worker of this instance, before the bundle reads it (FRU-222): `instance.ts`. */}
        <script src="/config.js"></script>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  const tag = useLocale();
  useEffect(() => {
    document.documentElement.lang = tag;
  }, [tag]);

  const gone = useGone();

  // The screen of the person before is taken away, with everything it showed (FRU-210).
  if (gone !== undefined) return <Gone why={gone.why} drafts={gone.drafts} />;

  // No `key` on the language here. A screen mounted again loses what somebody typed and runs its
  // effects twice: each component renders again by itself, through `useLocale`.
  return (
    <>
      <Unreachable />
      <SignedOut />
      <Outlet />
    </>
  );
}

/** What somebody had typed in a field of the screen, with the name of the field. */
type Draft = { field: string; text: string };

/**
 * What is typed in the fields of the screen, read before the screen goes. Text only: a password, a
 * box that is ticked and a choice in a list are not something to copy.
 */
function draftsOnScreen(): Draft[] {
  const drafts: Draft[] = [];
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    const kind = field instanceof HTMLTextAreaElement ? 'text' : field.type;
    if (!['text', 'email', 'url', 'search', 'tel'].includes(kind) || field.value.trim() === '') continue;
    const named = field.getAttribute('aria-label') ?? field.labels?.[0]?.textContent ?? field.placeholder;
    drafts.push({ field: named.trim(), text: field.value });
  }

  return drafts;
}

/**
 * Whether this tab stopped (FRU-210), and what was typed in it at that moment. It also asks the
 * worker who is signed in each time the tab comes back: the cookie of a session is of the browser,
 * and another tab can change it.
 */
function useGone(): { why: Left; drafts: Draft[] } | undefined {
  const [gone, setGone] = useState<{ why: Left; drafts: Draft[] } | undefined>();
  useEffect(() => onLeft((why) => setGone({ why, drafts: draftsOnScreen() })), []);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible') void checkTab();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);

    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  return gone;
}

/**
 * The screen of a tab that stopped (FRU-210): nothing of the person before, but what was being
 * typed, to copy. Nothing is sent from here: the one way on loads the console again, for whoever is
 * signed in now.
 */
function Gone({ why, drafts }: { why: Left; drafts: Draft[] }) {
  useLocale();

  return (
    <main className="flex min-h-screen items-center justify-center bg-setup px-4 py-8">
      <div role="alert" className="w-full max-w-md rounded-[14px] border border-line bg-surface p-7">
        <h1 className="text-lg font-bold">
          {why === 'changed' ? t('Another account is signed in in this browser') : t('You were signed out')}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {why === 'changed'
            ? t(
                'This tab was open for another account, so it stopped: nothing was sent from it. Load it again to go on.',
              )
            : t('Your session ended while this tab was away, so it stopped: nothing was sent from it.')}
        </p>
        {drafts.length === 0 ? null : (
          <>
            <p className="mt-5 text-sm font-semibold">{t('What you were writing, to copy:')}</p>
            {drafts.map((draft, index) => (
              <div key={index} className="mt-3">
                <Field
                  label={draft.field}
                  value={draft.text}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            ))}
          </>
        )}
        <Button className="mt-5" onClick={() => window.location.assign(why === 'changed' ? '/' : '/sign-in')}>
          {why === 'changed' ? t('Load the console again') : t('Sign in')}
        </Button>
      </div>
    </main>
  );
}

/**
 * Says so when the worker does not answer. Without it a screen that waits for the worker shows
 * nothing, or the form of somebody who is signed out.
 */
function Unreachable() {
  useLocale();
  const [reachable, setReachable] = useState(true);
  useEffect(() => onReachability(setReachable), []);
  if (reachable) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-rail-active bg-ink px-4 py-2 text-sm text-white"
    >
      <span>{t('Fruitback cannot reach its server. Check your connection.')}</span>
      <Button
        tone="outline"
        className="border-white bg-transparent text-white hover:bg-white/10"
        onClick={() => window.location.reload()}
      >
        {t('Try again')}
      </Button>
    </div>
  );
}

/**
 * Says so when a call was refused because the session ended (FRU-148), above the screen, which stays
 * as it is: a field keeps what the person typed (`CLAUDE.md`: no error path clears a field). The
 * sign-in opens in another tab; « Continue » asks the worker again and goes back to work.
 */
function SignedOut() {
  useLocale();
  const [ended, setEnded] = useState(false);
  const [still, setStill] = useState(false);
  useEffect(() => onSignedOut(() => setEnded(true)), []);
  if (!ended) return null;

  async function resume() {
    const me = await call('GET', '/console/me', undefined, { quiet: true });
    // No answer is not « still signed out »: the banner of the worker that does not answer says it.
    if (!me.ok && me.status === 0) return;
    setStill(!me.ok);
    if (me.ok) setEnded(false);
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-rail-active bg-ink px-4 py-2 text-sm text-white"
    >
      <span>
        {still
          ? t('You are still signed out. Sign in in the other tab, then continue.')
          : t('Your session ended. Sign in again in another tab: what you wrote here stays.')}
      </span>
      <a
        href="/sign-in"
        target="_blank"
        rel="noopener"
        className="rounded-full border border-white px-3 py-1 font-semibold hover:bg-white/10"
      >
        {t('Sign in')}
      </a>
      <Button
        tone="outline"
        className="border-white bg-transparent text-white hover:bg-white/10"
        onClick={() => void resume()}
      >
        {t('Continue')}
      </Button>
    </div>
  );
}

/**
 * WARNING: no word here. This is rendered once, when the console is built, and again in the browser:
 * a word in the language of the person would not match the page that was built (measured: a
 * hydration error in a French browser).
 */
export function HydrateFallback() {
  return <p className="p-8" aria-busy="true" />;
}
