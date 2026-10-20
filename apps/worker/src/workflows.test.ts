import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

/**
 * Every action a workflow uses is pinned to a commit SHA, or a Docker image to its digest, with its
 * version as a comment (FRU-69).
 *
 * A tag can move to other code, and `release-image.yml` runs with `packages: write`. Dependabot moves
 * a pin that exists, but it does not pin a new step, so this test is what holds the rule.
 *
 * The workflows are parsed as YAML, never matched line by line: `uses : x`, a quoted key, a flow
 * mapping and a value on the next line are all the same key to GitHub.
 *
 * It lives beside `compose.test.ts`, which also reads files outside this package, because the root has
 * no `test` target.
 */

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url);

/**
 * `owner/repo@<40 hex>`, or the same for an action in a subdirectory of its repository, or a Docker
 * image pinned by the digest of its manifest: `docker://image@sha256:<64 hex>`. A digest names one
 * image, as a SHA names one commit. A tag of either can move.
 */
const PINNED = /^(?:[\w.-]+\/[\w./-]+@[0-9a-f]{40}|docker:\/\/[\w./-]+@sha256:[0-9a-f]{64})$/;

/** The version comment that must follow a pinned action on its line. */
const VERSION_COMMENT = /# v\d+(\.\d+){0,2}\s*$/;

type Reference = { where: string; value: string; rest: string };

/** Every `uses` value in one workflow, with the text that follows it on its line. */
function referencesIn(file: string, source: string): Reference[] {
  const document = parseDocument(source);
  assert.deepEqual(document.errors, [], `${file} is not valid YAML`);
  const references: Reference[] = [];

  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'uses') return;
      assert.ok(isScalar(pair.value) && typeof pair.value.value === 'string', `${file}: a uses that is not a string`);
      const end = pair.value.range?.[1] ?? 0;
      const lineEnd = source.indexOf('\n', end);
      references.push({
        where: `${file}:${source.slice(0, end).split('\n').length}`,
        value: pair.value.value,
        rest: source.slice(end, lineEnd < 0 ? undefined : lineEnd),
      });
    },
  });

  return references;
}

/** Every workflow, by file name, parsed once. */
function workflows(): { file: string; source: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, source: readFileSync(new URL(file, WORKFLOWS), 'utf8') }));
}

/**
 * What a workflow grants to every one of its jobs, as `name: level` pairs.
 *
 * A workflow with no `permissions` at all is the case this reports as `undefined`: it takes the
 * repository's default, which can be write.
 */
export function defaultPermissions(source: string): Record<string, string> | undefined {
  // `get` unwraps a scalar unless it is asked to keep the node, so `permissions: write-all` came
  // back as a plain string and `isScalar` answered false — the widest grant of all read as a map of
  // nothing, and this test passed over it. Raised in review.
  const document = parseDocument(source);
  const written = document.get('permissions', true);
  // An anchor elsewhere in the file and `permissions: *grant` here is the same grant, written once.
  // Raised in review.
  const granted = isAlias(written) ? written.resolve(document) : written;
  if (granted === undefined || granted === null) return undefined;
  if (isScalar(granted)) return { all: String(granted.value) };
  if (!isMap(granted)) return {};

  return Object.fromEntries(
    granted.items.flatMap((pair) =>
      isScalar(pair.key) && isScalar(pair.value) ? [[String(pair.key.value), String(pair.value.value)]] : [],
    ),
  );
}

/**
 * Every `uses` in the workflows. A local action has no tag to move, in either of its two forms:
 * `./path` is read from the checkout, and `$/path` from this repository at the commit that runs.
 */
function actionReferences(): Reference[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => referencesIn(file, readFileSync(new URL(file, WORKFLOWS), 'utf8')))
    .filter((reference) => !/^[.$]\//.test(reference.value));
}

/**
 * Every step that runs `gh` without naming the repository it talks to.
 *
 * **The rule is `GH_REPO`, and a checkout does not excuse it.** `gh` can infer the repository from
 * a checkout, but only when the step runs where that checkout landed: `actions/checkout` takes a
 * `path`, a step takes a `working-directory`, and a job can check out several repositories. Modelling
 * that is modelling Actions, and three review rounds went into trying — each one a new corner of the
 * same guard. Asking for the variable has no corners: it is one line in a workflow, and it says what
 * the command talks to rather than leaving it to the directory.
 *
 * The variable counts wherever `gh` reads it from: the workflow, the job, or the step. An empty
 * value names nothing and does not count. Raised in review, four times over.
 */
