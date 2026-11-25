import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { type Handle, KEY_A, KEY_B, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * A visitor known by the key of their browser edits the text of their note while it is open
 * (FRU-701), through the route of a member's edit (FRU-475): `POST /feedback/<id>/text`. Nobody else,
 * and never once the team took the note on.
 */

const textsOf = async (world: Awaited<ReturnType<typeof aVisitorSite>>['world']) =>
  (await rowsOf(world.database, 'SELECT payload FROM notes')).map((row) => JSON.parse(String(row.payload)).text);

/** A site, and a note that the browser of key A left on it. */
async function aVisitorNote(options: Parameters<typeof aVisitorSite>[0] = {}) {
  const site = await aVisitorSite(options);
  const issue = await site.send(site.noteOf('ve_1', 'The button is too small.', 'Camille'), { key: KEY_A });

  return { ...site, issue };
}

describe('a visitor edits the text of their open note (FRU-701)', () => {
  it('replaces the text with the key of their browser, says who in a reply, and the read and the index follow', async () => {
    const { world, site, edit, read, issue } = await aVisitorNote();
    assert.equal((await read({ key: KEY_A })).get('ve_1')?.editable, true);

    const edited = await edit(issue, '  The button of the Latte is too small  ', { key: KEY_A });

    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.note.text, 'The button of the Latte is too small');
    // The name the note was sent with, their word: « not verified ».
    assert.match(edited.body.comment.body, /^\*\*Camille\*\* via Fruitback · not verified\nEdited the note$/u);
    assert.deepEqual(await textsOf(world), ['The button of the Latte is too small']);
    assert.equal((await read({ key: KEY_A })).get('ve_1')?.note.text, 'The button of the Latte is too small');
    const [row] = await rowsOf(world.database, `SELECT excerpt FROM note_index WHERE site_id = '${site}'`);
    assert.equal(row?.excerpt, 'The button of the Latte is too small');
  });

  it('refuses another browser, no key, a key of another shape, and a member, and writes nothing', async () => {
    const { world, edit, read, bobToken, issue } = await aVisitorNote();

    assert.deepEqual((await edit(issue, 'Not theirs', { key: KEY_B })).body, { error: 'not-allowed' });
    assert.equal((await edit(issue, 'Not theirs', { key: KEY_B })).status, 403);
    assert.equal((await edit(issue, 'Nobody', {})).status, 401);
    assert.equal((await edit(issue, 'Nobody', { key: 'not-a-key' })).status, 401);
    // A member of the team does not rewrite the words of a visitor either.
    assert.equal((await edit(issue, 'The team', { token: bobToken })).status, 403);
    // A token that is no session is never read as the browser it came with.
    assert.equal((await edit(issue, 'A token', { key: KEY_A, token: 'not.a.session' })).status, 401);

    assert.deepEqual(await textsOf(world), ['The button is too small.']);
    // Another browser is offered no edit.
    assert.equal((await read({ key: KEY_B })).get('ve_1')?.editable, undefined);
  });

  it('refuses once the team took the note on, done or closed, and offers no edit then', async () => {
    for (const stage of ['done', 'closed']) {
      const { world, edit, read, moveTo, issue } = await aVisitorNote();
      await moveTo(issue, stage);

      const refused = await edit(issue, 'Too late', { key: KEY_A });

      assert.equal(refused.status, 409, stage);
      assert.equal(refused.body.error, 'not-open');
      assert.deepEqual(await textsOf(world), ['The button is too small.']);
      assert.equal((await read({ key: KEY_A })).get('ve_1')?.editable, undefined, stage);
    }
  });

  it('refuses a visitor on a site that no longer takes the notes of anybody', async () => {
    const { world, site, edit, issue } = await aVisitorNote();
    await rowsOf(world.database, `UPDATE sites SET visibility = 'members', writers = 'members' WHERE id = '${site}'`);

    const refused = await edit(issue, 'Closed now', { key: KEY_A });

    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(await textsOf(world), ['The button is too small.']);
  });

  it('counts the edits of a visitor with their replies: 5 a minute from one address', async () => {
    const { edit, issue } = await aVisitorNote();
    const answers = [];
    for (let each = 1; each <= 6; each += 1) answers.push((await edit(issue, `Edit ${each}`, { key: KEY_A })).status);

    assert.deepEqual(answers, [200, 200, 200, 200, 200, 429]);
  });

  it('sends the edited text to the tracker, in a reply, and a read shows it (Linear)', async () => {
    const { edit, read, issue } = await aVisitorNote({ storeOf: () => createMemoryStore() });

    const edited = await edit(issue, 'The new words', { key: KEY_A });

    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(
      edited.body.comment.body,
      '**Camille** via Fruitback · not verified\nEdited the note\n\n> The new words',
    );
    assert.equal((await read({ key: KEY_A })).get('ve_1')?.note.text, 'The new words');
  });
});

