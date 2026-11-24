import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { deliverPending } from './app.ts';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn as call, signInTo, worlds } from './console-world.fixture.ts';
import { TASK_EVENT_FIELDS, changedTaskFields } from './note-events.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import {
  DELIVERY_HEADER,
  RETRY_AFTER_SECONDS,
  SIGNATURE_HEADER,
  type Send,
  TIMESTAMP_HEADER,
} from './rest-connector.ts';

/**
 * The events of a task sent to an address (FRU-660): `note.status_changed`, `note.replied` and
 * `note.updated`. Each is queued in the transaction of the store that writes the change, so every
 * path emits, once, and a change that changes nothing emits nothing. They go through the queue of
 * `note.created`: signed, and tried again.
 */

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const TARGET = 'https://hooks.acme.dev/fruitback';
/** After any day these tests run on: every delivery is due. */
const LATER_MS = 4_000_000_000_000;
const open = worlds();

type Got = { url: string; headers: Record<string, string>; body: string };

/** A receiver that keeps what it gets and answers what the test tells it to. */
function receiver(answer: () => number = () => 204) {
  const got: Got[] = [];
  const send: Send = async (url, headers, body) => {
    got.push({ url, headers, body });

    return { status: answer() };
  };

  return { got, send };
}

/** A site of Acme that sends its notes to an address, with one note of a visitor, already delivered. */
async function acme({ destination = 'rest' }: { destination?: 'rest' | 'none' } = {}) {
  const base = await open({ env: { FRUITBACK_STORE: 'postgres', FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const store = createPostgresNoteStore(base.database);
  const world: World = { ...base, context: { ...base.context, store } };
  const owner = await signInTo(world, 'owner@acme.dev');
  const workspace = (await world.accounts.createWorkspace('Acme', owner.id)).id;
  const site = (await world.accounts.addSite(workspace, { origin: SITE, visibility: 'everyone' })).id;
  const console = `/console/workspaces/${workspace}`;
  let secret = '';
  let connector = '';
  if (destination === 'rest') {
    const added = await call(world, 'POST', `${console}/connectors`, {
      token: owner.token,
      body: { kind: 'rest', url: TARGET },
    });
    assert.equal(added.status, 201, await added.clone().text());
    ({ id: connector, secret } = (await added.json()) as { id: string; secret: string });
    const set = await call(world, 'POST', `${console}/sites/${site}/destination`, {
      token: owner.token,
      body: { connector },
    });
    assert.equal(set.status, 200, await set.clone().text());
  }
  const fixture = noteFixture();
  const widgetId = fixture.id;
  const written = await call(world, 'POST', '/feedback', {
    origin: SITE,
    body: { ...fixture, page: { ...fixture.page, url: PAGE }, client: { id: site } },
  });
  assert.equal(written.status, 201, await written.clone().text());
  const { issue } = (await written.json()) as { issue: { id: string; identifier: string } };
  const note = noteIdOf(site, widgetId);

  /** One pass of the loop that sends; answers the bodies of this pass, parsed. */
  const deliver = async (answer?: () => number, now = () => LATER_MS) => {
    const { got, send } = receiver(answer);
    await deliverPending(world.env, send, now, world.accounts);

    return got;
  };
  // `note.created` leaves first: what follows is the events of the task alone.
  const created = await deliver();
  assert.equal(created.length, destination === 'rest' ? 1 : 0);

  const asOwner = (method: string, path: string, body?: unknown) =>
    call(world, method, `${console}${path}`, { token: owner.token, ...(body === undefined ? {} : { body }) });
  const setStatus = async (status: string) => {
    const answer = await asOwner('POST', `/notes/${note}/status`, { status });
    assert.equal(answer.status, 200, await answer.clone().text());
  };
  const setTask = async (change: Record<string, unknown>) => {
    const answer = await asOwner('POST', `/notes/${note}/task`, change);
    assert.equal(answer.status, 204, await answer.clone().text());
  };
  const reply = async (body: string) => {
    const answer = await call(world, 'POST', `/feedback/${issue.id}/replies?client=${site}`, {
      origin: SITE,
      body: { url: PAGE, body, name: 'Ann' },
    });
    assert.equal(answer.status, 201, await answer.clone().text());

    return ((await answer.json()) as { comment: { id: string } }).comment.id;
  };
  const waiting = () => (connector === '' ? Promise.resolve([]) : world.accounts.deliveries(workspace, connector));

  return {
    world,
    store,
    owner,
    workspace,
    site,
    issue,
    note,
    secret,
    deliver,
    asOwner,
    setStatus,
    setTask,
    reply,
    waiting,
  };
}

const parsed = (got: Got[]) => got.map((one) => JSON.parse(one.body) as Record<string, unknown>);

describe('a status changed on a task sent to an address (FRU-660)', () => {
  it('sends one `note.status_changed`, signed, with the status and the stage before and after, and ids only', async () => {
    const { workspace, site, issue, note, secret, deliver, setStatus } = await acme();
    await setStatus('own:todo');
    const got = await deliver();

    assert.equal(got.length, 1, 'one event for one change');
    const [sent] = got as [Got];
    assert.equal(sent.url, TARGET);
    assert.deepEqual(JSON.parse(sent.body), {
      version: 2,
      event: 'note.status_changed',
      workspace,
      site: { id: site, origin: SITE },
      identifier: issue.identifier,
      note: { id: note },
      at: (JSON.parse(sent.body) as { at: string }).at,
      status: { from: 'own:new', to: 'own:todo' },
      stage: { from: 'new', to: 'todo' },
    });
    // Computed with the secret the console showed once, as a receiver does.
    assert.equal(
      sent.headers[SIGNATURE_HEADER],
      `sha256=${createHmac('sha256', secret).update(`${sent.headers[TIMESTAMP_HEADER]}.${sent.body}`).digest('hex')}`,
    );
    assert.match(sent.headers[DELIVERY_HEADER] ?? '', /^dlv_/);
    // Arrived: nothing is left, and a second pass sends nothing.
    assert.equal((await deliver()).length, 0);
  });

  it('sends nothing for the status the task is in already', async () => {
    const { deliver, setStatus, waiting } = await acme();
    // `new` is the built-in status a note starts in.
    await setStatus('own:new');
    assert.deepEqual(await waiting(), []);
    await setStatus('own:progress');
    await setStatus('own:progress');
    assert.equal((await deliver()).length, 1, 'the second choice of the same status sends nothing');
  });

  it('sends one too when the status is written by the store of `/mcp` and the extension', async () => {
    const { store, site, issue, deliver } = await acme();
    const answer = await store.setStatus?.(
      { issue: issue.id, clientId: site },
      { key: null, stage: 'done' },
      undefined,
    );
    assert.equal(typeof answer, 'object');
    const again = await store.setStatus?.({ issue: issue.id, clientId: site }, { key: null, stage: 'done' }, undefined);
    assert.equal(typeof again, 'object');

    const bodies = parsed(await deliver());
    assert.equal(bodies.length, 1);
    assert.deepEqual(
      { status: bodies[0]?.status, stage: bodies[0]?.stage },
      { status: { from: 'own:new', to: 'own:done' }, stage: { from: 'new', to: 'done' } },
    );
  });

  it('sends one for each task a removed status moves to another', async () => {
    const { world, workspace, site, deliver, setStatus } = await acme();
    await world.accounts.putSiteStatus(workspace, site, {
      source: 'own',
      key: 'review',
      stage: 'progress',
      name: 'Review',
      color: null,
      textColor: null,
      position: 0,
      origin: 'team',
      hidden: false,
    });
    await setStatus('own:review');
    assert.equal((await deliver()).length, 1);

    const removed = await world.accounts.removeSiteStatus(workspace, site, { source: 'own', key: 'review' }, 'done');
    assert.equal(removed.removed, true);
    const bodies = parsed(await deliver());
    assert.equal(bodies.length, 1);
    assert.deepEqual(
      { event: bodies[0]?.event, status: bodies[0]?.status, stage: bodies[0]?.stage },
      {
        event: 'note.status_changed',
        status: { from: 'own:review', to: 'own:done' },
        stage: { from: 'progress', to: 'done' },
      },
    );
  });

  it('is tried again with the same body and the same id until it arrives, as `note.created`', async () => {
    const { deliver, setStatus, waiting } = await acme();
    await setStatus('own:todo');
    const failed = await deliver(() => 503);
    assert.equal(failed.length, 1);
    const [late] = await waiting();
    assert.equal(late?.event, 'note.status_changed', 'the console names the event');
    assert.equal(late?.attempts, 1);
    assert.equal(late?.lastStatus, 503);

    // Before the first wait: nothing. After it: the same request, signed again.
    assert.equal((await deliver(undefined, () => LATER_MS + RETRY_AFTER_SECONDS[0] * 1_000 - 1_000)).length, 0);
    const second = await deliver(undefined, () => LATER_MS + RETRY_AFTER_SECONDS[0] * 1_000);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.body, failed[0]?.body);
    assert.equal(second[0]?.headers[DELIVERY_HEADER], failed[0]?.headers[DELIVERY_HEADER]);
    assert.deepEqual(await waiting(), [], 'arrived, and removed');
  });
});

describe('the fields of a task sent to an address (FRU-660)', () => {
  it('sends one `note.updated` that names the fields whose value changed, and no value', async () => {
    const { owner, asOwner, deliver, setTask } = await acme();
    const label = (await (await asOwner('POST', '/labels', { name: 'Billing', color: '#2563eb' })).json()) as {
      label: { id: string };
    };
    await setTask({ assignee: owner.id, priority: 'high', labels: [label.label.id], dueOn: '2026-12-01' });
    const bodies = parsed(await deliver());

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.event, 'note.updated');
    assert.deepEqual(bodies[0]?.fields, ['assignee', 'priority', 'labels', 'dueOn']);
    const text = JSON.stringify(bodies[0]);
    for (const value of [owner.id, 'high', label.label.id, '2026-12-01']) {
      assert.ok(!text.includes(value), `the value ${value} is not sent`);
    }

    // One field of the change is new: only it is named.
    await setTask({ assignee: owner.id, priority: 'low' });
    assert.deepEqual(parsed(await deliver())[0]?.fields, ['priority']);
    // Cleared is a change too.
    await setTask({ dueOn: null });
    assert.deepEqual(parsed(await deliver())[0]?.fields, ['dueOn']);
  });

  it('sends nothing for a change that changes no field, nor for the place or the archive alone', async () => {
    const { owner, asOwner, deliver, setTask, waiting } = await acme();
    const first = (await (await asOwner('POST', '/labels', { name: 'A', color: '#2563eb' })).json()) as {
      label: { id: string };
    };
    const second = (await (await asOwner('POST', '/labels', { name: 'B', color: '#16a34a' })).json()) as {
      label: { id: string };
    };
    await setTask({ assignee: owner.id, labels: [first.label.id, second.label.id] });
    assert.equal((await deliver()).length, 1);

    await setTask({ assignee: owner.id, labels: [second.label.id, first.label.id] });
    await setTask({ priority: null, dueOn: null });
    await setTask({ position: 3 });
    await setTask({ archived: true });
    assert.deepEqual(await waiting(), []);
  });
});

describe('a task with no address (FRU-660)', () => {
  it('sends no event: a note with no destination has no address to tell', async () => {
    const { world, setStatus, setTask, deliver } = await acme({ destination: 'none' });
    await setStatus('own:todo');
    await setTask({ priority: 'high' });

    assert.equal((await deliver()).length, 0);
    assert.deepEqual(await rowsOf(world.database, 'SELECT id FROM deliveries'), []);
  });
});

describe('the fields a change names (FRU-660)', () => {
  const before = { assignee: 'acc_1', priority: 'low', dueOn: null, labels: ['a', 'b'] };

  it('compares the labels as a set, and leaves a field out of the change unchanged', () => {
    assert.deepEqual(changedTaskFields(before, { labels: ['b', 'a'] }), []);
    assert.deepEqual(changedTaskFields(before, { labels: ['a'] }), ['labels']);
    assert.deepEqual(changedTaskFields(before, {}), []);
    assert.deepEqual(changedTaskFields(before, { assignee: null, dueOn: '2026-12-01' }), ['assignee', 'dueOn']);
  });
});

describe('the contract a receiver is written against (FRU-660)', () => {
  const guide = readFileSync(new URL('../../../docs/rest-connector.md', import.meta.url), 'utf8');

  it('names each event and each field `note.updated` can name', () => {
    for (const event of ['note.status_changed', 'note.replied', 'note.updated']) {
      assert.ok(guide.includes(`\`event: "${event}"\``), `the guide does not name ${event}`);
    }
    for (const field of TASK_EVENT_FIELDS)
      assert.ok(guide.includes(`\`${field}\``), `the guide does not name ${field}`);
  });
});
