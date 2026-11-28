import assert from 'node:assert/strict';
import type { Note } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type handleRequest as realHandle, handleRequest } from './app.ts';
import { WORKER, type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteIndex } from './notes-index.ts';
import type { NoteStore } from './store.ts';
import { VISITOR_HEADER } from './visitor-key.ts';

/**
 * A site that everyone reads and anyone writes on, its page, and the calls a page and the extension
 * make to it (FRU-700, FRU-701, FRU-702): what the cases of a visitor known by their browser share.
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

/**
 * FRU-706: the key that seals the keys of the sites, in a world whose site signs its visitors. A value
 * of a test, in a public repository: it seals nothing anywhere else.
 */
export const SECRETS_KEY = 'test-only-key-that-seals-the-keys-of-the-sites';

/** Who calls: the key of a browser, a session of the extension or a token of the site, or both. */
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
export async function aVisitorSite(
  options: {
    handle?: Handle;
    storeOf?: (world: World) => NoteStore;
    /** The index of the notes of the world, or another in its place (FRU-702: one that fails). */
    indexOf?: (index: NoteIndex) => NoteIndex;
    /**
     * FRU-706: the site recognises its visitors by a token its backend signs, with a key the owner
     * makes in the console (`siteKey`). The world seals it with `SECRETS_KEY`.
     */
    signed?: boolean;
    /** FRU-705: the site recognises its visitors by an address they confirm (`askLink`, `confirm`). */
    email?: boolean;
  } = {},
) {
  const handle = options.handle ?? handleRequest;
  const world = await open(options.signed === true ? { env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } } : {});
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
  // FRU-706: the owner makes the key of the site, then says the site signs its visitors, as the console does.
  let siteKey: string | undefined;
  if (options.signed === true) {
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites/${site}/identity-key`, {
      token: alice.token,
    });
    assert.equal(made.status, 201, await made.clone().text());
    siteKey = ((await made.json()) as { key: string }).key;
    const set = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', visitorIdentity: 'signed' },
    });
    assert.equal(set.status, 201, await set.clone().text());
  }
  // FRU-705: the owner says the site recognises its visitors by a confirmed address.
  if (options.email === true) {
    const set = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: alice.token,
      body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', visitorIdentity: 'email' },
    });
    assert.equal(set.status, 201, await set.clone().text());
  }
  /** FRU-706: a token the backend of the site mints for `sub`, valid for a minute unless `exp` says. */
  const signedAs = (sub: string, claims: { exp?: number; name?: string; key?: string } = {}) =>
    signIdentityToken(
      {
        sub,
        exp: claims.exp ?? Math.floor(Date.now() / 1000) + 60,
        ...(claims.name === undefined ? {} : { name: claims.name }),
      },
      claims.key ?? siteKey ?? 'a-site-that-signs-nobody-has-no-key-0123456789',
    );

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
      {
        clientIp: '198.18.2.1',
        ...world.context,
        store,
        ...(options.indexOf === undefined || world.context.noteIndex === undefined
          ? {}
          : { noteIndex: options.indexOf(world.context.noteIndex) }),
      },
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

  /** `POST /feedback/<issue>/text` of the page. */
  const edit = (issue: string, text: unknown, who: Who = {}) =>
    call('POST', `/feedback/${issue}/text?client=${site}`, who, { url: PAGE, text });

  /** `POST /feedback/<issue>/withdraw` of the page (FRU-702). */
  const withdraw = (issue: string, who: Who = {}) =>
    call('POST', `/feedback/${issue}/withdraw?client=${site}`, who, { url: PAGE });

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

  /** FRU-705: asks for a link to `email`, from the page, with the key of this browser. */
  const askLink = (email: string, who: Who = {}, url = PAGE) =>
    call('POST', `/feedback/visitor/email?client=${site}`, who, { email, url, locale: 'en' });
  /** FRU-705: the token of the last link the worker sent, as the page reads it after `#fruitback-confirm=`. */
  const lastLink = (): string | undefined => {
    const text = world.mail.sent.at(-1)?.text ?? '';

    return /#fruitback-confirm=([^\s]+)/u.exec(text)?.[1];
  };
  /** FRU-705: the widget sends the token of the link it was opened with. */
  const confirm = (token: string | undefined, who: Who = {}) =>
    call('POST', `/feedback/visitor/confirm?client=${site}`, who, { token });

  return {
    askLink,
    lastLink,
    confirm,
    world,
    store,
    workspace,
    site,
    alice,
    bobToken,
    siteKey,
    signedAs,
    call,
    send,
    read,
    mine,
    noteOf,
    edit,
    withdraw,
    moveTo,
    handle,
  };
}
