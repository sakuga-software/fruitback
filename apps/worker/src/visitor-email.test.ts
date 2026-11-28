import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { VISITOR_LINK_TTL_MS, emailVisitorDigestOf, readVisitorLinkToken } from './visitor-addresses.ts';
import { type Handle, KEY_A, KEY_B, ORIGIN, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * « A confirmed e-mail » (FRU-705): a visitor with no account confirms an address by a link before
 * their first edit or deletion, and their notes are theirs on every browser that confirmed it.
 *
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite), as the `<script>` of a site calls it.
 * The mailer of the world keeps what it was asked to send: no message leaves.
 */

const anEmailSite = (handle?: Handle) => aVisitorSite({ email: true, ...(handle === undefined ? {} : { handle }) });

const KEY_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const authorRows = async (world: World) =>
  rowsOf(world.database, 'SELECT note_id, author_kind, author_visitor FROM note_index ORDER BY note_id');

describe('a visitor known by a confirmed address (FRU-705)', () => {
  it('gives no right to a browser that confirmed no address, and says so in the read', async () => {
    const { send, read, call, site, edit, withdraw, noteOf } = await anEmailSite();
    const issue = await send(noteOf('ve_a'), { key: KEY_A });

    const pin = (await read({ key: KEY_A })).get('ve_a');
    // Still theirs, so the widget can offer the confirmation; no edit, no deletion.
    assert.deepEqual([pin?.mine, pin?.editable, pin?.withdrawable], [true, undefined, undefined]);
    const answer = await call('GET', `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${site}`, {
      key: KEY_A,
    });
    assert.deepEqual([answer.body.confirm, answer.body.visitor], ['email', undefined]);
    assert.deepEqual((await edit(issue, 'Not yet', { key: KEY_A })).body, { error: 'email-required' });
    assert.equal((await edit(issue, 'Not yet', { key: KEY_A })).status, 403);
    assert.equal((await withdraw(issue, { key: KEY_A })).status, 403);
  });

  it('sends a link to the page, holding no address and no key, and lets the browser that asked confirm it once', async () => {
    const { world, site, askLink, lastLink, confirm, send, edit, noteOf } = await anEmailSite();
    const issue = await send(noteOf('ve_a'), { key: KEY_A });

    const asked = await askLink('Ana@Example.com', { key: KEY_A });
    assert.deepEqual([asked.status, asked.body], [202, { sent: true, minutes: 30 }]);
    const message = world.mail.sent.at(-1);
    assert.equal(message?.to, 'ana@example.com');
    assert.match(String(message?.text), /^https:\/\/acme\.dev\/pricing#fruitback-confirm=/mu);
    const token = String(lastLink());
    assert.equal(token.includes('ana@example.com'), false);
    assert.equal(token.includes(KEY_A), false);

    assert.deepEqual(await confirm(token, { key: KEY_A }), { status: 200, body: { visitor: 'email' } });
    // Once.
    assert.deepEqual((await confirm(token, { key: KEY_A })).body, { error: 'link-used' });
    // The note of this browser is the note of the address, which edits it now.
    const identity = emailVisitorDigestOf(site, 'ana@example.com');
    assert.deepEqual(
      (await authorRows(world)).map((row) => [row.author_kind, row.author_visitor]),
      [['visitor', identity]],
    );
    assert.equal((await edit(issue, 'Bigger, please.', { key: KEY_A })).status, 200);
    // Nothing keeps the address.
    const [row] = await rowsOf(world.database, 'SELECT * FROM visitor_addresses');
    assert.equal(JSON.stringify(row).includes('ana@example.com'), false);
  });

  it('gives the notes of the address to another browser that confirms the same address, and to nobody else', async () => {
    const { askLink, lastLink, confirm, send, mine, edit, noteOf } = await anEmailSite();
    const issue = await send(noteOf('ve_a'), { key: KEY_A });
    await askLink('ana@example.com', { key: KEY_A });
    await confirm(lastLink(), { key: KEY_A });

    // Another device: nothing of theirs before it confirms.
    assert.deepEqual(await mine({ key: KEY_B }), []);
    await askLink('ana@example.com', { key: KEY_B });
    assert.equal((await confirm(lastLink(), { key: KEY_B })).status, 200);
    assert.deepEqual(await mine({ key: KEY_B }), ['ve_a']);
    assert.equal((await edit(issue, 'From the phone.', { key: KEY_B })).status, 200);
    // Another address is another visitor.
    await askLink('ben@example.com', { key: KEY_C });
    await confirm(lastLink(), { key: KEY_C });
    assert.deepEqual(await mine({ key: KEY_C }), []);
    assert.equal((await edit(issue, 'Not theirs.', { key: KEY_C })).status, 403);
    // And a note the address sends from either browser is the address's.
    await send(noteOf('ve_b'), { key: KEY_B });
    assert.deepEqual(await mine({ key: KEY_A }), ['ve_a', 've_b']);
  });

  it('confirms only in the browser that asked: a link opened elsewhere opens nothing, and stays good', async () => {
    const { askLink, lastLink, confirm, send, mine, noteOf } = await anEmailSite();
    await send(noteOf('ve_a'), { key: KEY_A });
    // Somebody types the address of another person in their own browser.
    await askLink('victim@example.com', { key: KEY_B });
    const token = lastLink();

    assert.deepEqual((await confirm(token, { key: KEY_A })).body, { error: 'other-browser' });
    assert.equal((await confirm(token, {})).status, 401);
    assert.deepEqual(await mine({ key: KEY_A }), ['ve_a']);
    // The link is not spent by a refusal.
    assert.equal((await confirm(token, { key: KEY_B })).status, 200);
  });

  it('refuses a link that ran out, of another site, or edited', async () => {
    const { world, site, askLink, lastLink, confirm } = await anEmailSite();
    await askLink('ana@example.com', { key: KEY_A });
    const token = String(lastLink());
    const [expiry, visitor, identity, mac] = token.split('.') as [string, string, string, string];

    // The expiry moved: the MAC no longer holds.
    const later = `${Number(expiry) + 1}.${visitor}.${identity}.${mac}`;
    assert.deepEqual((await confirm(later, { key: KEY_A })).body, { error: 'link-expired' });
    // Another identity in the link.
    const other = `${expiry}.${visitor}.${emailVisitorDigestOf(site, 'ben@example.com')}.${mac}`;
    assert.deepEqual((await confirm(other, { key: KEY_A })).body, { error: 'link-expired' });
    assert.deepEqual((await confirm('junk', { key: KEY_A })).body, { error: 'link-expired' });
    // Out of date: 30 minutes and a second later, the same token names no link.
    const secret = world.env.FRUITBACK_AUTH_SECRET as string;
    assert.equal(readVisitorLinkToken(secret, site, token, Date.now())?.identity, identity);
    assert.equal(readVisitorLinkToken(secret, site, token, Date.now() + VISITOR_LINK_TTL_MS + 1_000), undefined);
    assert.equal(readVisitorLinkToken(secret, `${site}x`, token, Date.now()), undefined);
  });

  it('keeps the link good when the confirmation was not kept, then spends it once it is (review of #1013)', async () => {
    const { world, askLink, lastLink, confirm, send, mine, noteOf } = await anEmailSite();
    await send(noteOf('ve_a'), { key: KEY_A });
    await askLink('ana@example.com', { key: KEY_A });
    const token = lastLink();
    const addresses = world.context.visitorAddresses;
    assert.ok(addresses !== undefined);
    const kept = addresses.confirm;
    addresses.confirm = async () => {
      throw new Error('the database did not answer');
    };
    try {
      assert.deepEqual((await confirm(token, { key: KEY_A })).body, { error: 'store-unavailable' });
    } finally {
      addresses.confirm = kept;
    }

    assert.equal((await confirm(token, { key: KEY_A })).status, 200);
    assert.deepEqual((await confirm(token, { key: KEY_A })).body, { error: 'link-used' });
    assert.deepEqual(await mine({ key: KEY_A }), ['ve_a']);
  });

  it('confirms once when the link is opened twice at the same moment (review of #1013)', async () => {
    const { askLink, lastLink, confirm } = await anEmailSite();
    await askLink('ana@example.com', { key: KEY_A });
    const token = lastLink();

    const answers = await Promise.all([confirm(token, { key: KEY_A }), confirm(token, { key: KEY_A })]);
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 410]);
  });

  it('refuses an address of another shape, and a page of another origin', async () => {
    const { askLink, world } = await anEmailSite();
    const before = world.mail.sent.length;

    assert.deepEqual((await askLink('not-an-address', { key: KEY_A })).body, { error: 'invalid-email' });
    assert.deepEqual((await askLink('ana@example.com', { key: KEY_A }, 'https://evil.example/x')).body, {
      error: 'invalid-url',
    });
    assert.equal((await askLink('ana@example.com', {})).status, 401);
    assert.equal(world.mail.sent.length, before);
  });

  it('has no such route on a site that knows its visitors by their browser', async () => {
    const { askLink, read, send, noteOf } = await aVisitorSite();
    assert.equal((await askLink('ana@example.com', { key: KEY_A })).status, 404);
    await send(noteOf('ve_a'), { key: KEY_A });
    assert.equal((await read({ key: KEY_A })).get('ve_a')?.editable, true);
  });

  it('refuses « A confirmed e-mail » on a worker that sends no e-mail, and offers it on one that does', async () => {
    const { world, workspace, alice } = await aVisitorSite();
    const post = (context: Record<string, unknown>) =>
      callOn(
        world,
        'POST',
        `/console/workspaces/${workspace}/sites`,
        {
          token: alice.token,
          body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', visitorIdentity: 'email' },
        },
        context,
      );
    const without = await post({ mailer: undefined });
    assert.deepEqual([without.status, await without.json()], [400, { error: 'identity-email-unavailable' }]);
    const offered = (await (await post({})).json()) as Record<string, unknown>;
    assert.deepEqual([offered.visitorIdentity, offered.confirmedEmail], ['email', 'available']);
  });
});

