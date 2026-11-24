import type { Answer, Member } from './api.ts';

/**
 * How many members one read asks for: the most that the worker gives in one page (`MEMBERS_PAGE` of
 * `apps/worker/src/organization-paths.ts`). The worker refuses a larger `limit` with a `400`.
 */
export const MEMBERS_PER_READ = 100;

/** A person a task can be given to: their account, and the name the menus show. */
export type AssignablePerson = { id: string; name: string };

/** One page of the members, from `list-members` of the worker. */
export type MembersPage = (page: {
  limit: number;
  offset: number;
}) => Promise<Answer<{ members: Member[]; total?: number }>>;

/**
 * The people a task can be given to (FRU-673): every member of the workspace but its guests, by name.
 *
 * The worker gives the members a page at a time, in the order they joined, with `total`. The pages are
 * read one after the other, until the last one. A page that the worker refuses, or that holds no list,
 * makes the whole read `failed`: a part of the members is not the members, and the menu says so.
 */
export async function assignablePeople(read: MembersPage): Promise<readonly AssignablePerson[] | 'failed'> {
  const members = new Map<string, Member>();
  let offset = 0;
  for (;;) {
    const answer = await read({ limit: MEMBERS_PER_READ, offset });
    if (!answer.ok || !Array.isArray(answer.data?.members)) return 'failed';
    const page = answer.data.members;
    // A member who joined between two reads moves the next page by one: a row read twice is kept once.
    for (const member of page) members.set(member.user.id, member);
    offset += page.length;
    const total = answer.data.total;
    // A page shorter than asked is the last one. So is a page that ends at the total.
    if (page.length < MEMBERS_PER_READ || (typeof total === 'number' && offset >= total)) break;
  }

  return [...members.values()]
    .filter((member) => member.role !== 'guest')
    .map((member) => ({ id: member.user.id, name: member.user.name || member.user.email }))
    .sort((one, other) => one.name.localeCompare(other.name));
}