export function ghStepsWithoutRepository(source: string): string[] {
  const document = parseDocument(source);
  const workflowRepo = namedRepository(document.get('env', true));
  const jobs = document.get('jobs', true);
  if (!isMap(jobs)) return [];

  return jobs.items.flatMap((pair) => {
    if (!isScalar(pair.key) || !isMap(pair.value)) return [];
    const job = String(pair.key.value);
    const jobRepo = workflowRepo || namedRepository(pair.value.get('env', true));
    const steps = pair.value.get('steps', true);
    if (!isSeq(steps)) return [];

    return steps.items.flatMap((step, index) => {
      if (!isMap(step)) return [];
      const run = step.get('run');
      // `gh` after an operator or inside a substitution is a call too: `make && gh release …`,
      // `url=$(gh release view …)`. A word that merely starts with those letters is not.
      if (typeof run !== 'string' || !/(^|[\s;&|(])gh\s/.test(run)) return [];

      return jobRepo || namedRepository(step.get('env', true)) ? [] : [`${job}: step ${index + 1}`];
    });
  });
}

/**
 * Every `upload-artifact` step whose path goes through a hidden directory without asking for it.
 *
 * Since its v4.4 the action leaves out every hidden file, and a file under a directory whose name
 * starts with a dot counts as hidden. The step then finds nothing. With `if-no-files-found: error`
 * the run fails, and without it the run uploads nothing and passes. The extension writes its
 * archives under `.output`: the first tag `v0.1.0` built them and uploaded none (2026-10-09).
 */
export function uploadsMissingHiddenFiles(source: string): string[] {
  const document = parseDocument(source);
  const jobs = document.get('jobs', true);
  if (!isMap(jobs)) return [];

  return jobs.items.flatMap((pair) => {
    if (!isScalar(pair.key) || !isMap(pair.value)) return [];
    const job = String(pair.key.value);
    const steps = pair.value.get('steps', true);
    if (!isSeq(steps)) return [];

    return steps.items.flatMap((step, index) => {
      if (!isMap(step)) return [];
      const uses = step.get('uses');
      if (typeof uses !== 'string' || !uses.startsWith('actions/upload-artifact@')) return [];
      const inputs = step.get('with', true);
      if (!isMap(inputs)) return [];
      const path = inputs.get('path');
      const hidden = String(inputs.get('include-hidden-files') ?? 'false').trim() === 'true';
      const throughHidden = String(path ?? '')
        .split('\n')
        .some((line) =>
          line
            .trim()
            .split('/')
            .some((segment) => /^\.[^./]/.test(segment)),
        );

      return throughHidden && !hidden ? [`${job}: step ${index + 1}`] : [];
    });
  });
}

/** Whether this `env` mapping names a repository for `gh`: the key, holding something. */
function namedRepository(env: unknown): boolean {
  if (!isMap(env)) return false;
  const value = env.get('GH_REPO');

  return typeof value === 'string' && value.trim() !== '';
}

/**
 * What narrows the pull requests a workflow runs on: every key of its `pull_request` trigger.
 *
 * `undefined` says the workflow does not run on a pull request. An empty list says it runs on every
 * one. `on` is read in its three shapes: one event, a list of events, a mapping.
 *
 * `ci.yml` held `branches: [main]` until FRU-172. A pull request stacked on another one then got no
 * check at all, and no check reads as checks that have not started. A filter of paths has the same
 * result for a pull request that touches none of them. `types` counts too: a list without
 * `synchronize` checks the first push and none after it.
 */
export function pullRequestFilters(source: string): string[] | undefined {
  const on = parseDocument(source).get('on', true);
  if (isScalar(on)) return on.value === 'pull_request' ? [] : undefined;
  if (isSeq(on)) return on.items.some((item) => isScalar(item) && item.value === 'pull_request') ? [] : undefined;
  if (!isMap(on) || !on.has('pull_request')) return undefined;
  const trigger = on.get('pull_request', true);

  return isMap(trigger) ? trigger.items.flatMap((pair) => (isScalar(pair.key) ? [String(pair.key.value)] : [])) : [];
}

/** A job that calls `ci.yml` of this repository, in either form of a local reference. */
const CALLS_CI = /^[.$]\/\.github\/workflows\/ci\.yml$/;

/** The functions that let a job run after a job it needs has failed or was cancelled. */
const RUNS_AFTER_A_FAILURE = /\b(?:always|failure|cancelled)\s*\(/;

/**
 * The jobs that hold a write permission, or the secrets of an environment, and can run on a commit
 * that did not pass `ci.yml`. A job of an environment publishes outside GitHub, to a store for
 * example (FRU-329), and holds no permission that says so.
 *
 * **A job that writes names, in its own `needs`, a job that calls `ci.yml`** (FRU-172). On
 * 2026-10-11 `release-image.yml` published `46a5fa7` while `typecheck` and `test` failed on it: it
 * started on the same push as `ci.yml` and waited for nothing.
 *
 * The rule is the direct `needs`, and a chain does not excuse it. GitHub skips a job when a job it
 * needs fails, but a job in the middle of a chain that holds `if: always()` runs anyway, and what
 * the last job then does is a question about Actions. Asking for the name on the job that writes
 * has no such corner. For the same reason an `if` that holds `always()`, `failure()` or
 * `cancelled()` on that job is reported: it runs the job after the checks failed.
 */
export function writersWithoutCi(source: string): string[] {
  const jobs = parseDocument(source).get('jobs', true);
  if (!isMap(jobs)) return [];

  const callers = new Set(
    jobs.items.flatMap((pair) =>
      isScalar(pair.key) && isMap(pair.value) && CALLS_CI.test(String(pair.value.get('uses') ?? ''))
        ? [String(pair.key.value)]
        : [],
    ),
  );

  return jobs.items.flatMap((pair) => {
    if (!isScalar(pair.key) || !isMap(pair.value)) return [];
    const granted = pair.value.get('permissions', true);
    const levels = isMap(granted)
      ? granted.items.map((entry) => (isScalar(entry.value) ? String(entry.value.value) : ''))
      : [isScalar(granted) ? String(granted.value) : ''];
    if (!levels.some((level) => level.includes('write')) && !pair.value.has('environment')) return [];

    const needs = pair.value.get('needs', true);
    const needed = isSeq(needs) ? needs.items.map((item) => (isScalar(item) ? String(item.value) : '')) : [];
    if (isScalar(needs)) needed.push(String(needs.value));
    const condition = String(pair.value.get('if') ?? '');

    return needed.some((job) => callers.has(job)) && !RUNS_AFTER_A_FAILURE.test(condition)
      ? []
      : [String(pair.key.value)];
  });
}

describe('the GitHub workflows', () => {
  it('pin every action to a commit SHA, with its version as a comment', () => {
    const references = actionReferences();

    assert.ok(references.length >= 20, `only ${references.length} action references found`);
    assert.deepEqual(
      references
        .filter((reference) => !PINNED.test(reference.value) || !VERSION_COMMENT.test(reference.rest))
        .map((reference) => reference.where),
      [],
    );
  });

  it('take a Docker image pinned by its digest, never by a tag', () => {
    assert.ok(PINNED.test(`docker://pragent/pr-agent@sha256:${'a'.repeat(64)}`));
    assert.ok(!PINNED.test('docker://pragent/pr-agent:0.46.0'));
    assert.ok(!PINNED.test('docker://pragent/pr-agent@sha256:abc'));
  });

  /**
   * **No workflow hands a write to every job** (FRU-70, widened to all of them by FRU-77).
   *
   * A job that publishes declares the permission it needs, beside the steps that need it. Granted at
   * the top instead, the same token reaches the jobs that only build and scan — and a step added to
   * one of those later inherits it with nothing to say so.
   */
  /**
   * The widest grant of all is a scalar — `permissions: write-all` — and it is the one the reader
   * missed. Driven on YAML rather than on the files, because no workflow here may hold that case.
   */
  it('read a permissions block whatever shape it is written in', () => {
    assert.deepEqual(defaultPermissions('permissions: write-all\njobs: {}\n'), { all: 'write-all' });
    assert.deepEqual(defaultPermissions('permissions: read-all\njobs: {}\n'), { all: 'read-all' });
    assert.deepEqual(defaultPermissions('permissions:\n  contents: write\njobs: {}\n'), { contents: 'write' });
    assert.deepEqual(defaultPermissions('permissions:\n  contents: read\njobs: {}\n'), { contents: 'read' });
    assert.equal(defaultPermissions('jobs: {}\n'), undefined);
    // An anchor written once and pointed at here is the same grant. Raised in review.
    assert.deepEqual(defaultPermissions('name: &grant write-all\npermissions: *grant\njobs: {}\n'), {
      all: 'write-all',
    });
  });

  /**
   * **`gh` reads the repository from the working directory**, and a job that checks nothing out has
   * none. `release-extension.yml`'s publish job only downloads an artefact: its first upload failed
   * for that, and the tag it would have failed on does not exist yet. Raised in review.
   */
  it('upload a hidden directory only when they ask for hidden files', () => {
    const missing = workflows().flatMap(({ file, source }) =>
      uploadsMissingHiddenFiles(source).map((step) => `${file}: ${step}`),
    );

    assert.deepEqual(missing, [], 'these uploads go through a hidden directory and would find nothing');
  });

  it('see an upload under a hidden directory, and let one that asks for it pass', () => {
    const upload = (inputs: string) =>
      [
        'jobs:',
        '  package:',
        '    steps:',
        '      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
        '        with:',
        ...inputs.split('\n').map((line) => `          ${line}`),
      ].join('\n');

    assert.deepEqual(uploadsMissingHiddenFiles(upload('path: apps/extension/.output/*.zip')), ['package: step 1']);
    assert.deepEqual(uploadsMissingHiddenFiles(upload('path: |\n  dist/\n  .cache/report')), ['package: step 1']);
    assert.deepEqual(
      uploadsMissingHiddenFiles(upload('path: apps/extension/.output/*.zip\ninclude-hidden-files: true')),
      [],
    );
    assert.deepEqual(uploadsMissingHiddenFiles(upload('path: ./playwright-report/\npath2: ../x')), []);
  });

  it('name the repository at every step that runs gh', () => {
    const blind = workflows().flatMap(({ file, source }) =>
      ghStepsWithoutRepository(source).map((step) => `${file}: ${step}`),
    );

    assert.deepEqual(blind, [], 'these steps run gh without naming the repository');
  });

  /**
   * The rules no workflow of this repository holds, driven on YAML: where the variable is written,
   * and what counts as a call. A checkout is deliberately not one of them — see the docstring.
   */
  it('read the repository a gh step names, wherever the variable is written', () => {
    const step = (body: string) => `jobs:\n  publish:\n    steps:\n${body}`;
    const ghStep = '      - run: gh release upload v1 file.zip\n';
    const named = `${ghStep}        env:\n          GH_REPO: acme/site\n`;

    assert.deepEqual(ghStepsWithoutRepository(step(named)), []);
    assert.deepEqual(ghStepsWithoutRepository(`env:\n  GH_REPO: acme/site\n${step(ghStep)}`), []);
    assert.deepEqual(
      ghStepsWithoutRepository(`jobs:\n  publish:\n    env:\n      GH_REPO: acme/site\n    steps:\n${ghStep}`),
      [],
    );

    // A checkout is not repository context: it depends on where it landed and where the step runs.
    assert.deepEqual(ghStepsWithoutRepository(step(`      - uses: actions/checkout@abc\n${ghStep}`)), [
      'publish: step 2',
    ]);
    // An empty value names nothing.
    assert.deepEqual(ghStepsWithoutRepository(`env:\n  GH_REPO: ''\n${step(ghStep)}`), ['publish: step 1']);
    // The variable of another step is another step's.
    assert.deepEqual(ghStepsWithoutRepository(step(named + ghStep)), ['publish: step 2']);
    // A call after an operator, and one inside a substitution, are calls.
    assert.deepEqual(ghStepsWithoutRepository(step('      - run: make build && gh release upload v1 f.zip\n')), [
      'publish: step 1',
    ]);
    assert.deepEqual(ghStepsWithoutRepository(step('      - run: url=$(gh release view v1 --json url)\n')), [
      'publish: step 1',
    ]);
    // A word that merely starts with those two letters is not a call.
    assert.deepEqual(ghStepsWithoutRepository(step('      - run: echo ghost writes nothing\n')), []);
  });

  it('grant no write above the job that needs it', () => {
    const files = workflows();

    assert.ok(files.length >= 3, `only ${files.length} workflows found — the walk stopped matching`);
    const wide = files
      .map(({ file, source }) => ({ file, granted: defaultPermissions(source) }))
      .filter(({ granted }) => granted === undefined || Object.values(granted).some((level) => level.includes('write')))
      .map(
        ({ file, granted }) => `${file}: ${granted === undefined ? 'no permissions block' : JSON.stringify(granted)}`,
      );

    assert.deepEqual(wide, [], 'these workflows give every job more than a read');
  });

  /**
   * **A pull request with no check is not a pull request that passed** (FRU-172). `ci.yml` is the
   * workflow that holds lint, format, typecheck and the tests, so it is the one read here.
   */
  it('run CI on every pull request, whatever branch it targets', () => {
    const ci = readFileSync(new URL('ci.yml', WORKFLOWS), 'utf8');

    assert.deepEqual(pullRequestFilters(ci), [], 'ci.yml runs on some pull requests only');
    const pushed = parseDocument(ci).getIn(['on', 'push', 'branches'], true);
    assert.ok(isSeq(pushed), 'ci.yml names no branch that it runs on at a push');
    assert.deepEqual(pushed.toJSON(), ['main']);
  });

  it('read a pull request trigger whatever shape it is written in', () => {
    assert.deepEqual(pullRequestFilters('on: pull_request\njobs: {}\n'), []);
    assert.deepEqual(pullRequestFilters('on: [push, pull_request]\njobs: {}\n'), []);
    assert.deepEqual(pullRequestFilters('on:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n'), []);
    assert.deepEqual(pullRequestFilters('on:\n  pull_request: {}\njobs: {}\n'), []);
    // The form `ci.yml` had: a pull request whose base is another branch gets no run.
    assert.deepEqual(pullRequestFilters('on:\n  pull_request:\n    branches: [main]\njobs: {}\n'), ['branches']);
    assert.deepEqual(pullRequestFilters("on:\n  pull_request:\n    paths: ['apps/**']\n    types: [opened]\n"), [
      'paths',
      'types',
    ]);
    assert.equal(pullRequestFilters('on:\n  push:\n    tags: [v*]\njobs: {}\n'), undefined);
    assert.equal(pullRequestFilters('on: push\njobs: {}\n'), undefined);
    // Another event is another event: a pull request from a fork must not run with the secrets.
    assert.equal(pullRequestFilters('on:\n  pull_request_target:\njobs: {}\n'), undefined);
  });

  /**
   * **A commit of `main` keeps its run.** On 2026-10-11 the group was `ci-${{ github.ref }}` with
   * `cancel-in-progress: true`: two merges landed 14 seconds apart, the second one cancelled the run
   * of the first, and `main` had no verdict for that commit.
   *
   * This reads the two lines and does not evaluate them. It fails on the form that caused it: a
   * group that no commit is part of, or a cancellation that does not depend on the event.
   */
  it('give a commit of main a run that no later merge cancels', () => {
    const concurrency = parseDocument(readFileSync(new URL('ci.yml', WORKFLOWS), 'utf8')).get('concurrency');
    assert.ok(isMap(concurrency), 'ci.yml has no concurrency block');

    assert.match(String(concurrency.get('group')), /github\.sha/, 'the group of a push names no commit');
    assert.match(
      String(concurrency.get('cancel-in-progress')),
      /github\.event_name == 'pull_request'/,
      'a run is cancelled whatever the event is',
    );
  });

  /**
   * A check that looks for an absence must be able to fail (FRU-222). GitHub runs a step with
   * `bash -e`, and bash does not stop on a command that `!` inverts: `! grep -q unsafe-inline` left
   * the step green with `unsafe-inline` in the policy. The form that stops is
   * `if grep …; then exit 1; fi`. Raised in review.
   */
  it('negate no command with `!` in a step: under `bash -e` it never fails the step', () => {
    const negated = /^\s+! \S.*$/gm;
    // The control: the form that was there is found.
    assert.deepEqual('        run: |\n          ! grep -q unsafe-inline /tmp/policy\n'.match(negated)?.length, 1);

    assert.deepEqual(
      workflows().flatMap(({ file, source }) => (source.match(negated) ?? []).map((line) => `${file}: ${line.trim()}`)),
      [],
    );
  });

  it('publish nothing from a commit that did not pass CI', () => {
    const files = workflows();
    const writers = files.flatMap(({ source }) => [...source.matchAll(/^ {6}\w[\w-]*: write$/gm)]);
    // An absence needs a control: the two jobs that publish are found before none is reported.
    assert.ok(writers.length >= 4, `only ${writers.length} write permissions found in the workflows`);

    const free = files.flatMap(({ file, source }) => writersWithoutCi(source).map((job) => `${file}: ${job}`));

    assert.deepEqual(free, [], 'these jobs can write and do not need the job that calls ci.yml');
    // A workflow that cannot be called fails the release at its start, after the merge. Fail here.
    const on = parseDocument(readFileSync(new URL('ci.yml', WORKFLOWS), 'utf8')).get('on', true);
    assert.ok(isMap(on) && on.has('workflow_call'), 'ci.yml does not declare workflow_call');
  });

  it('read what a job that writes waits for, whatever shape it is written in', () => {
    const workflow = (publish: string, ci = '    uses: $/.github/workflows/ci.yml') =>
      `jobs:\n  ci:\n${ci}\n  check:\n    runs-on: ubuntu-latest\n  publish:\n    permissions:\n      packages: write\n${publish}`;

    assert.deepEqual(writersWithoutCi(workflow('    needs: [ci, check]\n')), []);
    assert.deepEqual(writersWithoutCi(workflow('    needs: ci\n')), []);
    assert.deepEqual(writersWithoutCi(workflow('    needs:\n      - check\n      - ci\n')), []);
    assert.deepEqual(writersWithoutCi(workflow('    needs: ci\n', '    uses: ./.github/workflows/ci.yml')), []);
    // The form `release-image.yml` had: it waits for its own check, and not for the tests.
    assert.deepEqual(writersWithoutCi(workflow('    needs: check\n')), ['publish']);
    assert.deepEqual(writersWithoutCi(workflow('    runs-on: ubuntu-latest\n')), ['publish']);
    // A job called `ci` that calls nothing is a name.
    assert.deepEqual(writersWithoutCi(workflow('    needs: ci\n', '    runs-on: ubuntu-latest')), ['publish']);
    assert.deepEqual(writersWithoutCi(workflow('    needs: ci\n', '    uses: ./.github/workflows/other.yml')), [
      'publish',
    ]);
    // A chain is not the direct `needs`.
    assert.deepEqual(
      writersWithoutCi(
        'jobs:\n  ci:\n    uses: $/.github/workflows/ci.yml\n  package:\n    needs: ci\n  publish:\n    needs: package\n    permissions:\n      contents: write\n',
      ),
      ['publish'],
    );
    // These run the job after the checks failed.
    assert.deepEqual(writersWithoutCi(workflow('    needs: ci\n    if: always()\n')), ['publish']);
    assert.deepEqual(writersWithoutCi(workflow("    needs: ci\n    if: ${{ !cancelled() && github.ref == 'x' }}\n")), [
      'publish',
    ]);
    assert.deepEqual(writersWithoutCi(workflow("    needs: ci\n    if: github.ref == 'refs/heads/main'\n")), []);
    // `write-all` on a job is a write. A job that only reads is free to run when it likes.
    assert.deepEqual(writersWithoutCi('jobs:\n  publish:\n    permissions: write-all\n'), ['publish']);
    assert.deepEqual(writersWithoutCi('jobs:\n  scan:\n    permissions:\n      contents: read\n'), []);
    // A job of an environment publishes with its secrets, and holds no write permission (FRU-329).
    assert.deepEqual(writersWithoutCi('jobs:\n  submit:\n    environment: stores\n    needs: package\n'), ['submit']);
    assert.deepEqual(
      writersWithoutCi(workflow('    needs: ci\n').replace('publish:\n', 'submit:\n    environment: stores\n')),
      [],
    );
  });
});
