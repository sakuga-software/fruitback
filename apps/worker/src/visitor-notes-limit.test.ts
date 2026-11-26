import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { VISITORS_PER_ADDRESS } from './rate-limit.ts';
import { type Handle, KEY_A, KEY_B, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * The notes a visitor with no account leaves on a site in an hour (FRU-704): the line « Notes per
 * visitor » of the card « Safeguards », 10 by default. `POST /feedback` counts them by the key of the
 * browser and by the address, on the site, before anything is written; over it, `429 visitor-limit`,
 * and the widget asks to wait. Each case goes through `handleRequest`, on PostgreSQL (PGlite).
 */

/** A key as the widget makes it, the n-th of a list: 43 characters of base64url. */
const keyOf = (index: number): string => `K${String(index).padStart(42, '0')}`;

const notesInStore = async (world: Awaited<ReturnType<typeof aVisitorSite>>['world']) =>
  Number((await rowsOf(world.database, 'SELECT count(*) AS count FROM notes'))[0]?.count);

describe('the notes of a visitor in an hour (FRU-704)', () => {
  it('takes 10 notes of one browser on a new site, refuses the 11th with nothing written, and takes another browser', async () => {
    const { world, call, noteOf } = await aVisitorSite();
    for (let index = 0; index < 10; index += 1) {
      const sent = await call('POST', '/feedback', { key: KEY_A }, noteOf(`vl_${index}`));
      assert.equal(sent.status, 201, `note ${index}: ${JSON.stringify(sent.body)}`);
    }

    const refused = await call('POST', '/feedback', { key: KEY_A }, noteOf('vl_10'));

    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'visitor-limit', perHour: 10 });
    assert.equal(await notesInStore(world), 10);
    // Another browser on the same address has its own count.
    assert.equal((await call('POST', '/feedback', { key: KEY_B }, noteOf('vl_b'))).status, 201);
  });

  it('never counts a member of the workspace, after a visitor spent the hour', async () => {
    const { call, noteOf, bobToken, world, site } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    for (let index = 0; index < 5; index += 1) await call('POST', '/feedback', { key: KEY_A }, noteOf(`vm_${index}`));
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('vm_refused'))).status, 429);

    for (let index = 0; index < 7; index += 1) {
      const sent = await call('POST', '/feedback', { token: bobToken }, noteOf(`vm_bob_${index}`));
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
    }
  });

  it('lets no token that does not verify pass the count: it is refused, and writes nothing (review of #984)', async () => {
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    for (let index = 0; index < 5; index += 1) await call('POST', '/feedback', { key: KEY_A }, noteOf(`vt_${index}`));
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('vt_refused'))).status, 429);

    for (const token of ['junk', 'not.a.session', 'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl']) {
      const forged = await call('POST', '/feedback', { key: KEY_A, token }, noteOf(`vt_${token}`));
      assert.equal(forged.status, 401, `${token}: ${JSON.stringify(forged.body)}`);
      const batch = await call('POST', '/feedback', { key: KEY_A, token }, [
        noteOf(`vtb_${token}_1`),
        noteOf(`vtb_${token}_2`),
      ]);
      assert.equal(batch.status, 401, `${token}: ${JSON.stringify(batch.body)}`);
    }
    assert.equal(await notesInStore(world), 5);
  });

  it('counts every note of a batch, and refuses one that would pass the limit with none written', async () => {
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    const batch = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => noteOf(`${prefix}_${index}`));

    assert.equal((await call('POST', '/feedback', { key: KEY_A }, batch('vb_first', 3))).status, 201);
    const refused = await call('POST', '/feedback', { key: KEY_A }, batch('vb_second', 3));

    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'visitor-limit', perHour: 5 });
    assert.equal(await notesInStore(world), 3);
  });

  it('counts only the notes of a batch sent again that no earlier attempt kept (review of #984)', async () => {
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    const batch = [noteOf('vr_1'), noteOf('vr_2'), noteOf('vr_3')];
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, batch)).status, 201);

    // The same three, and two new ones: 3 + 2 is the limit, where 3 + 5 would pass it.
    const again = await call('POST', '/feedback', { key: KEY_A }, [...batch, noteOf('vr_4'), noteOf('vr_5')]);

    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(await notesInStore(world), 5);
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('vr_6'))).status, 429);
  });

  it('gives back the notes of a refused batch, so a later attempt plants them (review of #984)', async () => {
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    assert.equal(
      (await call('POST', '/feedback', { key: KEY_A }, [noteOf('vg_1'), noteOf('vg_2'), noteOf('vg_3')])).status,
      201,
    );
    const batch = [noteOf('vg_4'), noteOf('vg_5'), noteOf('vg_6')];
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, batch)).status, 429);

    // « No limit » now: the same batch goes at once, with no note held by the refused request.
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 0 WHERE id = '${site}'`);
    const again = await call('POST', '/feedback', { key: KEY_A }, batch);

    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(await notesInStore(world), 6);
  });

  it('counts 3 browsers on one address, so a visitor who clears their key meets it', async () => {
    assert.equal(VISITORS_PER_ADDRESS, 3);
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 5 WHERE id = '${site}'`);
    for (let key = 0; key < VISITORS_PER_ADDRESS; key += 1) {
      for (let index = 0; index < 5; index += 1) {
        const sent = await call('POST', '/feedback', { key: keyOf(key) }, noteOf(`va_${key}_${index}`));
        assert.equal(sent.status, 201, JSON.stringify(sent.body));
      }
    }

    assert.equal((await call('POST', '/feedback', { key: keyOf(99) }, noteOf('va_new_key'))).status, 429);
    // With no key, the address alone counts, and it is spent.
    assert.equal((await call('POST', '/feedback', {}, noteOf('va_no_key'))).status, 429);
  });

  it('counts nothing where the tab « Access » says « No limit »', async () => {
    const { world, site, call, noteOf } = await aVisitorSite();
    await rowsOf(world.database, `UPDATE sites SET visitor_notes_per_hour = 0 WHERE id = '${site}'`);

    // 15: more than the 10 of the hour, and under the 20 requests of a minute of the address.
    for (let index = 0; index < 15; index += 1) {
      const sent = await call('POST', '/feedback', { key: KEY_A }, noteOf(`vn_${index}`));
      assert.equal(sent.status, 201, `note ${index}: ${JSON.stringify(sent.body)}`);
    }
  });

  it('fails when the worker names no caller a visitor (planted violation)', async () => {
    const mutant = await mutatedModule('app.ts', {
      from: "channel: 'script', account: false, visitor: true };",
      to: "channel: 'script', account: false, visitor: false };",
    });
    const handle = mutant.module.handleRequest as Handle;
    const { call, noteOf } = await aVisitorSite({ handle });

    const answers: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      answers.push((await call('POST', '/feedback', { key: KEY_A }, noteOf(`vv_${index}`))).status);
    }
    mutant.remove();
    assert.equal(answers.at(-1), 201);
  });

  it('fails without the count of the route (planted violation)', async () => {
    const mutant = await mutatedModule('feedback-routes.ts', {
      from: '  if (perHour === undefined || clientId === undefined) return undefined;',
      to: '  return undefined;',
    });
    const handle = mutant.module.handleRequest as Handle;
    const { call, noteOf } = await aVisitorSite({ handle });

    const answers: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      answers.push((await call('POST', '/feedback', { key: KEY_A }, noteOf(`vp_${index}`))).status);
    }
    mutant.remove();
    // The guard taken out, the 11th note is taken: the cases above see the guard, and nothing else.
    assert.equal(answers.at(-1), 201);
  });
});
