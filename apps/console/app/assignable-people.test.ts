import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Answer, Member, Role } from './api.ts';
import { MEMBERS_PER_READ, assignablePeople } from './assignable-people.ts';

/** The largest page of `list-members`, as the worker reads it in `organization-paths.ts`. */
const WORKER_PAGE = Number(
  /export const MEMBERS_PAGE = (\d+);/.exec(
    readFileSync(new URL('../../worker/src/organization-paths.ts', import.meta.url), 'utf8'),
  )?.[1],
);

const member = (n: number, role: Role = 'member'): Member => ({
  id: `m${n}`,
  userId: `a${n}`,
  role,
  createdAt: '2026-11-24T10:00:00.000Z',
  user: { id: `a${n}`, email: `p${n}@crowd.test`, name: `Person ${String(n).padStart(3, '0')}` },
});

/**
 * A worker of fakes for `list-members`, with the rule of the worker: `limit` of 1 to `WORKER_PAGE`,
 * else `400 invalid-request`. It answers the rows in the order they joined, and `total`.
 */
function worker(members: readonly Member[], fail?: (offset: number) => boolean) {
  const asked: { limit: number; offset: number }[] = [];
  const read = async (page: {
    limit: number;
    offset: number;
  }): Promise<Answer<{ members: Member[]; total: number }>> => {
    asked.push(page);
    if (page.limit < 1 || page.limit > WORKER_PAGE) return { ok: false, status: 400, error: 'invalid-request' };
    if (fail?.(page.offset) === true) return { ok: false, status: 503, error: 'store-unavailable' };

    return { ok: true, data: { members: members.slice(page.offset, page.offset + page.limit), total: members.length } };
  };

  return { read, asked };
}

describe('the people a task can be given to (FRU-673)', () => {
  it('asks for no larger page than the worker gives', () => {
    assert.ok(Number.isInteger(WORKER_PAGE), 'MEMBERS_PAGE is read from the worker');
    // The menu asked for 200 and the worker refused it: the menu listed nobody.
    assert.ok(MEMBERS_PER_READ <= WORKER_PAGE, `${MEMBERS_PER_READ} > ${WORKER_PAGE}`);
  });

  it('reads a workspace of two members in one page, without its guests, by name', async () => {
    const fake = worker([member(2), member(1, 'owner'), member(3, 'guest')]);

    assert.deepEqual(await assignablePeople(fake.read), [
      { id: 'a1', name: 'Person 001' },
      { id: 'a2', name: 'Person 002' },
    ]);
    assert.deepEqual(fake.asked, [{ limit: MEMBERS_PER_READ, offset: 0 }]);
  });

  it('reads every page of a workspace past a hundred members, to the last one', async () => {
    const fake = worker(Array.from({ length: 250 }, (_, n) => member(n + 1)));
    const people = await assignablePeople(fake.read);

    assert.notEqual(people, 'failed');
    assert.equal((people as readonly unknown[]).length, 250);
    assert.deepEqual((people as readonly { id: string }[]).at(-1), { id: 'a250', name: 'Person 250' });
    assert.deepEqual(fake.asked, [
      { limit: MEMBERS_PER_READ, offset: 0 },
      { limit: MEMBERS_PER_READ, offset: 100 },
      { limit: MEMBERS_PER_READ, offset: 200 },
    ]);
  });

  it('stops at a page that ends at the total, with no read of an empty page', async () => {
    const fake = worker(Array.from({ length: 200 }, (_, n) => member(n + 1)));

    assert.equal(((await assignablePeople(fake.read)) as readonly unknown[]).length, 200);
    assert.deepEqual(
      fake.asked.map((page) => page.offset),
      [0, 100],
    );
  });

  it('keeps a member once when a join moved the pages between two reads', async () => {
    const rows = Array.from({ length: 101 }, (_, n) => member(n + 1));
    // The second page starts one row early: a member joined before the first row, as seen by `offset`.
    const read = async (page: {
      limit: number;
      offset: number;
    }): Promise<Answer<{ members: Member[]; total: number }>> => {
      const start = page.offset === 0 ? 0 : page.offset - 1;

      return { ok: true, data: { members: rows.slice(start, start + page.limit), total: rows.length } };
    };

    assert.equal(((await assignablePeople(read)) as readonly unknown[]).length, 101);
  });

  it('is failed, and not a part of the members, when a page is refused', async () => {
    const fake = worker(
      Array.from({ length: 150 }, (_, n) => member(n + 1)),
      (offset) => offset === 100,
    );

    assert.equal(await assignablePeople(fake.read), 'failed');
  });

  it('is failed for an answer that says yes and holds no list', async () => {
    const read = async (): Promise<Answer<{ members: Member[] }>> => ({ ok: true, data: {} as { members: Member[] } });

    assert.equal(await assignablePeople(read), 'failed');
  });

  it('is failed for the page the worker refused before: the control', async () => {
    const fake = worker([member(1)]);
    const tooLarge = (page: { limit: number; offset: number }) => fake.read({ ...page, limit: 200 });

    assert.equal(await assignablePeople(tooLarge), 'failed');
  });
});
