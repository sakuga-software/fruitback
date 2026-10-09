import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer, request as httpRequest } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { deliverPending, handleRequest } from './app.ts';
import type { WorkerEnv } from './env.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import {
  ABANDONED_KEPT_DAYS,
  DELIVERY_HEADER,
  MESH_RANGE,
  RETRY_AFTER_SECONDS,
  SECRET_MIN_LENGTH,
  SIGNATURE_HEADER,
  type Send,
  TIMESTAMP_HEADER,
  deliverDue,
  deliveryBody,
  isPublicAddress,
  parseTargetUrl,
  sealTarget,
  signature,
} from './rest-connector.ts';
import { ANSWER_MAX_BYTES, DELIVERY_TIMEOUT_MS, createSender } from './rest-send.ts';
import { DELIVERY_PASS_MS } from './server.ts';
import { closeSessionConnections } from './session-sqlite.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const CONSOLE = 'https://app.fruitback.test';
const SITE = 'https://staging.acme.dev';
const TARGET = 'https://hooks.acme.dev/fruitback?team=design';
/** A moment after any day these tests run on: a delivery is due from the moment its note is written. */
const LATER_MS = 4_000_000_000_000;
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => (server.closeAllConnections(), server.close(done)))),
  );
});

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-rest-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'sqlite',
    FRUITBACK_SQLITE_PATH: join(directory, 'fb.db'),
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SECRETS_KEY: SECRETS_KEY,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
    ...overrides,
    // The path of the SQLite store is that store's own variable, so `WorkerEnv` does not name it.
  } as WorkerEnv;
}

let ip = 0;
function call(
  env: WorkerEnv,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  ip += 1;

  return handleRequest(
    new Request(`https://api.fruitback.test${path}`, {
      method,
      headers: {
        Origin: options.origin ?? CONSOLE,
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
    { clientIp: `203.0.113.${ip % 250}`, kv: createMemoryKv() },
  );
}

/** A workspace with its owner and one site read by everyone. */
async function acme(env: WorkerEnv, name = 'Acme', origin = SITE) {
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const person = async (email: string) => {
    const account = await accounts.signIn({ provider: 'email', subject: email, email });

    return { account, token: await signIdentityToken({ sub: account.id, exp }, SECRET) };
  };
  const owner = await person(`owner@${name.toLowerCase()}.dev`);
  const workspace = await accounts.createWorkspace(name, owner.account.id);
  const site = await accounts.addSite(workspace.id, { origin, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  return { accounts, owner, workspace, site, base, person };
}

type World = Awaited<ReturnType<typeof acme>>;

/** Connects the address and sends the notes of the site there. Answers the connector and its secret. */
async function receiving(env: WorkerEnv, world: World, body: Record<string, unknown> = {}) {
  const added = await call(env, 'POST', `${world.base}/connectors`, {
    token: world.owner.token,
    body: { kind: 'rest', url: TARGET, ...body },
  });
  assert.equal(added.status, 201, await added.clone().text());
  const connector = (await added.json()) as { id: string; label: string; secret?: string };
  const set = await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
    token: world.owner.token,
    body: { connector: connector.id },
  });
  assert.equal(set.status, 200, await set.clone().text());

  return connector;
}

function note(site: string, text = 'The price should say per month.') {
  const seed = seedFixture();

  return { ...seed, note: text, page: { ...seed.page, url: `${SITE}/pricing` }, client: { id: site } };
}

/** A receiver that keeps what it gets and answers what a test tells it to. */
function receiver(answer: () => number | Error = () => 204) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const send: Send = async (url, headers, body) => {
    got.push({ url, headers, body });
    const answered = answer();
    if (answered instanceof Error) throw answered;

    return { status: answered };
  };

  return { got, send };
}

describe('the signature of a delivery (FRU-122)', () => {
  it('is the HMAC-SHA256 of the timestamp, a dot and the body, as openssl computes it', () => {
    // printf '1760000000.{"version":1}' | openssl dgst -sha256 -hmac 'a-secret-of-enough-length'
    assert.equal(
      signature('a-secret-of-enough-length', 1_760_000_000, '{"version":1}'),
      'sha256=a73ee69fbd433aae0f6bf90c540f89584463d5c2ee12643fc69c36fd7195c38c',
    );
  });

  it('changes with the secret, the time and one byte of the body', () => {
    const signed = signature('a-secret-of-enough-length', 1_760_000_000, '{"version":1}');

    assert.notEqual(signature('another-secret-of-enough-length', 1_760_000_000, '{"version":1}'), signed);
    assert.notEqual(signature('a-secret-of-enough-length', 1_760_000_001, '{"version":1}'), signed);
    assert.notEqual(signature('a-secret-of-enough-length', 1_760_000_000, '{"version":2}'), signed);
  });
});

describe('the address a workspace gives (FRU-122)', () => {
  it('is https, with no name and password, and loses its fragment', () => {
    assert.equal(parseTargetUrl(' https://hooks.acme.dev/in?x=1#top '), 'https://hooks.acme.dev/in?x=1');
    assert.equal(parseTargetUrl('https://hooks.acme.dev:8443/in'), 'https://hooks.acme.dev:8443/in');
    for (const refused of [
      'http://hooks.acme.dev/in',
      'https://user:pass@hooks.acme.dev/in',
      'ftp://hooks.acme.dev',
      'hooks.acme.dev',
      '',
      7,
      `https://hooks.acme.dev/${'x'.repeat(2_048)}`,
    ]) {
      assert.equal(parseTargetUrl(refused), undefined, String(refused).slice(0, 40));
    }
  });

  it('is not an address of the worker, of its host or of a private network', () => {
    for (const internal of [
      'https://localhost/in',
      'https://api.localhost/in',
      'https://127.0.0.1/in',
      'https://10.0.0.5/in',
      'https://100.109.27.121/in',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.1/in',
      'https://[::1]/in',
      'https://[fd00::1]/in',
      'https://[::ffff:127.0.0.1]/in',
    ]) {
      assert.equal(parseTargetUrl(internal), undefined, internal);
    }
    assert.equal(parseTargetUrl('https://93.184.216.34/in'), 'https://93.184.216.34/in');
  });

  it('reads an address as public or not, an IPv4 address inside an IPv6 one included', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '172.32.0.1', '100.128.0.1']) {
      assert.equal(isPublicAddress(address), true, address);
    }
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      'not-an-address',
      '',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });
});

