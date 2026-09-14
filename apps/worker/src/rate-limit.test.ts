import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Kv, KvError, createMemoryKv } from './kv.ts';
import { DEFAULT_LIMIT, WINDOW_MS, checkRateLimit, resolveClientIp } from './rate-limit.ts';

/** The first millisecond of a window, so each test says exactly where in the window it is. */
const WINDOW_START = Math.ceil(1_770_000_000_000 / WINDOW_MS) * WINDOW_MS;
const IP = '203.0.113.7';

function limiter() {
  let clock = WINDOW_START;
  const kv = createMemoryKv({ now: () => clock });

  /** `count` requests at `at`, each answered allowed or refused. */
  async function send(at: number, count = 1, ip = IP): Promise<boolean[]> {
    clock = at;
    const answers: boolean[] = [];
    for (let index = 0; index < count; index += 1) answers.push(await checkRateLimit(kv, ip, { now: at }));

    return answers;
  }

  return { kv, send };
}

describe('checkRateLimit', () => {
  it('lets the limit through and refuses the next request', async () => {
    const answers = await limiter().send(WINDOW_START + 1_000, DEFAULT_LIMIT + 1);

    assert.deepEqual(answers, [...Array.from({ length: DEFAULT_LIMIT }, () => true), false]);
  });

  it('counts each address apart', async () => {
    const { send } = limiter();

    await send(WINDOW_START + 1_000, DEFAULT_LIMIT);
    assert.deepEqual(await send(WINDOW_START + 1_000, 1, '203.0.113.8'), [true]);
  });

  it('keeps counting across a window boundary', async () => {
    // A plain fixed window would start again at zero here, and allow a second full burst at once.
    const { send } = limiter();

    await send(WINDOW_START + WINDOW_MS - 1, DEFAULT_LIMIT);
    assert.deepEqual(await send(WINDOW_START + WINDOW_MS + 1), [false]);
  });

  it('serves the caller again as the previous window stops overlapping', async () => {
    const { send } = limiter();

    await send(WINDOW_START + WINDOW_MS - 1, DEFAULT_LIMIT);
    assert.deepEqual(await send(WINDOW_START + WINDOW_MS + WINDOW_MS / 2), [true]);
  });

  it('lets through at most 2 × limit − 1 requests in 60 seconds', async () => {
    // SECURITY.md quotes this number. The worst caller sends a full burst at the end of one window,
    // then one request each time the weight of that burst has decayed enough to let one more in.
    const { send } = limiter();
    const burstAt = WINDOW_START + WINDOW_MS - 1;
    const allowed: number[] = [];

    for (const answer of await send(burstAt, DEFAULT_LIMIT)) if (answer) allowed.push(burstAt);

    for (let count = 0; count < DEFAULT_LIMIT - 1; count += 1) {
      const at = WINDOW_START + WINDOW_MS + Math.ceil(((count + 1) / DEFAULT_LIMIT) * WINDOW_MS);
      if ((await send(at))[0]) allowed.push(at);
    }

    assert.equal(allowed.length, 2 * DEFAULT_LIMIT - 1);
    assert.ok(allowed.at(-1)! - allowed[0]! < WINDOW_MS, 'the requests do not fit in one minute');
    assert.deepEqual(await send(burstAt + WINDOW_MS - 1), [false], 'one more request was let through');
  });

  it('counts the requests it refused, so a caller that keeps sending stays refused', async () => {
    // `incr` runs before the decision, because it is the only atomic step. A caller that hammers
    // therefore weighs more in the next window than one that stopped at the limit.
    const { send } = limiter();
    const hammered = DEFAULT_LIMIT + 5;

    await send(WINDOW_START + WINDOW_MS - 1, hammered);
    // A tenth of the way into the next window: 25 × 0.9 is over the limit, 20 × 0.9 would not be.
    assert.deepEqual(await send(WINDOW_START + WINDOW_MS + WINDOW_MS / 10), [false]);
  });

  it('shares one ceiling between two replicas on one Kv', async () => {
    const { kv } = limiter();
    const now = WINDOW_START + 1_000;
    const replicas = [kv, { ...kv }];
    const answers: boolean[] = [];

    for (let index = 0; index <= DEFAULT_LIMIT; index += 1) {
      answers.push(await checkRateLimit(replicas[index % 2] as Kv, IP, { now }));
    }

    assert.equal(answers.filter(Boolean).length, DEFAULT_LIMIT);
  });

  it('rejects with KvError when the Kv does not answer, and decides nothing itself', async () => {
    const down = async () => {
      throw new KvError('the store is down');
    };
    const broken: Kv = { ...createMemoryKv(), get: down, incr: down };

    await assert.rejects(checkRateLimit(broken, IP), KvError);
  });
});

/**
 * The rate limit is only as good as this function. Behind Traefik, `X-Forwarded-For` is appended to
 * by each proxy, so the entries on the left came from the caller and are forgeable — reading the
 * leftmost one would let anybody mint a fresh bucket per request.
 */
describe('resolveClientIp', () => {
  const SOCKET = '10.0.0.5';

  it('takes the entry the trusted proxy appended, not the one the caller sent', () => {
    const forged = '1.2.3.4';
    const real = '203.0.113.9';

    assert.equal(resolveClientIp(`${forged}, ${real}`, SOCKET, 1), real);
  });

  it('cannot be moved by adding entries to the chain', () => {
    const real = '203.0.113.9';

    const keys = [
      resolveClientIp(real, SOCKET, 1),
      resolveClientIp(`9.9.9.9, ${real}`, SOCKET, 1),
      resolveClientIp(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${real}`, SOCKET, 1),
    ];

    assert.equal(new Set(keys).size, 1);
  });

  it('counts from the right when several proxies are trusted', () => {
    assert.equal(resolveClientIp('1.2.3.4, 203.0.113.9, 172.16.0.1', SOCKET, 2), '203.0.113.9');
  });

  it('trims whitespace around entries', () => {
    assert.equal(resolveClientIp('1.2.3.4 ,   203.0.113.9   ', SOCKET, 1), '203.0.113.9');
  });

  it('ignores the header entirely when no proxy is trusted', () => {
    assert.equal(resolveClientIp('1.2.3.4', SOCKET, 0), SOCKET);
  });

  it('falls back to the socket when the header is absent or empty', () => {
    assert.equal(resolveClientIp(null, SOCKET, 1), SOCKET);
    assert.equal(resolveClientIp('', SOCKET, 1), SOCKET);
    assert.equal(resolveClientIp('  ,  ', SOCKET, 1), SOCKET);
  });

  it('falls back to the socket when the chain is shorter than the trusted hops', () => {
    // The request did not arrive through the expected path, so no entry in it can be trusted.
    assert.equal(resolveClientIp('203.0.113.9', SOCKET, 2), SOCKET);
  });

  it('degrades to a single shared bucket rather than crashing when nothing identifies the caller', () => {
    assert.equal(resolveClientIp(null, undefined, 1), 'unknown');
  });
});
