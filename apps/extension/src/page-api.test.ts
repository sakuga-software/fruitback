import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXTENSION_EVENT, EXTENSION_GLOBAL } from './page-api.ts';

/**
 * The two names a site writes into its own build, checked against the two this extension sets.
 *
 * They are a published contract the moment `docs/install.md` tells somebody to type them, and
 * renaming either would leave every team-mode site dormant for ever — with nothing in a console to
 * say why, because a global that is never set and an extension that is not installed look the same.
 * The snippet itself was type-checked against `fruitback` when it was written; what drifts after
 * that is the name.
 */
describe('the names a team-mode site is told to use', () => {
  const install = readFileSync(fileURLToPath(new URL('../../../docs/install.md', import.meta.url)), 'utf8');

  const snippet = /### Team mode[\s\S]*?```ts\n([\s\S]*?)```/.exec(install)?.[1];

  /** A guard over an empty snippet passes. Say so here rather than discover it after a rewrite. */
  it('finds the snippet it is written to guard', () => {
    assert.ok(snippet !== undefined && snippet.length > 0, 'docs/install.md has no team-mode TypeScript snippet');
  });

  it('tells a site the global this extension actually sets', () => {
    assert.ok(snippet?.includes(`window.${EXTENSION_GLOBAL}`), `the snippet does not read window.${EXTENSION_GLOBAL}`);
  });

  it('tells a site the event this extension actually fires', () => {
    assert.ok(snippet?.includes(`'${EXTENSION_EVENT}'`), `the snippet does not listen for ${EXTENSION_EVENT}`);
  });
});
