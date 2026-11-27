import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  BOT_CHECK_MARK_MS,
  SITEVERIFY_URL,
  TURNSTILE_TEST_KEYS,
  TURNSTILE_TOKEN_MAX,
  type TurnstileVerdict,
  type VerifyTurnstile,
  botCheckMark,
  createTurnstileVerifier,
  rememberPassed,
} from './bot-check.ts';
import { envWith } from './auth-worker.fixture.ts';
import { mutatedModule } from './conformance.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { type World, callOn, signInTo } from './console-world.fixture.ts';
import { type Kv, KvError, createMemoryKv } from './kv.ts';
import { rowsOf } from './postgres.fixture.ts';
import { type Handle, KEY_A, KEY_B, ORIGIN, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * « Bot check » of the card « Safeguards » (FRU-704). On a site that asks for it, on an instance that
 * has the keys of Turnstile, `POST /feedback` of a visitor with no token answers `403 bot-check` with
 * the site key; the widget draws the check and sends the note again with the token of Cloudflare,
 * which the worker checks once. A browser that passed is not asked again on the site for 30 days.
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite). **No case calls Cloudflare**: the
 * verifier is the seam `verifyTurnstile`, and it answers here.
 */

const KEYS = {
  FRUITBACK_TURNSTILE_SECRET: TURNSTILE_TEST_KEYS.secretPasses,
  FRUITBACK_TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKeyPasses,
};
const TOKEN = TURNSTILE_TEST_KEYS.dummyToken;

const notesInStore = async (world: World) =>
  Number((await rowsOf(world.database, 'SELECT count(*) AS count FROM notes'))[0]?.count);

/** A verifier that answers `verdict`, and keeps what it was asked. */
function verifierAnswering(verdict: TurnstileVerdict = 'passed') {
  const asked: Parameters<VerifyTurnstile>[0][] = [];
  const verify: VerifyTurnstile = async (each) => {
    asked.push(each);

    return verdict;
  };

  return { asked, verify };
}

/** A site that anyone writes on and that asks for the bot check, on an instance with the keys of test. */
async function aCheckingSite(options: { verdict?: TurnstileVerdict; keys?: boolean; handle?: Handle; kv?: Kv } = {}) {
  const verifier = verifierAnswering(options.verdict);
  const site = await aVisitorSite({
    ...(options.keys === false ? {} : { env: KEYS }),
    context: { verifyTurnstile: verifier.verify, ...(options.kv === undefined ? {} : { kv: options.kv }) },
    ...(options.handle === undefined ? {} : { handle: options.handle }),
  });

  return { ...site, verifier };
}