describe('a note of a site that sends to an address (FRU-122)', () => {
  it('is kept in the worker, read back from there, and sent signed with the secret of the connector', async () => {
    const env = envWith();
    const world = await acme(env);
    const connector = await receiving(env, world);
    assert.equal(connector.label, 'REST · hooks.acme.dev', 'the label holds the host, and no path or query');
    assert.match(connector.secret ?? '', /^fbs_[\w-]{43}$/);

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    const identifier = ((await written.json()) as { issue: { identifier: string } }).issue.identifier;
    assert.match(identifier, /^FB-\d+$/);

    const read = await call(
      env,
      'GET',
      `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${world.site.id}`,
      { origin: SITE },
    );
    assert.equal(((await read.json()) as { issues: unknown[] }).issues.length, 1, 'the pin is drawn from the worker');

    const { got, send } = receiver();
    await deliverPending(env, send, () => LATER_MS);

    assert.equal(got.length, 1);
    const [sent] = got as [(typeof got)[number]];
    assert.equal(sent.url, TARGET);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    assert.deepEqual(
      { ...body, seed: undefined },
      {
        version: 1,
        event: 'note.created',
        workspace: world.workspace.id,
        site: { id: world.site.id, origin: SITE },
        identifier,
        seed: undefined,
      },
    );
    assert.equal((body.seed as { note: string }).note, 'The price should say per month.');
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.equal(sent.headers[TIMESTAMP_HEADER], String(LATER_MS / 1_000));
    assert.match(sent.headers[DELIVERY_HEADER] ?? '', /^dlv_/);
    // Computed here with the secret the console was given, as a receiver does.
    assert.equal(
      sent.headers[SIGNATURE_HEADER],
      `sha256=${createHmac('sha256', connector.secret as string)
        .update(`${LATER_MS / 1_000}.${sent.body}`)
        .digest('hex')}`,
    );

    // Arrived: nothing is left to send, and nothing of the note stays in the queue.
    assert.deepEqual(await world.accounts.deliveries(world.workspace.id, connector.id), []);
    await deliverPending(env, send);
    assert.equal(got.length, 1);
  });

  it('answers the widget when the note is kept, whatever the receiver does later', async () => {
    const env = envWith();
    const world = await acme(env);
    await receiving(env, world);
    const { send } = receiver(() => new Error('connect ECONNREFUSED'));

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    await deliverPending(env, send);

    assert.equal(written.status, 201);
  });

  it('keeps the note when the queue refuses the row: the widget must not send it twice', async () => {
    const env = envWith();
    const world = await acme(env);
    await receiving(env, world);
    // The queue is gone under the worker: the note is still kept, and the request still succeeds.
    const { DatabaseSync } = await import('node:sqlite');
    const direct = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    direct.exec('DROP TABLE deliveries');
    direct.close();
    const errors: unknown[][] = [];
    const logged = console.error;
    console.error = (...line: unknown[]) => void errors.push(line);
    try {
      const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
      assert.equal(written.status, 201, await written.clone().text());
    } finally {
      console.error = logged;
    }

    assert.match(String(errors[0]?.[0]), /kept and its delivery was not queued/);
  });

  it('keeps the secret a person gave, and does not answer it', async () => {
    const env = envWith();
    const world = await acme(env);
    const connector = await receiving(env, world, { secret: 'the-secret-acme-chose-itself' });
    assert.equal('secret' in connector, false);

    await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    const { got, send } = receiver();
    await deliverPending(env, send, () => LATER_MS);

    assert.equal(
      got[0]?.headers[SIGNATURE_HEADER],
      signature('the-secret-acme-chose-itself', LATER_MS / 1_000, got[0]?.body ?? ''),
    );
  });

  it('holds the address and the secret encrypted in the file, and in no answer', async () => {
    const env = envWith();
    const world = await acme(env);
    const connector = await receiving(env, world);

    const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token });
    const text = await listed.text();
    assert.equal(text.includes(connector.secret as string), false);
    assert.equal(text.includes('team=design'), false, 'the query of the address can hold a token');

    closeAccountConnections();
    const directory = dirname(env.FRUITBACK_ACCOUNTS_PATH as string);
    const bytes = Buffer.concat(
      readdirSync(directory)
        .filter((name) => name.startsWith('accounts.db'))
        .map((name) => readFileSync(join(directory, name))),
    ).toString('latin1');
    assert.equal(bytes.includes(connector.secret as string), false);
    assert.equal(bytes.includes('hooks.acme.dev/fruitback'), false);
  });
});

