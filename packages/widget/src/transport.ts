/**
 * How a widget instance reaches the worker (SKG-595).
 *
 * `embed.ts` is the only file that knows the worker exists, and it builds every call. What it does
 * not decide is who carries them. The default carries them with `fetch`, from the page the widget
 * is mounted on. A host can hand over something else: the browser extension relays them through its
 * own session, so a team token never reaches the page's JavaScript.
 *
 * Plain objects rather than `Request` and `Response`. Neither survives `postMessage`, and the
 * implementation this seam exists for lives on the other side of one.
 */

export type TransportRequest = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** Absent on a read. */
  body?: string;
};

/**
 * What came back.
 *
 * `ok` and `status` are both here because the caller acts on `ok` alone — a failed read keeps the
 * pins on screen whatever the code — while an implementer needs `status` to log something a person
 * can act on. The body is text, so a transport does not have to guess whether the caller wants JSON.
 */
export type TransportResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export type FruitbackTransport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * The default, and what every mount used before this seam existed.
 *
 * It reads the body whatever the status, where the code it replaces returned before touching it.
 * That costs one `text()` on a response nobody parses, and it buys a transport with one shape of
 * answer rather than two.
 *
 * A worker nobody can reach makes this reject rather than answer. `embed.ts` treats a rejection and
 * a failed status the same way — the pins already on screen stay — so catching here would only hide
 * an outage from an implementer who wanted to log it.
 */
export const fetchTransport: FruitbackTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });

  return { ok: response.ok, status: response.status, body: await response.text() };
};
