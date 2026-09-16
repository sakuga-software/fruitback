import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type StorageArea,
  GRANT_PREFIX,
  LEGACY_GRANTS_KEY,
  LEGACY_SESSIONS_KEY,
  ENDPOINT_SESSION_PREFIX,
  EPOCH_PREFIX,
  RUN_PREFIX,
  createSessionArea,
  entriesOf,
  stillOpen,
  keyFor,
  moveToRunKeys,
  runKeyFor,
  runOf,
  runsOf,
  splitLegacyRecord,
  upgradeAreas,
  upgradeSessions,
  touchesARefreshToken,
} from './session-storage.ts';
import { type StoredSession, parseAccessGrant, parseStoredSession } from './session.ts';
import { storage } from './session-storage.fixture.ts';

const ENDPOINT = 'https://worker.test';
const IDENTITY = { subject: 'u_1', name: 'Alex' };
const SESSION: StoredSession = { refreshToken: 'refresh.1', identity: IDENTITY, generation: 'gen.1' };

describe('one key per run of an endpoint', () => {
  /**
   * The endpoint is a URL a reviewer typed, and a colon is legal in a path.
   *
   * The endpoint is the rest of the key after the epoch. Splitting on the separator truncates this
   * one, and the entry is then filed under a worker nobody is paired with.
   */
  it('round-trips an endpoint that contains the separator', () => {
    const awkward = 'https://a.test/x:session:y';

    assert.deepEqual(runOf(runKeyFor(awkward, 'epo.1')), {
      key: runKeyFor(awkward, 'epo.1'),
      endpoint: awkward,
      epoch: 'epo.1',
    });
  });

  /** The epoch is minted here and holds no colon today. The key does not depend on that. */
  it('round-trips an epoch that contains the separator, and a session with no epoch', () => {
    assert.partialDeepStrictEqual(runOf(runKeyFor(ENDPOINT, 'a:b')), { endpoint: ENDPOINT, epoch: 'a:b' });
    assert.partialDeepStrictEqual(runOf(runKeyFor(ENDPOINT, undefined)), { endpoint: ENDPOINT, epoch: undefined });
    assert.notEqual(runKeyFor(ENDPOINT, 'epo.1'), runKeyFor(ENDPOINT, 'epo.2'));
  });

  it('reads only session keys, and not the other things the area holds', () => {
    const snapshot = {
      sites: { 'https://site.test': { enabled: true } },
      [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION },
      [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION,
      [runKeyFor(ENDPOINT, undefined)]: SESSION,
      [keyFor(GRANT_PREFIX, ENDPOINT)]: { accessToken: 'a', expiresAt: 1, identity: IDENTITY },
      [`${RUN_PREFIX}%E0%A4%A:${ENDPOINT}`]: SESSION,
    };

    assert.deepEqual(runsOf(snapshot), [
      { key: runKeyFor(ENDPOINT, undefined), endpoint: ENDPOINT, epoch: undefined, session: SESSION },
    ]);
  });

  it('drops an entry that does not parse rather than the whole area', () => {
    const snapshot = {
      [runKeyFor(ENDPOINT, undefined)]: SESSION,
      [runKeyFor('https://broken.test', undefined)]: { identity: IDENTITY },
    };

    assert.deepEqual(
      runsOf(snapshot).map((run) => run.endpoint),
      [ENDPOINT],
    );
  });

  it('drops an entry whose epoch is not the one its key names', () => {
    assert.deepEqual(runsOf({ [runKeyFor(ENDPOINT, 'epo.1')]: { ...SESSION, epoch: 'epo.2' } }), []);
  });

  it('tells a refresh token from every other key the area changes', () => {
    assert.equal(touchesARefreshToken([runKeyFor(ENDPOINT, 'epo.1')]), true);
    assert.equal(touchesARefreshToken(['sites', LEGACY_SESSIONS_KEY, keyFor(EPOCH_PREFIX, ENDPOINT)]), false);
    assert.equal(touchesARefreshToken([keyFor(GRANT_PREFIX, ENDPOINT)]), false);
  });
});

describe('the upgrade from one record to one key per endpoint', () => {
  it('splits the legacy record and then removes it', async () => {
    const other = 'https://other.test';
    const store = storage({
      [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION, [other]: { ...SESSION, refreshToken: 'other.1' } },
    });

    await splitLegacyRecord(store.area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);

    assert.deepEqual(store.read(), {
      [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION,
      [keyFor(ENDPOINT_SESSION_PREFIX, other)]: { ...SESSION, refreshToken: 'other.1' },
    });
    assert.deepEqual(store.log, [
      'get all',
      `set ${keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)},${keyFor(ENDPOINT_SESSION_PREFIX, other)}`,
      `remove ${LEGACY_SESSIONS_KEY}`,
    ]);
  });

  /**
   * The order is the guarantee. A removal that landed first would leave a reviewer with no session
   * at all if the write then failed — and the way back is an operator minting a new pairing code.
   */
  it('keeps the legacy record when the write fails', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const failing: StorageArea = { ...store.area, set: async () => Promise.reject(new Error('quota')) };

    await assert.rejects(splitLegacyRecord(failing, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession));

    assert.deepEqual(store.read(), { [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
  });

  /**
   * The popup and the background both run this at startup.
   *
   * Whichever finishes second must not put an older value back over what the first wrote, or over a
   * refresh that has landed since. An endpoint that already has its own key is already upgraded.
   */
  it('leaves an endpoint that already has its own key alone', async () => {
    const fresher = { ...SESSION, refreshToken: 'refresh.2', generation: 'gen.2' };
    const store = storage({
      [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION },
      [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: fresher,
    });

    await splitLegacyRecord(store.area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);

    assert.deepEqual(store.read(), { [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: fresher });
    assert.deepEqual(store.log, ['get all', `remove ${LEGACY_SESSIONS_KEY}`]);
  });

  /**
   * The popup and the background upgrade independently, over the same storage.
   *
   * `key in snapshot` is what stops the second one writing an older value over a newer one, and it
   * is only ever consulted while the legacy record is still there — so a second upgrade run after
   * the first finished exercises nothing. The first one is held open here, inside its removal, so
   * the second reads a snapshot that carries the legacy record **and** the new key. Raised in
   * review, and the first version of this test passed under every mutation.
   *
   * What it does not cover is a second upgrade whose snapshot was taken before the first wrote.
   * That one writes the legacy value back, and closing it needs ordering `chrome.storage` does not
   * offer. It also needs a network round trip to finish inside one storage round trip, which is why
   * `migrationOf` states it rather than defends it.
   */
  it('does not let a second context put an older value back', async () => {
    const fresher = { ...SESSION, refreshToken: 'refresh.2', generation: 'gen.2' };
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });

    let wrote: () => void = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let removals = 0;
    const area: StorageArea = {
      ...store.area,
      set: async (items) => {
        await store.area.set(items);
        wrote();
      },
      remove: async (key) => {
        removals += 1;
        if (removals === 1) await held;
        await store.area.remove(key);
      },
    };

    const first = splitLegacyRecord(area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);
    await written;
    await store.area.set({ [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: fresher });

    await splitLegacyRecord(area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);
    release();
    await first;

    assert.deepEqual(store.read(), { [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: fresher });
  });

  it('writes nothing and reads nothing twice once the legacy record is gone', async () => {
    const store = storage({ [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION });

    await splitLegacyRecord(store.area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);

    assert.deepEqual(store.log, ['get all']);
  });

  it('removes a legacy record that holds nothing usable', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: { identity: IDENTITY } } });

    await splitLegacyRecord(store.area, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);

    assert.deepEqual(store.read(), {});
    assert.deepEqual(store.log, ['get all', `remove ${LEGACY_SESSIONS_KEY}`]);
  });

  /**
   * `storage.session` is emptied when the browser closes, so its legacy record is usually absent —
   * but an extension updated while the browser stays open still holds one. A grant left under a key
   * nothing reads costs one needless refresh per worker, with nothing anywhere to say why.
   */
  it('upgrades the grants, which the browser usually empties before anybody notices', async () => {
    const grant = { accessToken: 'access.1', expiresAt: 1_700_000_600_000, identity: IDENTITY, generation: 'gen.1' };
    const store = storage({ [LEGACY_GRANTS_KEY]: { [ENDPOINT]: grant } });

    await splitLegacyRecord(store.area, LEGACY_GRANTS_KEY, GRANT_PREFIX, parseAccessGrant);

    assert.deepEqual(store.read(), { [keyFor(GRANT_PREFIX, ENDPOINT)]: grant });
  });
});

describe('the second upgrade, from a key per endpoint to a key per run', () => {
  it('moves each entry to the run its own epoch names, and then removes the old key', async () => {
    const other = 'https://other.test';
    const stamped = { ...SESSION, epoch: 'epo.1' };
    const store = storage({
      [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION,
      [keyFor(ENDPOINT_SESSION_PREFIX, other)]: stamped,
    });

    await moveToRunKeys(store.area);

    assert.deepEqual(store.read(), {
      [runKeyFor(ENDPOINT, undefined)]: SESSION,
      [runKeyFor(other, 'epo.1')]: stamped,
    });
    assert.deepEqual(store.log, [
      'get all',
      `set ${runKeyFor(ENDPOINT, undefined)},${runKeyFor(other, 'epo.1')}`,
      `remove ${keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)}`,
      `remove ${keyFor(ENDPOINT_SESSION_PREFIX, other)}`,
    ]);
  });

  /** The same guarantee as the first upgrade: a failed write leaves the credentials where they were. */
  it('keeps the old key when the write fails', async () => {
    const store = storage({ [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION });
    const failing: StorageArea = { ...store.area, set: async () => Promise.reject(new Error('quota')) };

    await assert.rejects(moveToRunKeys(failing));

    assert.deepEqual(store.read(), { [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION });
  });

  /** The other context upgraded first, and a refresh has written the run since. */
  it('leaves a run that already has its key alone', async () => {
    const fresher = { ...SESSION, refreshToken: 'refresh.2', generation: 'gen.2' };
    const store = storage({
      [keyFor(ENDPOINT_SESSION_PREFIX, ENDPOINT)]: SESSION,
      [runKeyFor(ENDPOINT, undefined)]: fresher,
    });

    await moveToRunKeys(store.area);

    assert.deepEqual(store.read(), { [runKeyFor(ENDPOINT, undefined)]: fresher });
  });

  it('writes nothing once there is no old key', async () => {
    const store = storage({ [runKeyFor(ENDPOINT, undefined)]: SESSION });

    await moveToRunKeys(store.area);

    assert.deepEqual(store.log, ['get all']);
  });

  it('takes the legacy record all the way to a key per run', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });

    await upgradeSessions(store.area);

    assert.deepEqual(store.read(), { [runKeyFor(ENDPOINT, undefined)]: SESSION });
  });
});

describe('an area waits for its own upgrade', () => {
  /**
   * The defect SKG-602 is named after, on the one run where it is reachable.
   *
   * A reviewer logs out while the upgrade is still in flight. Without the wait, the drop removes a
   * key that is not written yet and the upgrade then writes the session back from the legacy record
   * it read before — a logout that does not stick, over a credential that is still live on the
   * worker.
   */
  it('does not let a logout land before the legacy record is split', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const ready = upgradeSessions(store.area);
    const sessions = createSessionArea(() => store.area, ready);

    await Promise.all([sessions.drop(ENDPOINT), ready]);

    assert.deepEqual(store.read(), {});
    assert.deepEqual(await sessions.read(), {});
  });

  it('writes and reads one run at a time, by its own key', async () => {
    const store = storage();
    const sessions = createSessionArea(() => store.area, Promise.resolve());

    await sessions.put(ENDPOINT, SESSION);

    assert.deepEqual(store.read(), { [runKeyFor(ENDPOINT, undefined)]: SESSION });
    assert.deepEqual(await sessions.read(), { [ENDPOINT]: SESSION });
    assert.deepEqual(store.log, [`set ${runKeyFor(ENDPOINT, undefined)}`, 'get all', 'get all']);
  });

  /**
   * A refresh that lands while the upgrade is in flight must not be undone by it.
   *
   * The upgrade holds a snapshot taken before the write, so its "this endpoint has no key yet" test
   * is answered from stale storage and it writes the legacy value back. That value is a **spent**
   * refresh token under rotation (SKG-600): the next refresh presents it, the worker reads a replay,
   * and the whole chain is revoked.
   */
  it('does not let a refresh land before the legacy record is split', async () => {
    const fresher = { ...SESSION, refreshToken: 'refresh.2', generation: 'gen.2' };
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const ready = upgradeSessions(store.area);
    const sessions = createSessionArea(() => store.area, ready);

    await Promise.all([sessions.put(ENDPOINT, fresher), ready]);

    assert.deepEqual(store.read(), { [runKeyFor(ENDPOINT, undefined)]: fresher });
  });

  /**
   * A read during the upgrade must not answer that the reviewer is paired with nobody.
   *
   * Both contexts run the upgrade at startup, and the background asks for the endpoints straight
   * afterwards. An empty answer there is a refresh skipped for every worker, silently.
   */
  it('answers with the sessions the legacy record held, upgrade or not', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const ready = upgradeSessions(store.area);
    const sessions = createSessionArea(() => store.area, ready);

    const [entries] = await Promise.all([sessions.read(), ready]);

    assert.deepEqual(entries, { [ENDPOINT]: SESSION });
  });
});

describe('an upgrade that could not run', () => {
  /**
   * The gate stays shut, and every operation says so.
   *
   * Releasing it on a failure would be the quiet half of the same fact: a read answers that the
   * reviewer is paired with nobody while a live credential sits under the legacy key, and a logout
   * removes a key that was never written. A rejection is the loud half, and the next time the
   * context starts it tries again.
   */
  it('refuses to answer rather than answering that there is no session', async () => {
    const store = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const broken: StorageArea = { ...store.area, get: async () => Promise.reject(new Error('unreadable')) };
    const ready = upgradeAreas(broken, storage().area);
    const sessions = createSessionArea(() => broken, ready);

    await assert.rejects(ready);
    await assert.rejects(sessions.read());
    await assert.rejects(sessions.drop(ENDPOINT));
    assert.deepEqual(store.read(), { [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
  });

  it('upgrades both areas, and the grants area is not the one that survives a restart', async () => {
    const grant = { accessToken: 'access.1', expiresAt: 1_700_000_600_000, identity: IDENTITY, generation: 'gen.1' };
    const local = storage({ [LEGACY_SESSIONS_KEY]: { [ENDPOINT]: SESSION } });
    const session = storage({ [LEGACY_GRANTS_KEY]: { [ENDPOINT]: grant } });

    await upgradeAreas(local.area, session.area);

    assert.deepEqual(local.read(), { [runKeyFor(ENDPOINT, undefined)]: SESSION });
    assert.deepEqual(session.read(), { [keyFor(GRANT_PREFIX, ENDPOINT)]: grant });
  });
});

describe('the storage the tests run against', () => {
  /**
   * The fixture is a fake of `chrome.storage`, and a fake that answers more than the real thing
   * validates whatever is written against it next. Nothing reads by key today; this is what a reader
   * that starts to would land on.
   */
  it('answers a keyed read with that key and nothing else', async () => {
    const held = storage({ [runKeyFor(ENDPOINT, undefined)]: SESSION, sites: {} });

    assert.deepEqual(await held.area.get(runKeyFor(ENDPOINT, undefined)), {
      [runKeyFor(ENDPOINT, undefined)]: SESSION,
    });
    assert.deepEqual(await held.area.get('nothing is under this'), {});
    assert.deepEqual(Object.keys((await held.area.get(null)) as Record<string, unknown>).sort(), [
      runKeyFor(ENDPOINT, undefined),
      'sites',
    ]);
  });
});

describe('the epoch that ends a run of a session', () => {
  const OTHER = 'https://other.test';

  function run(endpoint: string, session: StoredSession) {
    return { key: runKeyFor(endpoint, session.epoch), endpoint, epoch: session.epoch, session };
  }

  it('keeps an entry stamped with the epoch storage holds', () => {
    const open = { ...SESSION, epoch: 'epo.1' };

    assert.deepEqual(stillOpen([run(ENDPOINT, open)], { [ENDPOINT]: 'epo.1' }), { [ENDPOINT]: open });
  });

  /**
   * The logout minted `epo.2` before it cleared, so the refresh that wrote this one back was reading
   * storage from before it. Nothing could refuse the write; this is what refuses the entry.
   */
  it('refuses an entry stamped with the run before', () => {
    assert.deepEqual(stillOpen([run(ENDPOINT, { ...SESSION, epoch: 'epo.1' })], { [ENDPOINT]: 'epo.2' }), {});
  });

  /** The first logout on an endpoint whose session was stored before this marker existed. */
  it('refuses an entry with no stamp once the endpoint has an epoch', () => {
    assert.deepEqual(stillOpen([run(ENDPOINT, SESSION)], { [ENDPOINT]: 'epo.1' }), {});
  });

  /**
   * Absent on both sides compares equal, the same rule `matches` follows for the generation: an
   * upgrade keeps the session a reviewer already had rather than signing them out.
   */
  it('keeps an entry with no stamp on an endpoint with no epoch', () => {
    assert.deepEqual(stillOpen([run(ENDPOINT, SESSION)], {}), { [ENDPOINT]: SESSION });
  });

  it('reads each endpoint against its own epoch', () => {
    const open = { ...SESSION, epoch: 'epo.1' };
    const runs = [run(ENDPOINT, open), run(OTHER, { ...SESSION, epoch: 'epo.1' })];

    assert.deepEqual(stillOpen(runs, { [ENDPOINT]: 'epo.1', [OTHER]: 'epo.2' }), { [ENDPOINT]: open });
  });

  /** Two runs of one endpoint in storage: the one that is over does not hide the one that is open. */
  it('answers with the open run beside one that is over', () => {
    const open = { ...SESSION, refreshToken: 'refresh.9', epoch: 'epo.3' };
    const runs = [run(ENDPOINT, open), run(ENDPOINT, { ...SESSION, epoch: 'epo.1' })];

    assert.deepEqual(stillOpen(runs, { [ENDPOINT]: 'epo.3' }), { [ENDPOINT]: open });
  });

  /**
   * **One snapshot, so nothing can land between the two halves of the comparison.** Two reads would
   * be a window of their own: a logout between them writes the epoch this then compares against a
   * session it read before the logout, or the other way round.
   */
  it('reads a session and its epoch from one round trip', async () => {
    const held = storage({
      [runKeyFor(ENDPOINT, 'epo.1')]: { ...SESSION, epoch: 'epo.1' },
      [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.1',
    });
    const area = createSessionArea(() => held.area, Promise.resolve());

    assert.deepEqual(await area.read(), { [ENDPOINT]: { ...SESSION, epoch: 'epo.1' } });
    assert.deepEqual(held.log, ['get all']);
  });

  it('does not answer with a session the epoch beside it has ended', async () => {
    const held = storage({
      [runKeyFor(ENDPOINT, 'epo.1')]: { ...SESSION, epoch: 'epo.1' },
      [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.2',
    });
    const area = createSessionArea(() => held.area, Promise.resolve());

    assert.deepEqual(await area.read(), {});
  });

  it('waits for the upgrade before it answers, like every other area', async () => {
    let split = (): void => {};
    const ready = new Promise<void>((resolve) => {
      split = resolve;
    });
    const held = storage({ [runKeyFor(ENDPOINT, undefined)]: SESSION });
    const area = createSessionArea(() => held.area, ready);

    const reading = area.read();
    assert.deepEqual(held.log, []);

    split();
    assert.deepEqual(await reading, { [ENDPOINT]: SESSION });
  });
});

describe('what the sessions area removes (SKG-604)', () => {
  const OTHER = 'https://other.test';
  const OVER = { ...SESSION, refreshToken: 'refresh.1', epoch: 'epo.1' };
  const OPEN = { ...SESSION, refreshToken: 'refresh.9', epoch: 'epo.3' };

  /**
   * A write removes the runs of its endpoint that its snapshot says are over. Nothing else reads
   * those keys again, and each holds a refresh token.
   */
  it('removes the runs that are over after a write, and nothing else', async () => {
    const elsewhere = { ...SESSION, epoch: 'epo.1' };
    const held = storage({
      [runKeyFor(ENDPOINT, 'epo.1')]: OVER,
      [runKeyFor(OTHER, 'epo.1')]: elsewhere,
      [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.3',
      [keyFor(EPOCH_PREFIX, OTHER)]: 'epo.1',
    });
    const area = createSessionArea(() => held.area, Promise.resolve());

    await area.put(ENDPOINT, OPEN);

    assert.deepEqual(held.read(), {
      [runKeyFor(ENDPOINT, 'epo.3')]: OPEN,
      [runKeyFor(OTHER, 'epo.1')]: elsewhere,
      [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.3',
      [keyFor(EPOCH_PREFIX, OTHER)]: 'epo.1',
    });
  });

  /**
   * The write that lost the race: it writes a run that is over, beside the run that is open. The
   * open run stays, and the write removes its own key.
   */
  it('removes its own key when the run it writes is over, and keeps the open one', async () => {
    const held = storage({ [runKeyFor(ENDPOINT, 'epo.3')]: OPEN, [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.3' });
    const area = createSessionArea(() => held.area, Promise.resolve());

    await area.put(ENDPOINT, OVER);

    assert.deepEqual(held.read(), { [runKeyFor(ENDPOINT, 'epo.3')]: OPEN, [keyFor(EPOCH_PREFIX, ENDPOINT)]: 'epo.3' });
  });

  it('drops every run of one endpoint on a logout, and the other endpoints keep theirs', async () => {
    const elsewhere = { ...SESSION, epoch: 'epo.1' };
    const held = storage({
      [runKeyFor(ENDPOINT, 'epo.1')]: OVER,
      [runKeyFor(ENDPOINT, 'epo.3')]: OPEN,
      [runKeyFor(OTHER, 'epo.1')]: elsewhere,
    });
    const area = createSessionArea(() => held.area, Promise.resolve());

    await area.drop(ENDPOINT);

    assert.deepEqual(held.read(), { [runKeyFor(OTHER, 'epo.1')]: elsewhere });
  });

  /** A refused refresh ends the run it spent. A rotation written since is not that session. */
  it('ends a run only while it holds the token that was spent', async () => {
    const rotated = { ...OVER, refreshToken: 'refresh.2' };
    const held = storage({ [runKeyFor(ENDPOINT, 'epo.1')]: rotated, [runKeyFor(ENDPOINT, 'epo.3')]: OPEN });
    const area = createSessionArea(() => held.area, Promise.resolve());

    await area.end(ENDPOINT, OVER);
    assert.deepEqual(held.read(), { [runKeyFor(ENDPOINT, 'epo.1')]: rotated, [runKeyFor(ENDPOINT, 'epo.3')]: OPEN });

    await area.end(ENDPOINT, rotated);
    assert.deepEqual(held.read(), { [runKeyFor(ENDPOINT, 'epo.3')]: OPEN });
  });
});
