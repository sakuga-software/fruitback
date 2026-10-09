import { useEffect, useState } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { onReachability } from './api';
import './app.css';
import { t } from './i18n';
import { useLocale } from './use-locale';

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

  // No `key` on the language here. A screen mounted again loses what somebody typed and runs its
  // effects twice: each component renders again by itself, through `useLocale`.
  return (
    <>
      <Unreachable />
      <Outlet />
    </>
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
    <div role="alert" className="flex flex-wrap items-center justify-center gap-3 bg-ink px-4 py-2 text-sm text-white">
      <span>{t('Fruitback cannot reach its server. Check your connection.')}</span>
      <button
        type="button"
        className="rounded-full border border-white px-3 py-1 font-semibold"
        onClick={() => window.location.reload()}
      >
        {t('Try again')}
      </button>
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