describe('« Bot check », Cloudflare Turnstile before the first note of a visitor (FRU-704)', () => {
  it('asks a visitor for the check before their first note, then sends it with the token, and asks that browser no more', async () => {
    const { world, call, noteOf, verifier } = await aCheckingSite();

    const asked = await call('POST', '/feedback', { key: KEY_A }, noteOf('bc_1'));

    assert.equal(asked.status, 403, JSON.stringify(asked.body));
    assert.deepEqual(asked.body, { error: 'bot-check', siteKey: TURNSTILE_TEST_KEYS.siteKeyPasses });
    assert.equal(await notesInStore(world), 0);
    // Nothing went to Cloudflare for a request with no token.
    assert.equal(verifier.asked.length, 0);

    const sent = await call('POST', '/feedback', { key: KEY_A, turnstile: TOKEN }, noteOf('bc_1'));

    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(await notesInStore(world), 1);
    assert.deepEqual(verifier.asked, [
      { secret: TURNSTILE_TEST_KEYS.secretPasses, token: TOKEN, remoteIp: '198.18.2.1' },
    ]);
    // The next note of that browser on the site goes with no token, and nothing goes to Cloudflare.
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('bc_2'))).status, 201);
    assert.equal(verifier.asked.length, 1);
    // Another browser is asked.
    assert.equal((await call('POST', '/feedback', { key: KEY_B }, noteOf('bc_3'))).status, 403);
  });

  it('asks a visitor with no key of their browser at each note', async () => {
    const { world, call, noteOf, verifier } = await aCheckingSite();

    assert.equal((await call('POST', '/feedback', { turnstile: TOKEN }, noteOf('bc_n1'))).status, 201);
    const again = await call('POST', '/feedback', {}, noteOf('bc_n2'));

    assert.equal(again.status, 403);
    assert.equal(again.body.error, 'bot-check');
    assert.equal(await notesInStore(world), 1);
    assert.equal(verifier.asked.length, 1);
  });

  it('refuses a token Cloudflare fails, and keeps nothing when Cloudflare does not answer', async () => {
    const failing = await aCheckingSite({ verdict: 'failed' });

    const refused = await failing.call(
      'POST',
      '/feedback',
      { key: KEY_A, turnstile: 'a-bad-token' },
      failing.noteOf('bc_f'),
    );

    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: 'bot-check', siteKey: TURNSTILE_TEST_KEYS.siteKeyPasses });
    assert.equal(await notesInStore(failing.world), 0);
    // A failed check leaves no mark: the browser is asked again.
    assert.equal((await failing.call('POST', '/feedback', { key: KEY_A }, failing.noteOf('bc_f'))).status, 403);

    const down = await aCheckingSite({ verdict: 'unavailable' });
    const unavailable = await down.call('POST', '/feedback', { key: KEY_A, turnstile: TOKEN }, down.noteOf('bc_u'));

    assert.equal(unavailable.status, 503);
    assert.deepEqual(unavailable.body, { error: 'bot-check-unavailable' });
    assert.equal(await notesInStore(down.world), 0);
  });

  it('never asks a member, a site that does not ask, or an instance with no key of Turnstile', async () => {
    const member = await aCheckingSite();
    assert.equal(
      (await member.call('POST', '/feedback', { token: member.bobToken }, member.noteOf('bc_m'))).status,
      201,
    );
    assert.equal(member.verifier.asked.length, 0);

    const off = await aCheckingSite();
    await rowsOf(off.world.database, `UPDATE sites SET bot_check = false WHERE id = '${off.site}'`);
    assert.equal((await off.call('POST', '/feedback', { key: KEY_A }, off.noteOf('bc_off'))).status, 201);

    const keyless = await aCheckingSite({ keys: false });
    assert.equal((await keyless.call('POST', '/feedback', { key: KEY_A }, keyless.noteOf('bc_k'))).status, 201);
    assert.equal(keyless.verifier.asked.length, 0);
  });

  it('spends no note of the hour on the try with no token, and checks a token only within the limit', async () => {
    const { world, site, call, noteOf, verifier } = await aCheckingSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);

    // Six tries with no token spend nothing: the five notes of the hour are all still there.
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf(`bc_l${index}`))).status, 403);
    }
    for (let index = 0; index < 5; index += 1) {
      const sent = await call('POST', '/feedback', { key: KEY_A, turnstile: TOKEN }, noteOf(`bc_l${index}`));
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
    }
    // Over the limit, the token does not go to Cloudflare. With no key, the address counts alone, at 3 × 5.
    const another = await aCheckingSite();
    await rowsOf(another.world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${another.site}'`);
    for (let index = 0; index < 15; index += 1) {
      const sent = await another.call('POST', '/feedback', { turnstile: TOKEN }, another.noteOf(`bc_o${index}`));
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
    }
    const over = await another.call('POST', '/feedback', { turnstile: TOKEN }, another.noteOf('bc_over'));
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.equal(another.verifier.asked.length, 15);
    assert.equal(verifier.asked.length, 1);
  });

  it('asks before a note is held for a member, and holds it once the check passed', async () => {
    const { world, site, call, noteOf } = await aCheckingSite();
    await rowsOf(world.database, `UPDATE sites SET hold_visitor_notes = true WHERE id = '${site}'`);
    const held = async () =>
      Number((await rowsOf(world.database, 'SELECT count(*) AS count FROM held_notes'))[0]?.count);

    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('bc_h'))).status, 403);
    assert.equal(await held(), 0);
    assert.equal((await call('POST', '/feedback', { key: KEY_A, turnstile: TOKEN }, noteOf('bc_h'))).status, 202);
    assert.equal(await held(), 1);
  });

  it('asks a batch of a visitor too, and gives back its notes when the check fails', async () => {
    const failing = await aCheckingSite({ verdict: 'failed' });
    const batch = [failing.noteOf('bc_b1'), failing.noteOf('bc_b2')];

    assert.equal((await failing.call('POST', '/feedback', { key: KEY_A }, batch)).status, 403);
    assert.equal((await failing.call('POST', '/feedback', { key: KEY_A, turnstile: 'bad' }, batch)).status, 403);
    assert.equal(await notesInStore(failing.world), 0);

    const passing = await aCheckingSite();
    const again = [passing.noteOf('bc_b1'), passing.noteOf('bc_b2')];
    const sent = await passing.call('POST', '/feedback', { key: KEY_A, turnstile: TOKEN }, again);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(await notesInStore(passing.world), 2);
  });

  it('fails without the check of the route (planted violation)', async () => {
    const mutant = await mutatedModule('feedback-routes.ts', {
      from: 'const asked = identity.visitor ? await botCheckAsk(request, config, kv, route.client, clientId, checks) : undefined;',
      to: 'const asked = undefined as Awaited<ReturnType<typeof botCheckAsk>>;',
    });
    const { world, call, noteOf } = await aCheckingSite({ handle: mutant.module.handleRequest as Handle });

    const sent = await call('POST', '/feedback', { key: KEY_A }, noteOf('bc_p'));
    mutant.remove();

    assert.equal(sent.status, 201);
    assert.equal(await notesInStore(world), 1);
  });
});

