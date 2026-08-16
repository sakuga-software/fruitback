import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation } from 'react-router';
import { Fruitback } from './fruitback';
import './app.css';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="bg-stone-50 text-stone-900">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return (
    <>
      <Outlet />
      {/*
        Mounted last and only in the browser. A widget that runs on a stranger's site has to arrive
        after their app does — and here that is literal: it mounts in an effect, once React has
        hydrated the markup it is about to point at.

        `?widget=off` leaves the page bare, which is what `package.spec.ts` needs: it loads the
        *published* bundle and lets it mount itself, and two widgets on one page overlap.
      */}
      {useHostedWidget() ? <Fruitback /> : null}
    </>
  );
}

/** The playground's own widget, unless a spec asked for a page with none. */
function useHostedWidget(): boolean {
  return new URLSearchParams(useLocation().search).get('widget') !== 'off';
}
