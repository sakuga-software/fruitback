import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn, memberOf, signInTo } from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { rowsOf } from './postgres.fixture.ts';
import { seal } from './secrets.ts';
import { signedVisitorDigestOf } from './visitor-key.ts';
import { type Handle, KEY_A, KEY_B, ORIGIN, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * A visitor the site signs (FRU-706): the backend of the site signs who its logged-in user is with the
 * key of the site, the widget sends the token, and the worker checks it. Their notes are theirs on every
 * device. A token that does not verify falls back on the key of the browser, with nothing more.
 *
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite), as the `<script>` of a site calls it.
 * The key of the site is made through the console, as an owner makes it.
 */

const aSignedSite = (handle?: Handle) => aVisitorSite({ signed: true, ...(handle === undefined ? {} : { handle }) });

const authorRows = async (world: World) =>
  rowsOf(world.database, 'SELECT note_id, author_kind, author_visitor FROM note_index ORDER BY note_id');

/** A minute ago, in seconds: a token that expired, past the minute of slack of `CLOCK_SKEW_SECONDS`. */
const expired = () => Math.floor(Date.now() / 1000) - 120;

describe('a visitor the site signs (FRU-706)', () => {
  it('gives the notes of a signed person to them on every device, and to nobody else', async () => {
    const { world, site, send, mine, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana', { name: 'Ana' });
    await send(noteOf('sv_ana'), { token: ana, key: KEY_A });

    // Another device: another key of the browser, the same person.
    assert.deepEqual(await mine({ token: ana, key: KEY_B }), ['sv_ana']);
    assert.deepEqual(await mine({ token: ana }), ['sv_ana']);
    // Another person of the site, and the browser alone, own nothing.
    assert.deepEqual(await mine({ token: await signedAs('user-ben'), key: KEY_A }), []);
    assert.deepEqual(await mine({ key: KEY_A }), []);
    // The index keeps the digest of the person, never their id.
    const [row] = await authorRows(world);
    assert.deepEqual([row?.author_kind, row?.author_visitor], ['site', signedVisitorDigestOf(site, 'user-ana')]);
    assert.equal(String(row?.author_visitor).includes('user-ana'), false);
  });

  it('names the person as the site signed them, and says so in the read', async () => {
    const { read, call, site, send, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana', { name: 'Ana' });
    // A name typed in the note does not survive a token that names someone.
    await send(noteOf('sv_ana', 'The button is too small.', 'Somebody else'), { token: ana, key: KEY_A });

    const pin = (await read({ token: ana, key: KEY_B })).get('sv_ana');
    assert.deepEqual(pin?.note.reporter, { id: 'user-ana', name: 'Ana', verified: true });
    const answer = await call('GET', `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${site}`, {
      token: ana,
    });
    assert.deepEqual([answer.body.identified, answer.body.visitor], [true, 'signed']);
    // The key of a browser alone is a visitor of before: neither.
    const browser = await call(
      'GET',
      `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${site}`,
      {
        key: KEY_A,
      },
    );
    assert.deepEqual([browser.body.identified, browser.body.visitor], [undefined, undefined]);
  });

  it('lets the signed person edit and delete their open note from another device, and nobody else', async () => {
    const { send, edit, withdraw, read, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana');
    const issue = await send(noteOf('sv_ana'), { token: ana, key: KEY_A });

    const pin = (await read({ token: ana, key: KEY_B })).get('sv_ana');
    assert.deepEqual([pin?.editable, pin?.withdrawable], [true, true]);
    assert.equal((await edit(issue, 'Not theirs.', { token: await signedAs('user-ben'), key: KEY_B })).status, 403);
    assert.equal((await edit(issue, 'Not theirs.', { key: KEY_A })).status, 403);
    assert.equal((await edit(issue, 'Bigger, please.', { token: ana, key: KEY_B })).status, 200);
    assert.equal((await withdraw(issue, { key: KEY_A })).status, 403);
    assert.equal((await withdraw(issue, { token: ana })).status, 200);
  });

  it('falls back on the key of the browser for a token that expired, with no right more', async () => {
    const { world, send, mine, edit, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana');
    const old = await signedAs('user-ana', { exp: expired(), name: 'Ana' });
    const issue = await send(noteOf('sv_ana'), { token: ana, key: KEY_A });

    // A note sent with the token that expired is the note of this browser, a claim.
    await send(noteOf('sv_old', 'Sent late.', 'Typed'), { token: old, key: KEY_B });
    const rows = await authorRows(world);
    assert.deepEqual(
      rows.map((row) => row.author_kind),
      ['site', 'visitor'],
    );
    assert.deepEqual(await mine({ token: old, key: KEY_B }), ['sv_old']);
    // Not the notes of the person: the token that expired names nobody.
    assert.deepEqual(await mine({ token: old }), []);
    assert.equal((await edit(issue, 'Not with this one.', { token: old })).status, 401);
    assert.equal((await edit(issue, 'Not with this one.', { token: old, key: KEY_B })).status, 403);
    // And the person, signed again, does not get the note of the browser.
    assert.deepEqual(await mine({ token: ana }), ['sv_ana']);
  });

  it('falls back on the key of the browser for a token signed with another key', async () => {
    const { send, mine, read, noteOf, signedAs } = await aSignedSite();
    const forged = await signedAs('user-ana', { key: 'a-key-that-is-not-the-key-of-the-site-0123' });
    await send(noteOf('sv_forged', 'Forged.', 'Ana'), { token: forged, key: KEY_A });

    assert.deepEqual(await mine({ token: forged, key: KEY_A }), ['sv_forged']);
    assert.deepEqual(await mine({ token: await signedAs('user-ana') }), []);
    // The name is the one typed, a claim: the forged token put no `verified` on it.
    assert.deepEqual((await read({ key: KEY_A })).get('sv_forged')?.note.reporter, { name: 'Ana' });
  });

  it('counts the notes of a signed person by the hour on every device, as a visitor', async () => {
    const { send, call, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana');
    // 10 an hour, the default of a site: each from another browser, the same person.
    for (let index = 0; index < 10; index += 1) {
      const key = String.fromCharCode(65 + index).repeat(43);
      await send(noteOf(`sv_${index}`), { token: ana, key });
    }
    const refused = await call('POST', '/feedback', { token: ana, key: 'Z'.repeat(43) }, noteOf('sv_10'));
    assert.deepEqual([refused.status, refused.body.error], [429, 'visitor-limit']);
    // Another person of the site still writes.
    assert.equal(
      (await call('POST', '/feedback', { token: await signedAs('user-ben'), key: 'Y'.repeat(43) }, noteOf('sv_ben')))
        .status,
      201,
    );
  });

  it('still tells a session of the worker that expired that it ended: it is never read as a visitor', async () => {
    const { world, workspace, call, noteOf } = await aSignedSite();
    const ended = await signIdentityToken(
      { sub: 'acct_gone', ws: workspace, exp: expired() },
      world.env.FRUITBACK_IDENTITY_SECRET as string,
    );
    const answer = await call('POST', '/feedback', { token: ended, key: KEY_A }, noteOf('sv_ended'));
    assert.deepEqual([answer.status, answer.body.error], [401, 'invalid-identity']);
  });

  it('falls back on the key of the browser once the site stops signing, and recognises nobody by a token', async () => {
    const { world, workspace, alice, send, mine, noteOf, signedAs } = await aSignedSite();
    const ana = await signedAs('user-ana');
    await send(noteOf('sv_ana'), { token: ana, key: KEY_A });
    const set = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', visitorIdentity: 'browser' },
    });
    assert.equal(set.status, 201);

    // The page still sends the token: the note is taken, as the note of this browser.
    await send(noteOf('sv_after'), { token: ana, key: KEY_B });
    assert.deepEqual(await mine({ token: ana }), []);
    assert.deepEqual(await mine({ token: ana, key: KEY_B }), ['sv_after']);
  });

  it('recognises a person with a new key of the site, and a token of the key before as nobody', async () => {
    const { world, workspace, site, alice, send, mine, noteOf, signedAs } = await aSignedSite();
    const before = await signedAs('user-ana');
    await send(noteOf('sv_ana'), { token: before, key: KEY_A });
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites/${site}/identity-key`, {
      token: alice.token,
    });
    const { key } = (await made.json()) as { key: string };

    // The notes are the person's, whatever key signs them: the digest is of the person.
    assert.deepEqual(await mine({ token: await signedAs('user-ana', { key }) }), ['sv_ana']);
    assert.deepEqual(await mine({ token: before }), []);
  });

  it('knows a visitor by their browser on a worker that cannot open the key of the site', async () => {
    const { world, site, send, mine, noteOf, signedAs } = await aSignedSite();
    // The key sealed with another key of the worker: a database restored on another instance.
    await rowsOf(world.database, `UPDATE sites SET identity_key = '${seal('k'.repeat(43), 'x'.repeat(40))}'`);
    const ana = await signedAs('user-ana', { key: 'k'.repeat(43) });
    await send(noteOf('sv_ana'), { token: ana, key: KEY_A });

    assert.deepEqual(await mine({ token: ana }), []);
    assert.deepEqual(await mine({ token: ana, key: KEY_A }), ['sv_ana']);
    assert.ok(site);
  });
});

describe('the key of a site in the console (FRU-706)', () => {
  it('shows the key once, to a role that manages the sites, and says only that there is one after', async () => {
    const { world, workspace, site, alice, siteKey } = await aSignedSite();
    assert.match(String(siteKey), /^[A-Za-z0-9_-]{43}$/u);
    const sites = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites`, { token: alice.token });
    const listed = ((await sites.json()) as { sites: Record<string, unknown>[] }).sites.find(
      (each) => each.id === site,
    );
    assert.deepEqual([listed?.visitorIdentity, listed?.identityKey], ['signed', 'set']);
    assert.equal(JSON.stringify(listed).includes(String(siteKey)), false);
    // Sealed in the database, never in clear.
    const [row] = await rowsOf(world.database, 'SELECT identity_key FROM sites');
    assert.equal(String(row?.identity_key).includes(String(siteKey)), false);
    assert.match(String(row?.identity_key), /^v1\./u);

    const carol = await signInTo(world, 'carol@acme.dev');
    await memberOf(world, workspace, carol.id, 'member');
    const refused = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites/${site}/identity-key`, {
      token: carol.token,
    });
    assert.equal(refused.status, 403);
    const elsewhere = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites/site_nope/identity-key`, {
      token: alice.token,
    });
    assert.equal(elsewhere.status, 404);
  });

  it('refuses « Signed by your site » for a site with no key, and a value that is not one of the two', async () => {
    const { world, workspace, alice } = await aVisitorSite();
    const post = (visitorIdentity: unknown) =>
      callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: alice.token,
        body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', visitorIdentity },
      });
    // This world has no key to seal with: no key, and no « Signed by your site ».
    assert.deepEqual((await (await post('signed')).json()) as unknown, { error: 'identity-keys-unavailable' });
    assert.deepEqual((await (await post('email')).json()) as unknown, { error: 'invalid-visitor-identity' });
    const listed = (await (await post('browser')).json()) as Record<string, unknown>;
    assert.deepEqual([listed.visitorIdentity, listed.identityKey], ['browser', 'unavailable']);
  });

  it('refuses « Signed by your site » before the key is made, on a worker that keeps keys', async () => {
    const { world, workspace, alice } = await aSignedSite();
    const other = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url: 'https://shop.acme.dev', visibility: 'everyone', writers: 'anyone', visitorIdentity: 'signed' },
    });
    assert.deepEqual([other.status, await other.json()], [400, { error: 'identity-key-required' }]);
  });
});

