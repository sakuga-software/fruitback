import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_NOTE_STAGE } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import {
  ATTACHMENT_SUBTITLE,
  createLinearStore,
  linearRoutingFor,
  reopenStateOf,
  stageForLinearState,
  toNoteIssue,
} from './linear.ts';
import { installLinearStub, storedIssueFromNote } from './linear-stub.ts';
import { StoreError } from './store.ts';

/**
 * These tests moved here from `packages/shared` with the code they cover (FRU-23). The contract
 * package names the stages; this connector is what knows how Linear's own workflow reaches them.
 */

describe('stageForLinearState', () => {
  it('moves the pin along the Linear workflow', () => {
    assert.equal(stageForLinearState('backlog'), 'new');
    assert.equal(stageForLinearState('triage'), 'new');
    assert.equal(stageForLinearState('unstarted'), 'todo');
    assert.equal(stageForLinearState('started'), 'progress');
    assert.equal(stageForLinearState('completed'), 'done');
    assert.equal(stageForLinearState('canceled'), 'closed');
    // The SKG team has a "Duplicate" state; a duplicated pin must not read as new.
    assert.equal(stageForLinearState('duplicate'), 'closed');
  });

  it('draws an unrecognised state instead of hiding it, at the contract’s default', () => {
    // Both inputs happen: Linear can answer with a state type this connector has never seen, and
    // `toNoteIssue` passes '' for an issue that came back with no state at all.
    assert.equal(stageForLinearState('someCustomType'), DEFAULT_NOTE_STAGE);
    assert.equal(stageForLinearState(''), DEFAULT_NOTE_STAGE);

    // Asserted against the constant, not against `'new'`: every connector answers the same way
    // for a state it does not know, so the rule is the contract's and a connector spelling the
    // literal itself is how the next one comes to disagree. Which stage that is stays pinned in
    // `packages/shared/src/linear.test.ts`, where the constant is declared.
  });
});

describe('linearRoutingFor', () => {
  const config = { apiKey: 'lin_api_test', teamId: 'team_worker', projectId: 'project_worker' };

  it('sends a client with no team of its own to the worker’s', () => {
    // This fallback used to live in `resolveClient`, which meant the worker's client resolution knew
    // that a store routes by team (FRU-29). Falling back to *the worker's team* is a rule about
    // teams, so it belongs to the file that knows what a team is.
    assert.deepEqual(linearRoutingFor(config, undefined), { teamId: 'team_worker', projectId: 'project_worker' });
    assert.deepEqual(linearRoutingFor(config, {}), { teamId: 'team_worker', projectId: 'project_worker' });
  });

  it('falls back per field, so a client can have its own team and share the project', () => {
    assert.deepEqual(linearRoutingFor(config, { teamId: 'team_acme' }), {
      teamId: 'team_acme',
      projectId: 'project_worker',
    });
  });

  it('lets a client override both', () => {
    assert.deepEqual(linearRoutingFor(config, { teamId: 'team_acme', projectId: 'project_acme' }), {
      teamId: 'team_acme',
      projectId: 'project_acme',
    });
  });
});

describe('the Linear store', () => {
  it('scopes the read cache by team, which is what separates tenants here', () => {
    // The worker asks the store what distinguishes one tenant's answers from another's, instead of
    // reaching for `teamId` itself. For the in-memory store the answer is a constant.
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_worker', projectId: undefined });

    assert.equal(store.name, 'linear');
    assert.equal(store.scope(undefined), 'team_worker');
    assert.equal(store.scope({ teamId: 'team_acme' }), 'team_acme');
  });
});

