import assert from 'node:assert/strict';
import type { Account, AccountStore, Workspace } from './accounts.ts';
import { type Declare, pause } from './conformance.fixture.ts';
import { StoreError } from './store.ts';

/**
 * What every `AccountStore` promises, whatever holds the accounts (FRU-140).
 *
 * `account-conformance.test.ts` runs these cases on each implementation, and on stores that break one
 * rule each. A case reads the store through its interface only: what is true of one file format
 * stays in `accounts.test.ts`.
 */

const ALICE = { provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' } as const;
const BOB = { provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' } as const;

async function world(store: AccountStore): Promise<{ alice: Account; workspace: Workspace }> {
  const alice = await store.signIn(ALICE);

  return { alice, workspace: await store.createWorkspace('Acme', alice.id) };
}

/** A second workspace, of another person. */
async function otherWorld(store: AccountStore): Promise<{ bob: Account; workspace: Workspace }> {
  const bob = await store.signIn(BOB);

  return { bob, workspace: await store.createWorkspace('Globex', bob.id) };
}

const iso = (time: number) => new Date(time).toISOString();

export function accountCases(it: Declare<AccountStore>): void {
  // --- People

  it('makes one account of two providers that prove the same address', async (store) => {
    const byLink = await store.signIn(ALICE);
    const byGitHub = await store.signIn({
      provider: 'github',
      subject: '4242',
      email: 'Alice@Acme.dev',
      name: 'Alice',
    });
    const again = await store.signIn({ provider: 'github', subject: '4242', email: 'alice@acme.dev' });

    assert.equal(byGitHub.id, byLink.id);
    assert.equal(again.id, byLink.id);
    assert.equal(byGitHub.name, 'Alice', 'a name the first sign-in did not have is kept');
    assert.deepEqual(again, { id: byLink.id, email: 'alice@acme.dev', name: 'Alice' });
  });

  it('keeps two addresses apart', async (store) => {
    const alice = await store.signIn(ALICE);
    const bob = await store.signIn(BOB);

    assert.notEqual(alice.id, bob.id);
    assert.equal(bob.email, 'bob@acme.dev');
  });

  it('makes one account of two sign-ins of one address at the same moment', async (store) => {
    const [byLink, byGitHub] = await Promise.all([
      store.signIn(ALICE),
      store.signIn({ provider: 'github', subject: '4242', email: 'alice@acme.dev' }),
    ]);
    const [once, twice] = await Promise.all([store.signIn(BOB), store.signIn(BOB)]);

    assert.equal(byGitHub.id, byLink.id);
    assert.equal(twice.id, once.id);
    assert.equal((await store.signIn(ALICE)).id, byLink.id);
  });

  it('refuses a sign-in whose address is not an address', async (store) => {
    await assert.rejects(store.signIn({ provider: 'github', subject: '4242', email: 'alice' }), StoreError);
  });

  it('answers the account of an id, and nothing for an id nobody has', async (store) => {
    const alice = await store.signIn({ ...ALICE, name: 'Alice' });

    assert.deepEqual(await store.account(alice.id), { id: alice.id, email: 'alice@acme.dev', name: 'Alice' });
    assert.equal(await store.account('acc_nobody'), undefined);
  });

  it('keeps the language of the first sign-in until the person chooses another', async (store) => {
    const first = await store.signIn({ ...ALICE, locale: 'fr-FR' });
    const borrowed = await store.signIn({ ...ALICE, locale: 'en-US' });

    assert.equal(first.locale, 'fr-FR');
    assert.equal(borrowed.locale, 'fr-FR', 'a sign-in from another browser changed the language');
    assert.equal(await store.localeOf(' Alice@Acme.dev '), 'fr-FR');
    assert.equal(await store.localeOf('nobody@acme.dev'), undefined);

    await store.setLocale(first.id, 'de');
    assert.equal((await store.account(first.id))?.locale, 'de');
    assert.equal((await store.signIn({ ...ALICE, locale: 'en-US' })).locale, 'de');

    // Nobody chose any more: the next sign-in gives its language, as the first one did.
    await store.setLocale(first.id, undefined);
    assert.equal(await store.localeOf('alice@acme.dev'), undefined);
    assert.equal((await store.signIn({ ...ALICE, locale: 'en-US' })).locale, 'en-US');
  });

  it('gives each thing an id whose prefix says what it names', async (store) => {
    const { alice, workspace } = await world(store);
    const site = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'members' });
    const connector = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const delivery = await store.enqueueDelivery(connector.id, '{}', 0);

    // These ids are in the tokens and in the notes already written: another shape orphans them.
    const shapes = { acc: alice.id, ws: workspace.id, site: site.id, con: connector.id, dlv: delivery };
    for (const [prefix, id] of Object.entries(shapes)) assert.match(id, new RegExp(`^${prefix}_[0-9a-f]{20}$`));
  });

  // --- Workspaces

  it('makes the creator the owner, and gives nobody else a role', async (store) => {
    const alice = await store.signIn(ALICE);
    const bob = await store.signIn(BOB);

    const workspace = await store.createWorkspace('  Sakuga ', alice.id);

    assert.equal(workspace.name, 'Sakuga');
    assert.equal(await store.role(workspace.id, alice.id), 'owner');
    assert.equal(await store.role(workspace.id, bob.id), undefined);
    assert.deepEqual(await store.memberships(alice.id), [{ workspace, role: 'owner' }]);
    assert.deepEqual(await store.memberships(bob.id), []);
  });

  it('lists the workspaces of an account oldest first', async (store) => {
    const alice = await store.signIn(ALICE);
    const names = ['First', 'Second', 'Third'];
    for (const name of names) {
      await store.createWorkspace(name, alice.id);
      await pause();
    }

    assert.deepEqual(
      (await store.memberships(alice.id)).map((membership) => membership.workspace.name),
      names,
    );
  });

  it('removes the members, the sites, the connectors and the deliveries of a workspace it deletes, and only those', async (store) => {
    const alice = await store.signIn(ALICE);
    const gone = await store.createWorkspace('Gone', alice.id);
    const kept = await store.createWorkspace('Kept', alice.id);
    await store.addSite(gone.id, { origin: 'https://gone.dev', visibility: 'members' });
    const site = await store.addSite(kept.id, { origin: 'https://kept.dev', visibility: 'members' });
    const lost = await store.addConnector(gone.id, { kind: 'rest', label: 'Gone hook', sealed: 'sealed-gone' });
    const held = await store.addConnector(kept.id, { kind: 'rest', label: 'Kept hook', sealed: 'sealed-kept' });
    await store.enqueueDelivery(lost.id, '{"n":1}', 0);
    const due = await store.enqueueDelivery(held.id, '{"n":2}', 0);

    await store.deleteWorkspace(gone.id);

    assert.deepEqual(await store.memberships(alice.id), [{ workspace: kept, role: 'owner' }]);
    assert.equal(await store.role(gone.id, alice.id), undefined);
    assert.deepEqual(await store.sites(gone.id), []);
    assert.deepEqual(Object.keys(await store.clientMap()), [site.id]);
    assert.deepEqual(await store.connectors(gone.id), []);
    assert.equal(await store.sealedKey(lost.id), undefined);
    assert.deepEqual(
      (await store.dueDeliveries(10, 10)).map((delivery) => delivery.id),
      [due],
    );
  });

  // --- Sites

  it('adds a site once, whatever was pasted twice, and serves it as a client of its workspace', async (store) => {
    const { workspace } = await world(store);

    const first = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'members' });
    const second = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'everyone' });

    assert.equal(second.id, first.id);
    assert.deepEqual(first, {
      id: first.id,
      workspaceId: workspace.id,
      origin: 'https://acme.dev',
      visibility: 'members',
    });
    assert.deepEqual(await store.sites(workspace.id), [{ ...first, visibility: 'everyone' }]);
    assert.deepEqual(await store.clientMap(), {
      [first.id]: { workspace: workspace.id, origins: ['https://acme.dev'], read: 'public' },
    });
  });

  it('keeps one address apart in two workspaces', async (store) => {
    const { workspace: acme } = await world(store);
    const { workspace: globex } = await otherWorld(store);

    const ours = await store.addSite(acme.id, { origin: 'https://shared.dev', visibility: 'members' });
    const theirs = await store.addSite(globex.id, { origin: 'https://shared.dev', visibility: 'everyone' });

    assert.notEqual(theirs.id, ours.id);
    assert.deepEqual(await store.sites(acme.id), [ours]);
    assert.deepEqual(await store.sites(globex.id), [theirs]);
    assert.deepEqual(await store.clientMap(), {
      [ours.id]: { workspace: acme.id, origins: ['https://shared.dev'], read: 'authenticated' },
      [theirs.id]: { workspace: globex.id, origins: ['https://shared.dev'], read: 'public' },
    });
  });

  it('lists the sites and the connectors of a workspace oldest first', async (store) => {
    const { workspace } = await world(store);
    const origins = ['https://one.dev', 'https://two.dev', 'https://three.dev'];
    for (const origin of origins) {
      await store.addSite(workspace.id, { origin, visibility: 'members' });
      await store.addConnector(workspace.id, { kind: 'rest', label: origin, sealed: 'sealed' });
      await pause();
    }

    assert.deepEqual(
      (await store.sites(workspace.id)).map((site) => site.origin),
      origins,
    );
    assert.deepEqual(
      (await store.connectors(workspace.id)).map((connector) => connector.label),
      origins,
    );
  });

  it('removes a site only from its own workspace', async (store) => {
    const { workspace: a } = await world(store);
    const { workspace: b } = await otherWorld(store);
    const site = await store.addSite(a.id, { origin: 'https://a.dev', visibility: 'members' });

    assert.equal(await store.removeSite(b.id, site.id), false);
    assert.deepEqual(await store.sites(a.id), [site]);
    assert.equal(await store.removeSite(a.id, site.id), true);
    assert.deepEqual(await store.sites(a.id), []);
    assert.equal(await store.removeSite(a.id, site.id), false);
  });

  it('answers an empty client map before a site exists, never no map', async (store) => {
    await world(store);

    // `undefined` would make it a single-client worker, which answers every page to anybody.
    assert.deepEqual(await store.clientMap(), {});
  });

  // --- Connectors

  it('keeps what a connector seals for the worker, and never lists it', async (store) => {
    const { workspace } = await world(store);

    const connector = await store.addConnector(workspace.id, { kind: 'linear', label: 'Linear', sealed: 'sealed-1' });

    assert.deepEqual(Object.keys(connector).sort(), ['createdAt', 'id', 'kind', 'label', 'workspaceId']);
    assert.deepEqual(await store.connectors(workspace.id), [connector]);
    assert.deepEqual(await store.sealedKey(connector.id), {
      kind: 'linear',
      sealed: 'sealed-1',
      workspaceId: workspace.id,
    });
    assert.equal(await store.sealedKey('con_nobody'), undefined);

    await store.resealConnector(connector.id, 'sealed-2');
    assert.equal((await store.sealedKey(connector.id))?.sealed, 'sealed-2');
  });

  it('removes a connector only from its own workspace, and its sites keep their notes in the worker again', async (store) => {
    const { workspace: acme } = await world(store);
    const { workspace: globex } = await otherWorld(store);
    const connector = await store.addConnector(acme.id, { kind: 'linear', label: 'Linear', sealed: 'sealed' });
    const site = await store.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'members' });
    assert.equal(await store.setDestination(acme.id, site.id, { connector: connector.id, teamId: 'team_1' }), true);
    await store.enqueueDelivery(connector.id, '{}', 0);

    assert.equal(await store.removeConnector(globex.id, connector.id), false);
    assert.equal((await store.sites(acme.id))[0]?.destination?.connector, connector.id);

    assert.equal(await store.removeConnector(acme.id, connector.id), true);
    assert.deepEqual(await store.connectors(acme.id), []);
    assert.deepEqual(await store.sites(acme.id), [site]);
    assert.deepEqual(await store.clientMap(), {
      [site.id]: { workspace: acme.id, origins: ['https://acme.dev'], read: 'authenticated' },
    });
    assert.deepEqual(await store.dueDeliveries(10, 10), []);
  });

  it('never lets a site write through the connector of another workspace', async (store) => {
    const { workspace: acme } = await world(store);
    const { workspace: globex } = await otherWorld(store);
    const site = await store.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'members' });
    const ours = await store.addConnector(acme.id, { kind: 'linear', label: 'Ours', sealed: 'sealed-ours' });
    const theirs = await store.addConnector(globex.id, { kind: 'linear', label: 'Theirs', sealed: 'sealed-theirs' });

    assert.equal(await store.setDestination(acme.id, site.id, { connector: theirs.id, teamId: 'team_1' }), false);
    assert.equal(await store.setDestination(globex.id, site.id, { connector: theirs.id, teamId: 'team_1' }), false);
    assert.equal(await store.setDestination(acme.id, site.id, { connector: 'con_nobody', teamId: 'team_1' }), false);
    assert.deepEqual(await store.sites(acme.id), [site]);

    const destination = { connector: ours.id, teamId: 'team_1', projectId: 'project_1' };
    assert.equal(await store.setDestination(acme.id, site.id, destination), true);
    assert.deepEqual(await store.sites(acme.id), [{ ...site, destination }]);
    assert.deepEqual(await store.clientMap(), {
      [site.id]: {
        workspace: acme.id,
        origins: ['https://acme.dev'],
        read: 'authenticated',
        connector: ours.id,
        teamId: 'team_1',
        projectId: 'project_1',
      },
    });

    assert.equal(await store.setDestination(globex.id, site.id, undefined), false);
    assert.deepEqual(await store.sites(acme.id), [{ ...site, destination }]);
    assert.equal(await store.setDestination(acme.id, site.id, undefined), true);
    assert.deepEqual(await store.sites(acme.id), [site]);
  });

  it('keeps a destination with no team, for an address that only receives', async (store) => {
    const { workspace } = await world(store);
    const site = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'members' });
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });

    assert.equal(await store.setDestination(workspace.id, site.id, { connector: hook.id }), true);

    assert.deepEqual(await store.sites(workspace.id), [{ ...site, destination: { connector: hook.id } }]);
  });

  it('keeps the first moment of a refusal, and forgets it at the first call that works', async (store) => {
    const { workspace } = await world(store);
    const { id } = await store.addConnector(workspace.id, { kind: 'linear', label: 'Linear', sealed: 'sealed' });
    const attention = async () => (await store.connectors(workspace.id))[0]?.attention;
    const at = (hour: number) => Date.UTC(2026, 9, 10, hour);

    assert.equal(await attention(), undefined);

    await store.noteConnector(id, 'key-refused', at(8));
    await store.noteConnector(id, 'key-refused', at(9));
    assert.deepEqual(await attention(), { reason: 'key-refused', since: iso(at(8)) });

    await store.noteConnector(id, 'key-lacks-access', at(10));
    assert.deepEqual(await attention(), { reason: 'key-lacks-access', since: iso(at(10)) });

    await store.noteConnector(id, undefined, at(11));
    assert.equal(await attention(), undefined);

    // A connector that is gone is ignored: the note of a call must never fail the call.
    await store.noteConnector('con_nobody', 'key-refused', at(12));
  });

  // --- Deliveries

  it('gives the deliveries that are due, oldest first, up to the limit', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const second = await store.enqueueDelivery(hook.id, '{"n":2}', 200);
    const first = await store.enqueueDelivery(hook.id, '{"n":1}', 100);
    await store.enqueueDelivery(hook.id, '{"n":3}', 300);

    assert.deepEqual(await store.dueDeliveries(99, 10), []);
    assert.deepEqual(await store.dueDeliveries(200, 10), [
      { id: first, connectorId: hook.id, body: '{"n":1}', attempts: 0 },
      { id: second, connectorId: hook.id, body: '{"n":2}', attempts: 0 },
    ]);
    assert.deepEqual(
      (await store.dueDeliveries(300, 1)).map((delivery) => delivery.id),
      [first],
    );
  });

  it('removes a delivery that arrived, and no other', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const arrived = await store.enqueueDelivery(hook.id, '{"n":1}', 0);
    const late = await store.enqueueDelivery(hook.id, '{"n":2}', 1);

    await store.settleDelivery(arrived, { delivered: true });

    assert.deepEqual(
      (await store.dueDeliveries(10, 10)).map((delivery) => delivery.id),
      [late],
    );
    assert.deepEqual(
      (await store.deliveries(workspace.id, hook.id)).map((delivery) => delivery.id),
      [late],
    );
  });

  it('writes what a failed attempt answered, and gives up when no other attempt is set', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const id = await store.enqueueDelivery(hook.id, '{"n":1}', 1_000);
    const [pending] = await store.deliveries(workspace.id, hook.id);
    assert.deepEqual(pending, { id, createdAt: iso(1_000), attempts: 0, nextAt: iso(1_000) });

    await store.settleDelivery(id, { delivered: false, attempts: 0, at: 2_000, status: 503, nextAt: 60_000 });

    assert.deepEqual(await store.dueDeliveries(59_999, 10), []);
    assert.deepEqual(await store.dueDeliveries(60_000, 10), [
      { id, connectorId: hook.id, body: '{"n":1}', attempts: 1 },
    ]);
    assert.deepEqual(await store.deliveries(workspace.id, hook.id), [
      { id, createdAt: iso(1_000), attempts: 1, nextAt: iso(60_000), lastStatus: 503 },
    ]);

    await store.settleDelivery(id, { delivered: false, attempts: 1, at: 61_000, error: 'timeout' });

    assert.deepEqual(await store.dueDeliveries(Number.MAX_SAFE_INTEGER, 10), []);
    // The status of the attempt before is gone: the last attempt had no answer to give one.
    assert.deepEqual(await store.deliveries(workspace.id, hook.id), [
      { id, createdAt: iso(1_000), attempts: 2, lastError: 'timeout' },
    ]);
  });

  it('never writes a failure over a new attempt that somebody asked for', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const id = await store.enqueueDelivery(hook.id, '{"n":1}', 0);
    await store.settleDelivery(id, { delivered: false, attempts: 0, at: 1_000, status: 500, nextAt: 2_000 });

    // An attempt starts from a count of one. Before it answers, somebody asks for a new attempt.
    assert.equal(await store.retryDelivery(workspace.id, hook.id, id, 3_000), true);
    await store.settleDelivery(id, { delivered: false, attempts: 1, at: 4_000, status: 500 });

    assert.deepEqual(await store.dueDeliveries(3_000, 10), [
      { id, connectorId: hook.id, body: '{"n":1}', attempts: 0 },
    ]);
  });

  it('counts one failure when two attempts of one delivery answer at the same moment', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const id = await store.enqueueDelivery(hook.id, '{"n":1}', 0);
    const failure = { delivered: false, attempts: 0, at: 1_000, status: 500, nextAt: 2_000 } as const;

    await Promise.all([store.settleDelivery(id, failure), store.settleDelivery(id, failure)]);

    assert.equal((await store.dueDeliveries(2_000, 10))[0]?.attempts, 1);
  });

  it('starts the attempts again only for a delivery of this workspace and of this connector', async (store) => {
    const { workspace: acme } = await world(store);
    const { workspace: globex } = await otherWorld(store);
    const hook = await store.addConnector(acme.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const other = await store.addConnector(acme.id, { kind: 'rest', label: 'Other', sealed: 'sealed' });
    const theirs = await store.addConnector(globex.id, { kind: 'rest', label: 'Theirs', sealed: 'sealed' });
    const id = await store.enqueueDelivery(hook.id, '{"n":1}', 0);
    await store.settleDelivery(id, { delivered: false, attempts: 0, at: 1_000, status: 500 });

    assert.equal(await store.retryDelivery(globex.id, hook.id, id, 2_000), false);
    assert.equal(await store.retryDelivery(globex.id, theirs.id, id, 2_000), false);
    assert.equal(await store.retryDelivery(acme.id, other.id, id, 2_000), false);
    assert.deepEqual(await store.dueDeliveries(Number.MAX_SAFE_INTEGER, 10), []);

    assert.equal(await store.retryDelivery(acme.id, hook.id, id, 2_000), true);
    assert.deepEqual(await store.dueDeliveries(1_999, 10), []);
    // The whole series again, and not one attempt that gives up at its first failure.
    assert.deepEqual(await store.dueDeliveries(2_000, 10), [
      { id, connectorId: hook.id, body: '{"n":1}', attempts: 0 },
    ]);
  });

  it('lists the deliveries of a connector newest first, without their body, to its workspace only', async (store) => {
    const { workspace: acme } = await world(store);
    const { workspace: globex } = await otherWorld(store);
    const hook = await store.addConnector(acme.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const other = await store.addConnector(acme.id, { kind: 'rest', label: 'Other', sealed: 'sealed' });
    const older = await store.enqueueDelivery(hook.id, '{"note":"a secret"}', 1_000);
    const newer = await store.enqueueDelivery(hook.id, '{"note":"another"}', 2_000);
    await store.enqueueDelivery(other.id, '{}', 3_000);

    const listed = await store.deliveries(acme.id, hook.id);

    assert.deepEqual(
      listed.map((delivery) => delivery.id),
      [newer, older],
    );
    assert.equal(JSON.stringify(listed).includes('secret'), false, 'the body holds a note');
    assert.deepEqual(await store.deliveries(globex.id, hook.id), []);
  });

  it('drops the deliveries that were given up before a moment, and keeps the ones still to send', async (store) => {
    const { workspace } = await world(store);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed' });
    const old = await store.enqueueDelivery(hook.id, '{"n":1}', 0);
    const recent = await store.enqueueDelivery(hook.id, '{"n":2}', 0);
    const pending = await store.enqueueDelivery(hook.id, '{"n":3}', 0);
    await store.settleDelivery(old, { delivered: false, attempts: 0, at: 1_000, status: 500 });
    await store.settleDelivery(recent, { delivered: false, attempts: 0, at: 5_000, status: 500 });

    assert.equal(await store.dropAbandonedDeliveries(5_000), 1);

    assert.deepEqual(
      (await store.deliveries(workspace.id, hook.id)).map((delivery) => delivery.id).sort(),
      [recent, pending].sort(),
    );
    assert.equal(await store.dropAbandonedDeliveries(5_000), 0);
  });

  // --- Sign-in links

  it('spends a sign-in link once, and answers its address', async (store) => {
    const now = Date.now();
    await store.createEmailLink({ codeHash: 'digest-1', email: 'alice@acme.dev', expiresAt: now + 60_000 });

    assert.equal(await store.spendEmailLink('digest-unknown', now), undefined);
    assert.equal(await store.spendEmailLink('digest-1', now), 'alice@acme.dev');
    assert.equal(await store.spendEmailLink('digest-1', now + 1), undefined);
    // A link makes no account: only `signIn` does, when the link was opened.
    assert.equal(await store.localeOf('alice@acme.dev'), undefined);
  });

  it('refuses a sign-in link at its expiry, and after', async (store) => {
    const now = Date.now();
    await store.createEmailLink({ codeHash: 'digest-1', email: 'alice@acme.dev', expiresAt: now + 60_000 });
    await store.createEmailLink({ codeHash: 'digest-2', email: 'bob@acme.dev', expiresAt: now + 60_000 });

    assert.equal(await store.spendEmailLink('digest-1', now + 60_000), undefined);
    assert.equal(await store.spendEmailLink('digest-1', now + 59_999), 'alice@acme.dev');
    assert.equal(await store.spendEmailLink('digest-2', now + 120_000), undefined);
  });

  it('gives one sign-in to two calls that spend one link at the same moment', async (store) => {
    const now = Date.now();
    await store.createEmailLink({ codeHash: 'digest-1', email: 'alice@acme.dev', expiresAt: now + 60_000 });

    const answers = await Promise.all([1, 2, 3].map(() => store.spendEmailLink('digest-1', now)));

    assert.deepEqual(
      answers.filter((answer) => answer !== undefined),
      ['alice@acme.dev'],
    );
  });

  it('keeps a link that can still be spent when another one is made', async (store) => {
    const now = Date.now();
    await store.createEmailLink({ codeHash: 'digest-1', email: 'alice@acme.dev', expiresAt: now + 60_000 });
    await store.createEmailLink({ codeHash: 'digest-2', email: 'alice@acme.dev', expiresAt: now + 60_000 });
    await store.createEmailLink({ codeHash: 'digest-3', email: 'bob@acme.dev', expiresAt: now + 60_000 });

    assert.equal(await store.spendEmailLink('digest-1', now), 'alice@acme.dev');
    assert.equal(await store.spendEmailLink('digest-2', now), 'alice@acme.dev');
    assert.equal(await store.spendEmailLink('digest-3', now), 'bob@acme.dev');
  });
}