describe('the mark of a browser that passed (FRU-704)', () => {
  it('keeps the mark 30 days under the site and the digest, and keeps none when the Kv does not answer', async () => {
    const kept: [string, string, number][] = [];
    const kv: Kv = {
      ...createMemoryKv(),
      set: async (key, value, ttl) => {
        kept.push([key, value, ttl]);
      },
    };
    await rememberPassed(kv, 'site_1', 'digest_1');
    await rememberPassed(kv, 'site_1', undefined);

    assert.deepEqual(kept, [[botCheckMark('site_1', 'digest_1'), '1', BOT_CHECK_MARK_MS]]);
    assert.equal(BOT_CHECK_MARK_MS, 30 * 86_400_000);
    assert.notEqual(botCheckMark('site_1', 'digest_1'), botCheckMark('site_2', 'digest_1'));

    const down: Kv = {
      ...createMemoryKv(),
      set: async () => {
        throw new KvError('down');
      },
    };
    await rememberPassed(down, 'site_1', 'digest_1');
  });
});

describe('the verifier of production, against a Cloudflare of this test (FRU-704)', () => {
  /** A `fetch` that answers `answer`, and keeps what it was asked. */
  function http(answer: () => Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });

      return answer();
    }) as typeof fetch;

    return { calls, fake };
  }

  it('posts the secret, the token and the address to siteverify, and reads success', async () => {
    const passing = http(async () => Response.json({ success: true }));

    const verdict = await createTurnstileVerifier(passing.fake)({
      secret: TURNSTILE_TEST_KEYS.secretPasses,
      token: TOKEN,
      remoteIp: '198.18.2.1',
    });

    assert.equal(verdict, 'passed');
    assert.equal(passing.calls.length, 1);
    assert.equal(passing.calls[0]?.url, SITEVERIFY_URL);
    assert.equal(passing.calls[0]?.init?.method, 'POST');
    const form = passing.calls[0]?.init?.body as URLSearchParams;
    assert.deepEqual(Object.fromEntries(form), {
      secret: TURNSTILE_TEST_KEYS.secretPasses,
      response: TOKEN,
      remoteip: '198.18.2.1',
    });
    // An address the worker could not read is not sent.
    const unknown = http(async () => Response.json({ success: true }));
    await createTurnstileVerifier(unknown.fake)({ secret: 's', token: 't', remoteIp: 'unknown' });
    const sent = unknown.calls[0]?.init?.body as URLSearchParams | undefined;
    assert.equal(sent?.has('remoteip'), false);
  });

  it('fails a token Cloudflare refuses, and is unavailable for a status, a body or a silence it cannot read', async () => {
    const asked = { secret: 's', token: 't', remoteIp: '198.18.2.1' };
    const verdictOf = (answer: () => Promise<Response>, timeout?: number) =>
      createTurnstileVerifier(http(answer).fake, timeout)(asked);

    assert.equal(
      await verdictOf(async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })),
      'failed',
    );
    assert.equal(await verdictOf(async () => new Response('down', { status: 500 })), 'unavailable');
    assert.equal(await verdictOf(async () => new Response('not json', { status: 200 })), 'unavailable');
    assert.equal(
      await verdictOf(async () => {
        throw new TypeError('fetch failed');
      }),
      'unavailable',
    );
    // A Cloudflare that never answers: the signal of the timeout ends the wait.
    const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    assert.equal(await createTurnstileVerifier(silent, 20)(asked), 'unavailable');
  });

  it('sends no token Cloudflare would never have made', async () => {
    const { call, noteOf, verifier } = await aCheckingSite();

    const long = await call(
      'POST',
      '/feedback',
      { key: KEY_A, turnstile: 'x'.repeat(TURNSTILE_TOKEN_MAX + 1) },
      noteOf('bc_t'),
    );

    assert.equal(long.status, 403);
    assert.equal(verifier.asked.length, 0);
  });
});

