/**
 * The JSON answer of the routes of the worker (FRU-506). Before, each module of routes had its own
 * copy of this function, twenty in all, and nine of them did not say `no-store`.
 *
 * It always says `Cache-Control: no-store`: each answer is for one caller (a session, a token, a
 * site, an operator), and a shared cache must keep none of them. The headers of the caller come
 * after, so a caller can replace it. No caller does.
 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
