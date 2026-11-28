import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { parseDocument } from 'yaml';
import { archiveOf, MANIFEST, releasedArchive } from '../../../tools/ci/extension-release.ts';

/**
 * The pull request of a version runs the published specs against the extension it releases
 * (FRU-612). Before, `published.yml` ran them against the last release only: after FRU-555 renamed
 * words of the extension, the spec passed until the release of 0.7.0, then failed on every commit of
 * `main` for two days.
 *
 * It lives beside `ci-changeset.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const manifest = (version: string, more: Record<string, unknown> = {}) => JSON.stringify({ version, ...more });

type Step = { id?: string; if?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: { pull_request: { paths: string[] } };
  jobs: Record<string, { steps: (Step & { uses?: string; with?: Record<string, unknown> })[] }>;
};

const PUBLISHED = parseDocument(
  readFileSync(new URL('.github/workflows/published.yml', ROOT), 'utf8'),
).toJS() as Workflow;

describe('the published specs on the pull request of a version', () => {
  it('build the archive of the new version when the version of the extension moves', () => {
    assert.equal(
      releasedArchive(manifest('0.8.0'), manifest('0.9.0')),
      'apps/extension/.output/fruitback-0.9.0-chrome.zip',
    );
    assert.equal(archiveOf('0.9.0'), 'apps/extension/.output/fruitback-0.9.0-chrome.zip');
  });

  it('take the last release when only the rest of the manifest changed', () => {
    const dependency = { dependencies: { wxt: '0.21.0' } };
    assert.equal(releasedArchive(manifest('0.8.0'), manifest('0.8.0', dependency)), undefined);
  });

  it('refuse a manifest that names no version', () => {
    assert.throws(() => releasedArchive(manifest('0.8.0'), '{}'), /apps\/extension\/package\.json names no version/);
  });

  it('read the version of the manifest that the pull request of a version moves', () => {
    assert.equal(MANIFEST, 'apps/extension/package.json');
    assert.ok(
      PUBLISHED.on.pull_request.paths.includes(MANIFEST),
      'published.yml runs on a pull request that changes it',
    );
    const root = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { version: string };
    const extension = JSON.parse(readFileSync(new URL(MANIFEST, ROOT), 'utf8')) as { version: string };
    // `version.yml` moves the root to the version of the fixed group, and tags `v<root>`.
    assert.equal(extension.version, root.version);
  });

  it('build that archive as release-extension.yml does, then give it to fetch.ts', () => {
    const steps = PUBLISHED.jobs.published?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['fetch-depth'], 2, 'HEAD^1 is in the checkout');

    const decide = steps.find((step) => step.run?.includes('tools/ci/extension-release.ts'));
    assert.ok(decide?.id !== undefined);
    assert.equal(decide.if, "github.event_name == 'pull_request'");
    assert.equal(decide.run, 'node tools/ci/extension-release.ts >> "$GITHUB_OUTPUT"');

    const zip = steps.find((step) => step.run === 'pnpm --filter @fruitback/extension zip');
    assert.equal(zip?.if, `steps.${decide.id}.outputs.archive != ''`);
    const release = parseDocument(
      readFileSync(new URL('.github/workflows/release-extension.yml', ROOT), 'utf8'),
    ).toJS() as Workflow;
    assert.ok(
      release.jobs.package?.steps.some((step) => step.run?.startsWith('pnpm --filter @fruitback/extension zip')),
      'the stores get the archive of the same command',
    );

    const fetch = steps.find((step) => step.run === 'node e2e/published/fetch.ts');
    assert.equal(fetch?.env?.FRUITBACK_PUBLISHED_EXTENSION_ARCHIVE, `\${{ steps.${decide.id}.outputs.archive }}`);
    const build = steps.findIndex((step) => step.run?.includes('@fruitback/widget build'));
    const order = [steps.indexOf(decide), build, steps.indexOf(zip!), steps.indexOf(fetch!)];
    assert.deepEqual(
      order.toSorted((a, b) => a - b),
      order,
      'decide, build what the extension bundles, zip, fetch',
    );
  });
});
