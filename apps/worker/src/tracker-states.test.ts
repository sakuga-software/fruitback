import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { ClientConfig } from './clients.ts';
import { createMemoryKv } from './kv.ts';
import type { NoteStore, TrackerState } from './store.ts';
import {
  TRACKER_FAILURE_TTL_MS,
  TRACKER_STATES_TTL_MS,
  rememberTrackerStates,
  trackerSourcesOf,
  trackerStatesKey,
} from './tracker-states.ts';

/** The states of the trackers of a site, read again after a while (FRU-368). */

const STATES: TrackerState[] = [{ id: 'state_todo', name: 'Todo', stage: 'todo', color: '#e2e2e2' }];
const CLIENT: ClientConfig = {
  workspace: 'w1',
  connector: 'con_linear',
  teamId: 'team_design',
  destinations: [
    { id: 'p1', connector: 'con_linear', teamId: 'team_design' },
    // The same team twice is one read.
    { id: 'p2', connector: 'con_linear', teamId: 'team_design', projectId: 'project_web' },
    { id: 'p3', connector: 'con_rest' },
  ],
} as ClientConfig;

/** A store that counts its reads of the states, and answers none for an address. */
function counted(answer: () => Promise<TrackerState[]> = async () => STATES) {
  const asked: (string | undefined)[] = [];
  const store = {
    trackerStatesFor: async (client: ClientConfig | undefined) => {
      asked.push(client?.connector);

      return client?.connector === 'con_rest' ? undefined : answer();
    },
  } as unknown as NoteStore;

  return { store, asked };
}

describe('the states of the trackers of a site (FRU-368)', () => {
  it('reads each team once, keeps it, and reads it again once the time has passed', async () => {
    let now = 0;
    const kv = createMemoryKv({ now: () => now });
    const { store, asked } = counted();

    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), [{ source: 'con_linear', states: STATES }]);
    assert.deepEqual(asked, ['con_linear', 'con_rest']);

    now = TRACKER_STATES_TTL_MS - 1;
    await trackerSourcesOf(kv, store, CLIENT);
    assert.deepEqual(asked, ['con_linear', 'con_rest', 'con_rest'], 'kept: Linear is not asked');

    now = TRACKER_STATES_TTL_MS + 1;
    await trackerSourcesOf(kv, store, CLIENT);
    assert.deepEqual(asked, ['con_linear', 'con_rest', 'con_rest', 'con_linear', 'con_rest'], 'read again');
  });

  it('takes what the console just read, and nothing a Kv holds that is not a list of states', async () => {
    const kv = createMemoryKv();
    const { store, asked } = counted();
    const fresh: TrackerState[] = [{ id: 'state_new', name: 'Fresh', stage: 'new' }];
    await rememberTrackerStates(kv, 'con_linear', 'team_design', fresh);

    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), [{ source: 'con_linear', states: fresh }]);
    assert.deepEqual(asked, ['con_rest']);

    await kv.set(trackerStatesKey('con_linear', 'team_design'), JSON.stringify([{ id: 1 }]), 60_000);
    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), [{ source: 'con_linear', states: STATES }]);
  });

  it('keeps what Linear says, and gives a state the exception of its connector at each read', async () => {
    const kv = createMemoryKv();
    const { store, asked } = counted();
    let exceptions: Record<string, 'done'> = {};
    const exceptionsOf = async () => exceptions;

    assert.equal((await trackerSourcesOf(kv, store, CLIENT, exceptionsOf))[0]?.states[0]?.stage, 'todo');
    exceptions = { state_todo: 'done' };
    // From what is kept, with no new read of Linear: the exception is applied after the Kv.
    assert.equal((await trackerSourcesOf(kv, store, CLIENT, exceptionsOf))[0]?.states[0]?.stage, 'done');
    assert.deepEqual(asked, ['con_linear', 'con_rest', 'con_rest']);
    assert.equal(JSON.parse((await kv.get(trackerStatesKey('con_linear', 'team_design'))) ?? '[]')[0].stage, 'todo');
  });

  it('asks a tracker that failed once per window, and takes its states again once it answers (FRU-381)', async () => {
    let now = 0;
    const kv = createMemoryKv({ now: () => now });
    let down = true;
    const { store, asked } = counted(() =>
      down ? Promise.reject(new Error('Linear is down')) : Promise.resolve(STATES),
    );
    const linearAsked = () => asked.filter((each) => each === 'con_linear').length;

    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), []);
    assert.equal(linearAsked(), 1);
    // Every read of the window: the pins keep their stage, and Linear is not asked again.
    now = TRACKER_FAILURE_TTL_MS - 1;
    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), []);
    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), []);
    assert.equal(linearAsked(), 1);

    // After the window Linear is asked again, and its answer is taken as soon as it comes back.
    down = false;
    now = TRACKER_FAILURE_TTL_MS + 1;
    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), [{ source: 'con_linear', states: STATES }]);
    assert.equal(linearAsked(), 2);
  });

  it('leaves out a tracker that does not answer, and keeps nothing of its states', async () => {
    const kv = createMemoryKv();
    const { store } = counted(() => Promise.reject(new Error('Linear is down')));

    assert.deepEqual(await trackerSourcesOf(kv, store, CLIENT), []);
    assert.equal(await kv.get(trackerStatesKey('con_linear', 'team_design')), undefined);
  });

  it('reads nothing for a client with no destination, or a store with no states', async () => {
    const { store, asked } = counted();

    assert.deepEqual(await trackerSourcesOf(createMemoryKv(), store, { workspace: 'w1' } as ClientConfig), []);
    assert.deepEqual(await trackerSourcesOf(createMemoryKv(), {} as NoteStore, CLIENT), []);
    assert.deepEqual(asked, []);
  });
});