/**
 * Each guard of FRU-706, taken out of a copy of its module: the case that holds it sees the change. The
 * real module is the control of each one, in the same world.
 */
describe('the guards of a visitor the site signs, each planted out (FRU-706)', () => {
  const PLANTS: readonly { guard: string; file: string; from: string; to: string; holds: Check }[] = [
    {
      guard: 'a session of the worker that ended is never a visitor',
      file: 'app.ts',
      from: 'return policy.sessions === undefined || !(await signedWith(token, policy.sessions.secret));',
      to: 'return true;',
      holds: async ({ world, workspace, call, noteOf }) => {
        const ended = await signIdentityToken(
          { sub: 'acct_gone', ws: workspace, exp: expired() },
          world.env.FRUITBACK_IDENTITY_SECRET as string,
        );

        return (await call('POST', '/feedback', { token: ended, key: KEY_A }, noteOf('sv_ended'))).status === 401;
      },
    },
    {
      guard: 'a person the site signed is not the browser whose key reads like their id',
      file: 'visitor-key.ts',
      from: '`fruitback-signed-visitor\\n${site}\\n${sub}`',
      to: '`fruitback-visitor\\n${site}\\n${sub}`',
      holds: async ({ send, mine, noteOf, signedAs }) => {
        await send(noteOf('sv_key'), { key: KEY_A });

        return (await mine({ token: await signedAs(KEY_A) })).length === 0;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      const { handleRequest: real } = await import('./app.ts');
      assert.equal(await plant.holds(await aSignedSite(real)), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, { from: plant.from, to: plant.to });
      try {
        assert.equal(await plant.holds(await aSignedSite(mutant.module.handleRequest as Handle)), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});

type Check = (site: Awaited<ReturnType<typeof aSignedSite>>) => Promise<boolean>;