describe('a delivery that does not arrive (FRU-122)', () => {
  /** A store with one connector and one delivery that is due at `0`. */
  async function queued() {
    const env = envWith();
    const world = await acme(env);
    const connector = await world.accounts.addConnector(world.workspace.id, {
      kind: 'rest',
      label: 'REST · hooks.acme.dev',
      sealed: sealTarget({ url: TARGET, secret: 'a-secret-of-enough-length' }, SECRETS_KEY),
    });
    const id = await world.accounts.enqueueDelivery(connector.id, '{"version":1}', 0);
    const late = () => world.accounts.deliveries(world.workspace.id, connector.id);

    return { env, world, connector, id, late };
  }

  it('is tried again after each wait of the list, with the same body, then given up', async () => {
    const { world, late } = await queued();
    const { got, send } = receiver(() => 503);
    let clock = 0;
    const pass = () => deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => clock });

    assert.deepEqual(await pass(), { delivered: 0, failed: 1 });
    for (const [index, wait] of RETRY_AFTER_SECONDS.entries()) {
      const [waiting] = await late();
      assert.equal(waiting?.attempts, index + 1);
      assert.equal(waiting?.lastStatus, 503);
      assert.equal(waiting?.nextAt, new Date(clock + wait * 1_000).toISOString());

      // One second early: nothing is sent.
      clock += wait * 1_000 - 1_000;
      assert.deepEqual(await pass(), { delivered: 0, failed: 0 });
      clock += 1_000;
      assert.deepEqual(await pass(), { delivered: 0, failed: 1 });
    }

    const [abandoned] = await late();
    assert.equal(abandoned?.attempts, RETRY_AFTER_SECONDS.length + 1);
    assert.equal(abandoned?.nextAt, undefined, 'no more attempt: the console offers one');
    clock += 365 * 24 * 60 * 60 * 1_000;
    assert.equal(got.length, RETRY_AFTER_SECONDS.length + 1);
    assert.deepEqual(new Set(got.map((each) => each.body)), new Set(['{"version":1}']));
    assert.equal(new Set(got.map((each) => each.headers[DELIVERY_HEADER])).size, 1, 'one id for every attempt');
  });

  it('says why when no answer came, and arrives at the next attempt', async () => {
    const { world, late } = await queued();
    let answer: number | Error = new Error('The address resolves to a network the worker does not call');
    const { send } = receiver(() => answer);
    let clock = 0;
    const pass = () => deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => clock });

    await pass();
    const [waiting] = await late();
    assert.equal(waiting?.lastError, 'The address resolves to a network the worker does not call');
    assert.equal(waiting?.lastStatus, undefined);

    answer = 200;
    clock = 60_000;
    assert.deepEqual(await pass(), { delivered: 1, failed: 0 });
    assert.deepEqual(await late(), []);
  });

  it('counts a redirect and a refusal as not arrived: only a 2xx is an arrival', async () => {
    for (const status of [301, 302, 400, 401, 404, 500]) {
      const { world, late } = await queued();
      const { send } = receiver(() => status);
      await deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => 0 });

      assert.equal((await late())[0]?.lastStatus, status);
      closeAccountConnections();
    }
  });

  it('does not stop the notes of the others', async () => {
    const { world, connector, late } = await queued();
    const second = await world.accounts.enqueueDelivery(connector.id, '{"version":1,"n":2}', 1);
    let calls = 0;
    const { send } = receiver(() => ((calls += 1) === 1 ? new Error('down') : 204));

    assert.deepEqual(await deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => 10 }), {
      delivered: 1,
      failed: 1,
    });
    assert.equal(
      (await late()).some((each) => each.id === second),
      false,
    );
  });

  it('waits, and counts no failure, on a worker that lost the key that opens the address', async () => {
    const { world, late } = await queued();
    const { got, send } = receiver();

    assert.deepEqual(await deliverDue({ accounts: world.accounts, secretsKey: undefined, send, now: () => 10 }), {
      delivered: 0,
      failed: 0,
    });
    assert.equal(got.length, 0);
    assert.equal((await late())[0]?.attempts, 0);
  });

  it('fails, and sends nothing, when the key does not open the address', async () => {
    const { world, late } = await queued();
    const { got, send } = receiver();
    await deliverDue({
      accounts: world.accounts,
      secretsKey: 'a-key-that-sealed-nothing-of-this-file',
      send,
      now: () => 10,
    });

    assert.equal(got.length, 0);
    assert.equal((await late())[0]?.lastError, 'The address of this connector could not be opened');
  });

  it('is due again when somebody asks, and only for the workspace it belongs to', async () => {
    const { env, world, connector, id, late } = await queued();
    const { send } = receiver(() => 500);
    let clock = 0;
    for (let attempt = 0; attempt <= RETRY_AFTER_SECONDS.length; attempt += 1) {
      await deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => clock });
      clock += 86_400_000;
    }
    assert.equal((await late())[0]?.nextAt, undefined);

    const other = await acme(env, 'Other', 'https://other.dev');
    const path = `/connectors/${connector.id}/deliveries/${id}/retry`;
    assert.equal((await call(env, 'POST', `${other.base}${path}`, { token: other.owner.token })).status, 404);
    assert.equal((await late())[0]?.nextAt, undefined, 'another workspace changed nothing');

    assert.equal((await call(env, 'POST', `${world.base}${path}`, { token: world.owner.token })).status, 204);
    assert.notEqual((await late())[0]?.nextAt, undefined);
    assert.equal(
      (
        await call(env, 'POST', `${world.base}/connectors/${connector.id}/deliveries/dlv_unknown/retry`, {
          token: world.owner.token,
        })
      ).status,
      404,
    );
  });

  it('is removed when nobody asked for it for the days the worker keeps it', async () => {
    const { world, late } = await queued();
    const { send } = receiver(() => 500);
    let clock = 0;
    const pass = () => deliverDue({ accounts: world.accounts, secretsKey: SECRETS_KEY, send, now: () => clock });
    for (let attempt = 0; attempt <= RETRY_AFTER_SECONDS.length; attempt += 1) {
      await pass();
      clock += 86_400_000;
    }
    const givenUpAt = clock - 86_400_000;

    clock = givenUpAt + ABANDONED_KEPT_DAYS * 86_400_000;
    await pass();
    assert.equal((await late()).length, 1, 'kept to the last day');
    clock += 1;
    await pass();
    assert.deepEqual(await late(), []);
  });

  it('goes with its connector', async () => {
    const { world, connector } = await queued();
    await world.accounts.removeConnector(world.workspace.id, connector.id);

    assert.deepEqual(await world.accounts.dueDeliveries(10, 10), []);
  });
});

