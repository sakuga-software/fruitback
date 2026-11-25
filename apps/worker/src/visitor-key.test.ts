import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import type { World } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { VISITOR_HEADER, visitorDigestOf } from './visitor-key.ts';
import { type Handle, KEY_A, KEY_B, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * A visitor with no account is known by the key of their browser (FRU-700): their notes are `mine`
 * on the same browser, and on no other.
 *
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite), as the `<script>` of a site calls
 * it: an `Origin`, the id of the site, and the key of the browser in `X-Fruitback-Visitor`.
 */

const aSite = (handle?: Handle) => aVisitorSite(handle === undefined ? {} : { handle });

const visitorColumn = async (world: World) =>
  rowsOf(world.database, 'SELECT note_id, author_kind, author_visitor FROM note_index ORDER BY note_id');

describe('a visitor known by the key of their browser (FRU-700)', () => {
  it('marks the notes of this browser as mine, and those of no other browser', async () => {
    const { send, mine, noteOf } = await aSite();
    await send(noteOf('vk_a'), { key: KEY_A });
    await send(noteOf('vk_b'), { key: KEY_B });

    assert.deepEqual(await mine({ key: KEY_A }), ['vk_a']);
    assert.deepEqual(await mine({ key: KEY_B }), ['vk_b']);
    // No key, or a key of no note: nothing is mine.
    assert.deepEqual(await mine(), []);
    assert.deepEqual(await mine({ key: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }), []);
  });

  it('keeps a digest that names the site, never the key', async () => {
    const { world, site, send, noteOf } = await aSite();
    await send(noteOf('vk_a'), { key: KEY_A });

    const [row] = await visitorColumn(world);
    assert.equal(row?.author_kind, 'visitor');
    const digest = String(row?.author_visitor);
    assert.equal(digest.includes(KEY_A), false);
    const asked = (key: string, on: string) =>
      visitorDigestOf(new Request('https://w.test/', { headers: { [VISITOR_HEADER]: key } }), on);
    assert.equal(digest, asked(KEY_A, site));
    // The same key on another site gives another digest: a key of one site opens nothing on another.
    assert.notEqual(asked(KEY_A, `${site}x`), digest);
  });

  it('keeps no digest for a note sent with no key, nor with a key of another shape', async () => {
    const { world, send, mine, noteOf } = await aSite();
    await send(noteOf('vk_none'));
    await send(noteOf('vk_bad'), { key: 'not-a-key' });

    assert.deepEqual(
      (await visitorColumn(world)).map((row) => row.author_visitor),
      [null, null],
    );
    // A second browser with no key, or the same bad key, is nobody: nothing is mine.
    assert.deepEqual(await mine(), []);
    assert.deepEqual(await mine({ key: 'not-a-key' }), []);
  });

  it('knows the browser for each note of a batch', async () => {
    const { send, mine, noteOf } = await aSite();
    await send([noteOf('vk_1'), noteOf('vk_2')], { key: KEY_A });

    assert.deepEqual(await mine({ key: KEY_A }), ['vk_1', 'vk_2']);
    assert.deepEqual(await mine({ key: KEY_B }), []);
  });

  it('offers a visitor an edit and no withdrawal yet, on a note that is mine (FRU-701)', async () => {
    const { send, read, noteOf } = await aSite();
    await send(noteOf('vk_a'), { key: KEY_A });

    const pin = (await read({ key: KEY_A })).get('vk_a');
    assert.equal(pin?.mine, true);
    assert.equal(pin?.editable, true);
    assert.equal(pin?.withdrawable, undefined);
  });

  it('changes nothing for a member: their notes are theirs by their account, whatever key comes with it', async () => {
    const { world, bobToken, send, mine, noteOf } = await aSite();
    // The member sends with a key too: their note is theirs by their account, and keeps no digest.
    await send(noteOf('vk_bob'), { token: bobToken, key: KEY_A });
    await send(noteOf('vk_a'), { key: KEY_A });

    assert.deepEqual(await mine({ token: bobToken }), ['vk_bob']);
    // A session wins over the key of the browser it reads with.
    assert.deepEqual(await mine({ token: bobToken, key: KEY_A }), ['vk_bob']);
    // The browser with that key is not Bob.
    assert.deepEqual(await mine({ key: KEY_A }), ['vk_a']);
    const rows = await visitorColumn(world);
    assert.deepEqual(
      rows.map((row) => [row.note_id, row.author_kind, row.author_visitor]),
      [
        ['vk_a', 'visitor', rows[0]?.author_visitor],
        ['vk_bob', 'member', null],
      ],
    );
    assert.notEqual(rows[0]?.author_visitor, null);
  });
});

/**
 * Each guard of FRU-700, taken out of a copy of its module: the case that holds it sees the change.
 * The real module is the control of each one, in the same world.
 */
describe('the guards of the key of a browser, each planted out (FRU-700)', () => {
  const PLANTS: readonly { guard: string; file: string; from: string; to: string; holds: Check }[] = [
    {
      guard: 'the note of another browser is not mine',
      file: 'app.ts',
      from: '(author === reader.author ? [note] : [])',
      to: '[note]',
      holds: async ({ send, mine, noteOf }) => {
        await send(noteOf('vk_a'), { key: KEY_A });

        return (await mine({ key: KEY_B })).length === 0;
      },
    },
    {
      guard: 'a request with no key is nobody',
      file: 'visitor-key.ts',
      from: '  if (key === null || !KEY.test(key)) return undefined;\n',
      to: '',
      holds: async ({ send, mine, noteOf }) => {
        await send(noteOf('vk_none'));

        return (await mine()).length === 0;
      },
    },
    {
      guard: 'a key of another shape is no key',
      file: 'visitor-key.ts',
      from: '!KEY.test(key)',
      to: 'false',
      holds: async ({ send, mine, noteOf }) => {
        await send(noteOf('vk_bad'), { key: 'not-a-key' });

        return (await mine({ key: 'not-a-key' })).length === 0;
      },
    },
    {
      guard: 'a visitor is offered no withdrawal yet',
      file: 'feedback-routes.ts',
      from: "own.size > 0 && reader.by === 'account'",
      to: 'own.size > 0',
      holds: async ({ send, read, noteOf }) => {
        await send(noteOf('vk_a'), { key: KEY_A });

        return (await read({ key: KEY_A })).get('vk_a')?.withdrawable === undefined;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      const { handleRequest: real } = await import('./app.ts');
      assert.equal(await plant.holds(await aSite(real)), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, { from: plant.from, to: plant.to });
      try {
        assert.equal(await plant.holds(await aSite(mutant.module.handleRequest as Handle)), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});

type Check = (site: Awaited<ReturnType<typeof aSite>>) => Promise<boolean>;
