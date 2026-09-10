/**
 * Where a worker can answer, and nowhere else.
 *
 * One rule in one place, because it is asked twice and the two answers must not drift: the popup
 * refuses an endpoint before storing it, and `parseBridgeMessage` refuses one before mounting. When
 * only the second checked — which is how this shipped first — a reporter could type `javascript:…`,
 * be told the site was **On**, and watch nothing appear with no error anywhere. Raised in review.
 */
export function isWorkerEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;

  try {
    const { protocol } = new URL(value);

    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