describe('« Still wrong » in Linear (FRU-294)', () => {
  afterEach(() => vi.restoreAllMocks());

  const state = (id: string, type: string, position: number) => ({ id, name: id, type, position });
  const CHECKER = { kind: 'member' as const, name: 'Bob', workspace: 'Acme' };

  it('picks triage, else backlog, else unstarted, the first of the board of that type', () => {
    const triage = [state('Done', 'completed', 0), state('Triage', 'triage', 3), state('Backlog', 'backlog', 1)];
    const noTriage = [state('Later', 'backlog', 2), state('Backlog', 'backlog', 1), state('Todo', 'unstarted', 0)];
    const onlyTodo = [state('Todo', 'unstarted', 4), state('Doing', 'started', 1)];

    assert.equal(reopenStateOf(triage)?.id, 'Triage');
    assert.equal(reopenStateOf(noTriage)?.id, 'Backlog');
    assert.equal(reopenStateOf(onlyTodo)?.id, 'Todo');
    assert.equal(reopenStateOf([state('Done', 'completed', 0)]), undefined);
  });

  it('writes the marked reply, then moves the issue of a team with no triage to its backlog', async () => {
    const stub = installLinearStub({
      teamStates: [
        state('st_done', 'completed', 3),
        state('st_todo', 'unstarted', 1),
        state('st_backlog', 'backlog', 0),
      ],
    });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    const answer = await store.check?.(
      { issue: 'issue_1', clientId: 'acme' },
      { verdict: 'wrong', author: CHECKER },
      undefined,
      { showComments: true, identitySecret: undefined, read: 'public', write: 'public', locale: 'en' },
    );

    assert.deepEqual(
      stub.calls.map((call) => call.operation),
      ['FruitbackCreateComment', 'FruitbackIssueStates', 'FruitbackReopenIssue'],
    );
    assert.deepEqual(stub.calls[2]?.variables, { id: 'issue_1', input: { stateId: 'st_backlog' } });
    assert.equal(answer?.stage, 'new');
    assert.equal(answer?.comment.body, '**Bob** via Fruitback · member of Acme\nReopened: still wrong');
  });

  it('« Looks fixed » writes the reply and moves nothing', async () => {
    const stub = installLinearStub({ teamStates: [state('st_backlog', 'backlog', 0)] });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    const answer = await store.check?.(
      { issue: 'issue_1', clientId: 'acme' },
      { verdict: 'fixed', author: CHECKER },
      undefined,
      { showComments: true, identitySecret: undefined, read: 'public', write: 'public', locale: 'fr' },
    );

    assert.deepEqual(
      stub.calls.map((call) => call.operation),
      ['FruitbackCreateComment'],
    );
    assert.equal(answer?.stage, 'done');
    assert.equal(answer?.comment.body, '**Bob** via Fruitback · membre de Acme\nVérifié : semble corrigé');
  });

  it('fails after the reply when the team has no state to reopen the issue in, and moves nothing', async () => {
    const stub = installLinearStub({ teamStates: [state('st_done', 'completed', 0)] });
    const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined });

    await assert.rejects(
      store.check?.({ issue: 'issue_1', clientId: 'acme' }, { verdict: 'wrong', author: CHECKER }, undefined, {
        showComments: true,
        identitySecret: undefined,
        read: 'public',
        write: 'public',
        locale: 'en',
      }) ?? Promise.resolve(),
    );
    assert.equal(
      stub.calls.some((call) => call.operation === 'FruitbackReopenIssue'),
      false,
    );
  });
});