describe('who may connect an address and read its deliveries (FRU-122)', () => {
  it('refuses an address the worker must not call, and a secret that is too short', async () => {
    const env = envWith();
    const world = await acme(env);
    const add = (body: Record<string, unknown>) =>
      call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body: { kind: 'rest', ...body } });

    for (const url of ['http://hooks.acme.dev/in', 'https://169.254.169.254/', 'https://localhost/in', undefined]) {
      const refused = await add({ url });
      assert.equal(refused.status, 400, String(url));
      assert.deepEqual(await refused.json(), { error: 'invalid-address' });
    }
    const short = await add({ url: TARGET, secret: 'too-short' });
    assert.deepEqual([short.status, await short.json()], [400, { error: 'invalid-secret' }]);
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
  });

  it('takes no team for an address, and still asks one for a tracker', async () => {
    const env = envWith();
    const world = await acme(env);
    const connector = await receiving(env, world);
    const place = (body: Record<string, unknown>) =>
      call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, { token: world.owner.token, body });

    assert.equal((await place({ connector: connector.id, teamId: 'team_design' })).status, 400);
    assert.equal((await place({ connector: 'con_unknown' })).status, 404);
    assert.equal(
      (await call(env, 'GET', `${world.base}/connectors/${connector.id}/teams`, { token: world.owner.token })).status,
      404,
    );

    const tracker = await world.accounts.addConnector(world.workspace.id, {
      kind: 'linear',
      label: 'Linear',
      sealed: 'x',
    });
    assert.equal((await place({ connector: tracker.id })).status, 400, 'a tracker needs its team');
  });

  it('shows the deliveries to who may see the tracker, without the note', async () => {
    const env = envWith();
    const world = await acme(env);
    const connector = await receiving(env, world);
    await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id, 'A note nobody must read here') });
    const guest = await world.person('guest@client.dev');
    const { DatabaseSync } = await import('node:sqlite');
    closeAccountConnections();
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    database
      .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, 1)')
      .run(world.workspace.id, guest.account.id, 'guest');
    database.close();
    const path = `${world.base}/connectors/${connector.id}/deliveries`;

    const listed = await call(env, 'GET', path, { token: world.owner.token });
    const text = await listed.text();
    assert.equal(listed.status, 200);
    assert.equal((JSON.parse(text) as { deliveries: unknown[] }).deliveries.length, 1);
    assert.equal(text.includes('A note nobody must read here'), false);
    assert.equal((await call(env, 'GET', path, { token: guest.token })).status, 403);

    const other = await acme(env, 'Other', 'https://other.dev');
    const elsewhere = `${other.base}/connectors/${connector.id}/deliveries`;
    assert.equal((await call(env, 'GET', elsewhere, { token: other.owner.token })).status, 404);
  });
});