describe('« Bot check », set in the console (FRU-704)', () => {
  it('is on for a new site, changes for an owner, is kept when not named, refuses another value, and says whether the instance has a key', async () => {
    for (const keys of [true, false]) {
      const { world, workspace, site } = await aCheckingSite({ keys });
      const alice = await signInTo(world, 'alice@acme.dev');
      const post = (body: Record<string, unknown>) =>
        callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
          token: alice.token,
          body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', ...body },
        });
      const stored = async () =>
        (await rowsOf(world.database, `SELECT bot_check FROM sites WHERE id = '${site}'`))[0]?.bot_check;

      const fresh = (await (await post({ url: 'https://new.acme.dev' })).json()) as Record<string, unknown>;
      assert.equal(fresh.botCheck, true);
      assert.equal(fresh.botCheckReady, keys);
      assert.equal((await post({ botCheck: false })).status, 201);
      assert.equal(await stored(), false);
      assert.equal((await post({})).status, 201);
      assert.equal(await stored(), false);
      assert.equal((await post({ botCheck: true })).status, 201);
      assert.equal(await stored(), true);
      for (const value of ['yes', 1, null]) {
        const refused = await post({ botCheck: value });
        assert.equal(refused.status, 400, String(value));
        assert.deepEqual(await refused.json(), { error: 'invalid-bot-check' });
      }
      const listed = (await (
        await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, { token: alice.token })
      ).json()) as { sites: Record<string, unknown>[] };
      assert.deepEqual(
        listed.sites.filter((each) => each.id === site).map((each) => [each.botCheck, each.botCheckReady]),
        [[true, keys]],
      );
    }
  });
});

describe('the keys of Turnstile in the environment (FRU-704)', () => {
  const refusal = (env: WorkerEnv) => {
    const config = readConfig(env);

    return config.ok ? undefined : config.missing.join(' | ');
  };

  it('takes the two keys or neither, refuses a secret with white space around it, and quotes no secret', () => {
    const both = /FRUITBACK_TURNSTILE_SECRET and FRUITBACK_TURNSTILE_SITE_KEY \(both, /;

    assert.match(refusal(envWith({ FRUITBACK_TURNSTILE_SECRET: KEYS.FRUITBACK_TURNSTILE_SECRET })) ?? '', both);
    assert.match(refusal(envWith({ FRUITBACK_TURNSTILE_SITE_KEY: KEYS.FRUITBACK_TURNSTILE_SITE_KEY })) ?? '', both);
    const edged = refusal(envWith({ ...KEYS, FRUITBACK_TURNSTILE_SECRET: ` ${KEYS.FRUITBACK_TURNSTILE_SECRET}` }));
    assert.match(edged ?? '', /^FRUITBACK_TURNSTILE_SECRET \(no white space/);
    assert.equal((edged ?? '').includes(KEYS.FRUITBACK_TURNSTILE_SECRET), false);

    // The controls: both start with the keys, and neither starts with none.
    const keyed = readConfig(envWith(KEYS));
    assert.ok(keyed.ok);
    assert.deepEqual(keyed.config.turnstile, {
      secret: TURNSTILE_TEST_KEYS.secretPasses,
      siteKey: TURNSTILE_TEST_KEYS.siteKeyPasses,
    });
    const none = readConfig(envWith());
    assert.ok(none.ok);
    assert.equal(none.config.turnstile, undefined);
  });
});