/**
 * Each guard of FRU-701, taken out of a copy of its module: the case that holds it sees the change.
 * The real module is the control of each one, in the same world.
 *
 * The open stage is held twice, as for a member (FRU-475): by the route, and by the store under the
 * lock of the row. Taken out of the route alone, the store still answers `409 not-open`: the case
 * `refuses once the team took the note on` holds the two together, and `edit-route.test.ts` each one.
 */
describe('the guards of the edit of a visitor, each planted out (FRU-701)', () => {
  type Check = (site: Awaited<ReturnType<typeof aVisitorNote>>) => Promise<boolean>;
  const PLANTS: readonly { guard: string; file: string; from: string; to: string; holds: Check }[] = [
    {
      guard: 'another browser does not edit the note',
      file: 'edit-routes.ts',
      from: 'if (author === undefined || author !== caller.author) return json(403',
      to: 'if (author === undefined) return json(403',
      holds: async ({ edit, issue }) => (await edit(issue, 'Not theirs', { key: KEY_B })).status === 403,
    },
    {
      guard: 'a request with no key is nobody',
      file: 'visitor-key.ts',
      from: '  if (key === null || !KEY.test(key)) return undefined;\n',
      to: '',
      holds: async ({ send, noteOf, edit }) => {
        const keyless = await send(noteOf('ve_none'));

        return (await edit(keyless, 'Nobody', {})).status === 401;
      },
    },
    {
      guard: 'a site that does not take the notes of anybody lets no visitor edit',
      file: 'visitor-key.ts',
      from: "return policy.write === 'public';",
      to: 'return true;',
      holds: async ({ world, site, edit, issue }) => {
        await rowsOf(
          world.database,
          `UPDATE sites SET visibility = 'members', writers = 'members' WHERE id = '${site}'`,
        );

        return (await edit(issue, 'Closed now', { key: KEY_A })).status === 403;
      },
    },
    {
      guard: 'a token is never read as a browser',
      file: 'edit-routes.ts',
      from: 'const digest = token === undefined ? checks.visitorOf(request, site) : undefined;',
      to: 'const digest = checks.visitorOf(request, site);',
      holds: async ({ edit, issue }) =>
        (await edit(issue, 'A token', { key: KEY_A, token: 'not.a.session' })).status === 401,
    },
    {
      guard: 'the edits of a visitor are counted',
      file: 'edit-routes.ts',
      from: "if (caller.kind === 'visitor' && !(await checkReplyLimit(kv, context.context.clientIp))) {",
      to: 'if (false) {',
      holds: async ({ edit, issue }) => {
        let last = 0;
        for (let each = 1; each <= 6; each += 1) last = (await edit(issue, `Edit ${each}`, { key: KEY_A })).status;

        return last === 429;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      assert.equal(await plant.holds(await aVisitorNote()), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, { from: plant.from, to: plant.to });
      try {
        const handle = mutant.module.handleRequest as Handle;
        assert.equal(await plant.holds(await aVisitorNote({ handle })), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});