describe('the request of a delivery, on a socket (FRU-122)', () => {
  /** A local server, and a sender that may call it. The production sender may not. */
  async function local(
    handle: (request: IncomingMessage, body: string) => { status: number; location?: string } | 'hang',
  ) {
    const seen: { headers: IncomingMessage['headers']; body: string; url: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        seen.push({ headers: request.headers, body, url: request.url ?? '' });
        const answer = handle(request, body);
        if (answer === 'hang') return;
        response.writeHead(answer.status, answer.location === undefined ? {} : { Location: answer.location });
        response.end('x'.repeat(200_000));
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const send = createSender({
      request: httpRequest as unknown as typeof httpsRequest,
      allows: () => true,
      timeoutMs: 300,
    });

    return { seen, url, send };
  }

  it('posts the body and the headers, and answers the status', async () => {
    const { seen, url, send } = await local(() => ({ status: 202 }));

    const answered = await send(
      `${url}/in?team=design`,
      { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: 'sha256=abc' },
      '{"é":1}',
    );

    assert.deepEqual(answered, { status: 202 });
    assert.equal(seen[0]?.url, '/in?team=design');
    assert.equal(seen[0]?.body, '{"é":1}');
    assert.equal(seen[0]?.headers['x-fruitback-signature'], 'sha256=abc');
    assert.equal(seen[0]?.headers['content-length'], '8', 'the length is in bytes, not in characters');
  });

  it('does not follow a redirect: it could lead to an address the worker must not call', async () => {
    const target = await local(() => ({ status: 200 }));
    const { url, send } = await local(() => ({ status: 302, location: `${target.url}/inside` }));

    assert.deepEqual(await send(`${url}/in`, {}, '{}'), { status: 302 });
    assert.equal(target.seen.length, 0);
  });

  it('gives up on a receiver that takes the request and never answers', async () => {
    const { url, send } = await local(() => 'hang');

    await assert.rejects(send(`${url}/in`, {}, '{}'), /did not answer in time/);
  });

  it('refuses, as the production sender, a name that resolves to the worker itself', async () => {
    const { seen, url } = await local(() => ({ status: 200 }));
    const send = createSender({ request: httpRequest as unknown as typeof httpsRequest });

    await assert.rejects(send(`${url}/in`, {}, '{}'), /resolves to a network the worker does not call/);
    assert.equal(seen.length, 0, 'no byte reached the server');
  });

  it('refuses, as the production sender, an internal address written in the URL: no lookup sees it', async () => {
    const { seen, url } = await local(() => ({ status: 200 }));
    let looked = 0;
    const lookup = ((...call: unknown[]) => {
      looked += 1;
      (call.at(-1) as (error: null, addresses: unknown) => void)(null, [{ address: '93.184.216.34', family: 4 }]);
    }) as unknown as NonNullable<Parameters<typeof createSender>[0]>['lookup'];
    const send = createSender({ request: httpRequest as unknown as typeof httpsRequest, lookup });
    const port = new URL(url).port;

    for (const literal of [
      `http://127.0.0.1:${port}/in`,
      `http://[::1]:${port}/in`,
      `http://[::ffff:127.0.0.1]:${port}/in`,
    ]) {
      await assert.rejects(send(literal, {}, '{}'), /resolves to a network the worker does not call/, literal);
    }
    assert.equal(seen.length, 0);
    assert.equal(looked, 0, 'an address is not resolved, so only the check on the URL stands here');
  });

  it('refuses a name when one of its addresses is internal, whatever the others are', async () => {
    const { seen, url } = await local(() => ({ status: 200 }));
    const lookup = ((_host: string, _options: unknown, done: (error: null, addresses: unknown) => void) =>
      done(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])) as unknown as NonNullable<Parameters<typeof createSender>[0]>['lookup'];
    const send = createSender({ request: httpRequest as unknown as typeof httpsRequest, lookup });

    await assert.rejects(send(`${url}/in`, {}, '{}'), /resolves to a network the worker does not call/);
    assert.equal(seen.length, 0);
  });
});

