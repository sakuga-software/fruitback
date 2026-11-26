import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_NOTES_NEED_MEMBER,
  CLOUD_READ_NEEDS_MEMBER,
  MEMBER_TURNS_ON,
  NOTES_NEED_SESSION,
  NOT_A_MEMBER,
  READ_NEEDS_SESSION,
  memberRemedy,
  probeRead,
} from './read-probe.ts';

const SITE = { endpoint: 'https://worker.test/fruitback', clientId: 'acme co' };
const PAGE = 'https://staging.acme.dev/pricing?tab=annual';

function answering(status: number) {
  const asked: string[] = [];

  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);

      return { status, ok: status >= 200 && status < 300 };
    },
  };
}

describe('probeRead (FRU-66)', () => {
  it('asks the read the widget asks, for this page and this client', async () => {
    const seams = answering(200);

    assert.equal(await probeRead(SITE, PAGE, seams), 'answers');
    assert.deepEqual(seams.asked, [
      'https://worker.test/fruitback/feedback?url=https%3A%2F%2Fstaging.acme.dev%2Fpricing%3Ftab%3Dannual&client=acme%20co',
    ]);
  });

  it('says the worker wants a session on a 401, and on nothing else', async () => {
    assert.equal(await probeRead(SITE, PAGE, answering(401)), 'wants-a-session');

    for (const status of [403, 429, 500, 502, 503]) {
      assert.equal(await probeRead(SITE, PAGE, answering(status)), 'unknown', `status ${status}`);
    }
  });

  it('says the site takes notes from its members only on a 401 that says a note would be refused (FRU-330)', async () => {
    const refusing = (body: unknown, broken = false) => ({
      fetch: async () => ({
        status: 401,
        ok: false,
        json: async () => {
          if (broken) throw new SyntaxError('Unexpected token');

          return body;
        },
      }),
    });

    assert.equal(
      await probeRead(SITE, PAGE, refusing({ error: 'identity-required', canWrite: false })),
      'members-only',
    );
    // The control: the same refusal from a site that takes a note from anybody, or from a worker of before.
    assert.equal(await probeRead(SITE, PAGE, refusing({ error: 'identity-required' })), 'wants-a-session');
    assert.equal(await probeRead(SITE, PAGE, refusing({ canWrite: 'no' })), 'wants-a-session');
    assert.equal(await probeRead(SITE, PAGE, refusing(undefined, true)), 'wants-a-session');
  });

  it('says nothing about a worker that cannot be reached', async () => {
    const unreachable = {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    };

    assert.equal(await probeRead(SITE, PAGE, unreachable), 'unknown');
  });
});

describe('a worker that is not at the address of the rule (FRU-395)', () => {
  it('says so on a 404, and asks with no client when the rule names none', async () => {
    const seams = answering(404);
    assert.equal(await probeRead({ endpoint: 'https://api.fruitback.test/pair' }, PAGE, seams), 'not-found');
    assert.deepEqual(seams.asked, [
      'https://api.fruitback.test/pair/feedback?url=https%3A%2F%2Fstaging.acme.dev%2Fpricing%3Ftab%3Dannual',
    ]);
  });
});

describe('a 404 of the read, as the worker or a proxy writes it (review of #539)', () => {
  const answering404 = (body: unknown, json = true) => ({
    fetch: async () => ({
      status: 404,
      ok: false,
      ...(json ? { json: async () => body } : { json: async () => Promise.reject(new SyntaxError('not json')) }),
    }),
  });

  it('is « not found » for a path the worker does not serve, and for a 404 that is not JSON', async () => {
    assert.equal(await probeRead(SITE, PAGE, answering404({ error: 'not-found' })), 'not-found');
    assert.equal(await probeRead(SITE, PAGE, answering404(undefined, false)), 'not-found');
  });

  it('says nothing for a 404 that names another error', async () => {
    assert.equal(await probeRead(SITE, PAGE, answering404({ error: 'unknown-client' })), 'unknown');
  });
});

describe('what the popup says of a read refused for want of a member (FRU-663)', () => {
  it('keeps the sentences of a worker run by somebody else, with the guide, and no button', () => {
    for (const signedIn of [false, true]) {
      assert.deepEqual(memberRemedy('members-only', { onCloud: false, signedIn }), {
        sentence: NOTES_NEED_SESSION,
        guide: true,
      });
      assert.deepEqual(memberRemedy('wants-a-session', { onCloud: false, signedIn }), {
        sentence: READ_NEEDS_SESSION,
        guide: true,
      });
    }
  });

  it('offers the sign-in on the Fruitback of the build, to a person who is not signed in', () => {
    assert.deepEqual(memberRemedy('members-only', { onCloud: true, signedIn: false }), {
      sentence: CLOUD_NOTES_NEED_MEMBER,
      action: 'sign-in',
    });
    assert.deepEqual(memberRemedy('wants-a-session', { onCloud: true, signedIn: false }), {
      sentence: CLOUD_READ_NEEDS_MEMBER,
      action: 'sign-in',
    });
  });

  it('offers to turn the site on with the account of a member, and says who to ask to anybody else', () => {
    for (const answer of ['members-only', 'wants-a-session'] as const) {
      assert.deepEqual(memberRemedy(answer, { onCloud: true, signedIn: true, member: true }), {
        sentence: MEMBER_TURNS_ON,
        action: 'turn-on',
      });
      assert.deepEqual(memberRemedy(answer, { onCloud: true, signedIn: true, member: false }), {
        sentence: NOT_A_MEMBER,
      });
    }
  });

  it('never tells somebody to ask an admin for « Anyone on the page » on the Cloud', () => {
    for (const [signedIn, member] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const said = memberRemedy('members-only', { onCloud: true, signedIn, member }).sentence;
      assert.doesNotMatch(said, /Anyone on the page/);
    }
  });
});
