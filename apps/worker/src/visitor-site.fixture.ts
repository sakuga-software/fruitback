import assert from 'node:assert/strict';
import type { Note } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type handleRequest as realHandle, handleRequest } from './app.ts';
import { WORKER, type World, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';
import { VISITOR_HEADER } from './visitor-key.ts';

/**
 * A site that everyone reads and anyone writes on, its page, and the calls a page and the extension
 * make to it (FRU-700): what the cases of a visitor known by their browser share.
 *
 * Each call goes through `handleRequest`, on PostgreSQL (PGlite), as the `<script>` of a site sends
 * it: an `Origin`, the id of the site, and the key of the browser in `X-Fruitback-Visitor`. From one
 * address, so that the limits of a visitor count as they do for one browser.
 */

export type Handle = typeof realHandle;

export const ORIGIN = 'https://acme.dev';
export const PAGE = 'https://acme.dev/pricing';

/** Two keys as the widget makes them: 32 bytes in base64url. */
export const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/** Who calls: the key of a browser, a session of the extension, or both. */
export type Who = { key?: string; token?: string };

export type Answer = { status: number; body: Record<string, any> };

const open = worlds();

async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/**
 * Alice owns Acme and its site; Bob is a member. Both have a session of the extension. `handle`: the real
 * handler, or a copy of it with a guard taken out. `storeOf`: the worker's own store, or another one.
 */
export async function aVisitorSite(options: { handle?: Handle; storeOf?: (world: World) => NoteStore } = {}) {
  const handle = options.handle ?? handleRequest;
  const world = await open();
  const store = (options.storeOf ?? ((each: World) => createPostgresNoteStore(each.database)))(world);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'everyone', writers: 'anyone' }))
    .id;
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const bobToken = await sessionOf(world, bob.id, workspace);
  // The owner moves a note in the console: a role that manages the sites.
  const aliceToken = await sessionOf(world, alice.id, workspace);

  /** A call of the page: the key of the browser when given, a session of the extension when given. */
  const call = async (method: string, path: string, who: Who = {}, body?: unknown): Promise<Answer> => {
    const response = await handle(
      new Request(`${WORKER}${path}`, {
        method,
        headers: {
          Origin: ORIGIN,
          ...(who.key === undefined ? {} : { [VISITOR_HEADER]: who.key }),
          ...(who.token === undefined ? {} : { Authorization: `Bearer ${who.token}` }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      world.env,
      { clientIp: '198.18.2.1', ...world.context, store },
    );
    const text = await response.text();

    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  };

  const noteOf = (id: string, text = 'The button is too small.', name?: string): Note =>
    noteFixture({
      id,
      text,
      page: { url: PAGE, path: '/pricing' },
      client: { id: site, name: 'Acme' },
      ...(name === undefined ? {} : { reporter: { name } }),
    });

  /** Sends a note, or a batch, and answers the id of the issue of the first one. */
  const send = async (note: Note | Note[], who: Who = {}): Promise<string> => {
    const sent = await call('POST', '/feedback', who, note);
    assert.equal(sent.status < 300, true, JSON.stringify(sent.body));

    return (sent.body.issue?.id ?? sent.body.results?.[0]?.issue?.id) as string;
  };

  /** The pins of `PAGE` as this reader reads them, by the id the widget gave each note. */
  const read = async (who: Who = {}) => {
    const answer = await call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, who);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));

    return new Map((answer.body.issues as Record<string, any>[]).map((issue) => [issue.note.id as string, issue]));
  };
  const mine = async (who: Who = {}) =>
    [...(await read(who))].flatMap(([id, issue]) => (issue.mine === true ? [id] : [])).sort();

  /** The team puts a note in a built-in status of the site, as the console does. */
  const moveTo = async (issue: string, stage: string) => {
    const moved = await call(
      'POST',
      `/feedback/${issue}/status?client=${site}`,
      { token: aliceToken },
      {
        url: PAGE,
        status: `own:${stage}`,
      },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  };

  return { world, store, workspace, site, bobToken, call, send, read, mine, noteOf, moveTo };
}