describe('the loop that sends (FRU-122)', () => {
  // `server.ts` has no test of its own: it opens a socket. Without these lines every test above stays
  // green and no note is ever sent, so the wiring is read from the source.
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  it('is started by the server, with the sender that checks the address', () => {
    assert.match(server, /const send = createSender\(\);/);
    assert.match(server, /void deliverPending\(env, send\)/);
    assert.match(server, /setInterval\(/);
  });

  it('runs one pass at a time, and stops with the server', () => {
    assert.match(server, /if \(passing\) return;/);
    assert.match(server, /pass\.unref\(\);/);
    assert.match(server, /server\.on\('close', \(\) => clearInterval\(pass\)\)/);
  });
});

describe('the contract a receiver is written against (FRU-122)', () => {
  const guide = readFileSync(new URL('../../../docs/rest-connector.md', import.meta.url), 'utf8');
  const flat = guide.replace(/\s+/g, ' ');

  it('names the headers and the signature of the example as the worker computes them', () => {
    for (const header of [DELIVERY_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER]) {
      assert.ok(guide.includes(`\`${header}\``), `the guide does not name ${header}`);
    }
    // The example reads the two headers a signature is checked with.
    for (const header of [TIMESTAMP_HEADER, SIGNATURE_HEADER]) {
      assert.ok(guide.includes(`'${header.toLowerCase()}'`), `the example does not read ${header.toLowerCase()}`);
    }
    const example = /printf '(\d+)\.(.+?)' \| openssl dgst -sha256 -hmac '([^']+)'\n# ([0-9a-f]{64})/.exec(guide);
    assert.ok(example !== null, 'the openssl example was not found');
    const [, timestamp, body, secret, digest] = example as unknown as [string, string, string, string, string];

    assert.equal(signature(secret, Number(timestamp), body), `sha256=${digest}`);
  });

  it('says the waits, the timeout, the pass and the days as the code holds them', () => {
    const spoken = (seconds: number): string => {
      if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;

      return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
    };
    const waits = RETRY_AFTER_SECONDS.map(spoken);

    assert.ok(
      flat.includes(`after ${waits.slice(0, -1).join(', ')} and ${waits.at(-1)}`),
      `the guide does not list the waits: ${waits.join(', ')}`,
    );
    assert.ok(flat.includes('seven attempts'), 'one first attempt and six more');
    assert.equal(RETRY_AFTER_SECONDS.length + 1, 7);
    assert.ok(flat.includes(`no answer in ${DELIVERY_TIMEOUT_MS / 1_000} seconds`));
    assert.ok(flat.includes(`within about ${DELIVERY_PASS_MS / 1_000} seconds`));
    assert.ok(flat.includes(`removed after ${ABANDONED_KEPT_DAYS} days`));
    assert.ok(flat.includes(`The secret is ${SECRET_MIN_LENGTH} to 256 characters`));
  });

  it('is described in SECURITY.md with the numbers the code holds', () => {
    const security = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');
    const section = security.slice(security.indexOf('### An address that receives the notes'));
    const stated = section.slice(0, section.indexOf('\n### ', 4)).replace(/\s+/g, ' ');

    assert.ok(stated.length > 500, 'the section was not found');
    assert.ok(stated.includes(`\`${MESH_RANGE[0]}/${MESH_RANGE[1]}\``));
    assert.ok(stated.includes(`bounded at ${DELIVERY_TIMEOUT_MS / 1_000} seconds`));
    assert.ok(stated.includes(`${ANSWER_MAX_BYTES / 1_024} kB of answer`));
    assert.ok(stated.includes(`removed ${ABANDONED_KEPT_DAYS} days after its last attempt`));
    assert.ok(stated.includes('given up after seven attempts') && stated.includes('six more attempts at most'));
    assert.equal(RETRY_AFTER_SECONDS.length, 6);
  });

  it('shows a body with the fields the worker sends, and no other', () => {
    const shown = JSON.parse(/```json\n([\s\S]*?)```/.exec(guide)?.[1] ?? '{}') as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(shown),
      Object.keys(
        JSON.parse(
          deliveryBody({ workspace: 'w', site: { id: 's' }, identifier: 'FB-1', seed: seedFixture() }),
        ) as object,
      ),
    );
  });
});