/**
 * Each guard of FRU-705, taken out of a copy of its module: the case that holds it sees the change. The
 * real module is the control of each one, in the same world.
 */
describe('the guards of a confirmed address, each planted out (FRU-705)', () => {
  const PLANTS: readonly { guard: string; file: string; from: string; to: string; holds: Check }[] = [
    {
      guard: 'an address not confirmed gives no right',
      file: 'edit-routes.ts',
      from: "if (visitor.unconfirmed === true) return { ok: false, status: 403, error: 'email-required' };",
      to: '',
      holds: async ({ send, edit, noteOf }) => {
        const issue = await send(noteOf('ve_a'), { key: KEY_A });

        return (await edit(issue, 'Not yet', { key: KEY_A })).status === 403;
      },
    },
    {
      guard: 'a link confirms only the browser that asked',
      file: 'visitor-email-routes.ts',
      from: "if (link.visitor !== asked.browser) return json(403, { error: 'other-browser' }, corsHeaders);",
      to: '',
      holds: async ({ askLink, lastLink, confirm }) => {
        await askLink('victim@example.com', { key: KEY_B });

        return (await confirm(lastLink(), { key: KEY_A })).status === 403;
      },
    },
    {
      guard: 'a link serves once',
      file: 'visitor-email-routes.ts',
      from: "if ((await kv.incr(spent, VISITOR_LINK_TTL_MS)) > 1) return json(410, { error: 'link-used' }, corsHeaders);",
      to: '',
      holds: async ({ askLink, lastLink, confirm }) => {
        await askLink('ana@example.com', { key: KEY_A });
        const token = lastLink();
        await confirm(token, { key: KEY_A });

        return (await confirm(token, { key: KEY_A })).status === 410;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      const { handleRequest: real } = await import('./app.ts');
      assert.equal(await plant.holds(await anEmailSite(real)), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, { from: plant.from, to: plant.to });
      try {
        assert.equal(await plant.holds(await anEmailSite(mutant.module.handleRequest as Handle)), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});

type Check = (site: Awaited<ReturnType<typeof anEmailSite>>) => Promise<boolean>;