describe('the files of a note, in Linear (FRU-331)', () => {
  afterEach(() => vi.restoreAllMocks());

  const POLICY = {
    showComments: true,
    identitySecret: undefined,
    read: 'public',
    write: 'public',
    locale: 'en',
  } as const;
  const config = { apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined };
  const files = [
    { id: 'att_1', name: 'capture.png', type: 'image/png', content: new Uint8Array([1, 2, 3]) },
    { id: 'att_2', name: 'log.txt', type: 'text/plain', content: new Uint8Array([0x61]) },
  ];

  it('puts each file in the storage of Linear before the issue, then attaches it to the issue', async () => {
    const stub = installLinearStub();
    const created = await createLinearStore(config).create(noteFixture(), undefined, POLICY, files);

    assert.deepEqual(
      stub.calls.map((call) => call.operation).filter((operation) => !operation.includes('Label')),
      [
        'FruitbackFileUpload',
        'PUT',
        'FruitbackFileUpload',
        'PUT',
        'FruitbackCreateIssue',
        'FruitbackCreateAttachment',
        'FruitbackCreateAttachment',
      ],
    );
    assert.deepEqual(stub.calls[0]?.variables, { contentType: 'image/png', filename: 'capture.png', size: 3 });
    // The PUT carries the bytes, the type, and every header that `fileUpload` named.
    assert.deepEqual([...(stub.puts[0]?.body ?? [])], [1, 2, 3]);
    assert.equal(stub.puts[0]?.headers['Content-Type'], 'image/png');
    assert.equal(stub.puts[0]?.headers['x-goog-content-length-range'], '3,3');
    assert.deepEqual(stub.calls.at(-2)?.variables, {
      input: {
        issueId: 'issue_1',
        title: 'capture.png',
        url: 'https://uploads.linear.app/asset/1/capture.png',
        subtitle: ATTACHMENT_SUBTITLE,
      },
    });
    assert.deepEqual(created.files, { sent: ['att_1', 'att_2'], lost: [], waiting: [] });
  });

  it('writes no issue when Linear does not take a file, so the note and its files are sent again', async () => {
    for (const options of [
      { failFileUpload: true },
      { putStatus: 403 },
      { uploadUrl: 'http://storage.linear.test/put' },
    ]) {
      const stub = installLinearStub(options);
      await assert.rejects(createLinearStore(config).create(noteFixture(), undefined, POLICY, files), StoreError);
      assert.equal(
        stub.calls.some((call) => call.operation === 'FruitbackCreateIssue'),
        false,
        JSON.stringify(options),
      );
      vi.restoreAllMocks();
    }
  });

  it('answers a file that Linear refuses to attach as lost, once the issue exists, and never throws', async () => {
    installLinearStub({ failAttachment: true });
    const created = await createLinearStore(config).create(noteFixture(), undefined, POLICY, files);

    assert.equal(created.identifier, 'SKG-999');
    assert.deepEqual(created.files, { sent: [], lost: ['att_1', 'att_2'], waiting: [] });
  });

  it('sends no file and says nothing of files for a note without one', async () => {
    const stub = installLinearStub();
    const created = await createLinearStore(config).create(noteFixture(), undefined, POLICY);

    assert.equal('files' in created, false);
    assert.equal(stub.puts.length, 0);
  });

  it('reads back the attachments that Fruitback made, by name and address, and not the others', () => {
    const seed = noteFixture();
    const issue = toNoteIssue(
      {
        ...storedIssueFromNote(seed),
        attachments: {
          nodes: [
            { title: 'capture.png', url: 'https://uploads.linear.app/a/capture.png', subtitle: ATTACHMENT_SUBTITLE },
            { title: 'PR #12', url: 'https://github.com/acme/app/pull/12', subtitle: 'Open' },
          ],
        },
      },
      seed.page.url,
    );

    assert.deepEqual(issue?.attachments, [{ name: 'capture.png', url: 'https://uploads.linear.app/a/capture.png' }]);
    assert.equal('attachments' in (toNoteIssue(storedIssueFromNote(seed), seed.page.url) ?? {}), false);
  });
});

describe('the files of a note, read back from Linear (FRU-348)', () => {
  afterEach(() => vi.restoreAllMocks());

  const POLICY = {
    showComments: true,
    identitySecret: undefined,
    read: 'public',
    write: 'public',
    locale: 'en',
  } as const;
  const config = { apiKey: 'lin_api_test', teamId: 'team_1', projectId: undefined };

  it('finds the files of Fruitback behind more than ten other attachments of the issue', async () => {
    const seed = noteFixture();
    const links = Array.from({ length: 12 }, (_, index) => ({
      title: `PR #${index + 1}`,
      url: `https://github.com/acme/app/pull/${index + 1}`,
      subtitle: 'Open',
    }));
    const ours = [
      { title: 'capture.png', url: 'https://uploads.linear.app/a/capture.png', subtitle: ATTACHMENT_SUBTITLE },
      { title: 'log.txt', url: 'https://uploads.linear.app/a/log.txt', subtitle: ATTACHMENT_SUBTITLE },
    ];
    const stub = installLinearStub({
      storedIssues: [storedIssueFromNote(seed, { attachments: { nodes: [...links, ...ours] } })],
    });

    const [issue] = await createLinearStore(config).findForPage(
      { url: seed.page.url, clientId: undefined },
      undefined,
      POLICY,
    );

    assert.deepEqual(issue?.attachments, [
      { name: 'capture.png', url: 'https://uploads.linear.app/a/capture.png' },
      { name: 'log.txt', url: 'https://uploads.linear.app/a/log.txt' },
    ]);
    // Linear is asked for the files of Fruitback only, so the links of the team take no place.
    assert.deepEqual(stub.calls.at(-1)?.variables.attachmentFilter, { subtitle: { eq: ATTACHMENT_SUBTITLE } });
  });
});
