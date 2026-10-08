import { PAIRING_TTL_SECONDS } from './session.ts';

/**
 * The page a pairing link opens (FRU-92).
 *
 * A link is `<worker>/pair#<code>`. The code is in the fragment, and a browser sends no fragment to
 * a server: this worker does not receive the code, and no log on the way holds it. The reviewer
 * opens the link, then clicks the extension, which reads the address of the tab.
 *
 * **This module takes no request**, so it cannot read a code that somebody put in the query by
 * mistake. **The page runs no script**, so the code stays out of the page's own JavaScript.
 */

export const PAIR_PATH = '/pair';

/** The link an operator sends. `endpoint` is the public address of the worker, with no slash at the end. */
export function pairingLink(endpoint: string, code: string): string {
  return `${endpoint}${PAIR_PATH}#${code}`;
}

const MINUTES = Math.round(PAIRING_TTL_SECONDS / 60);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pair Fruitback</title>
<style>
body { margin: 0; padding: 48px 20px; background: #fffdf9; color: #1c1917; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 34rem; margin: 0 auto; }
h1 { margin: 0 0 16px; font-size: 1.5rem; line-height: 1.2; }
ol { margin: 0 0 20px; padding-left: 1.4rem; }
li { margin: 6px 0; }
p { margin: 0; color: #57534e; font-size: 0.875rem; }
@media (prefers-color-scheme: dark) { body { background: #1c1917; color: #f5f5f4; } p { color: #a8a29e; } }
</style>
</head>
<body>
<main>
<h1>Pair the Fruitback extension</h1>
<ol>
<li>Install the Fruitback extension, if this browser does not have it.</li>
<li>Click the Fruitback icon in the toolbar, on this tab.</li>
<li>Press <strong>Pair with this worker</strong>.</li>
</ol>
<p>The code is in the address of this page, after the #. This server did not receive it, and this page runs no script. A code works once, for ${MINUTES} minutes.</p>
</main>
</body>
</html>
`;

export function pairPage(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The address of this page holds a secret, so nothing keeps it and nothing is told where it came from.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
