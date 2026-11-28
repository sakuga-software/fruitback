import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Workspace, workspaceAddress, workspaceNamed, workspaceOf } from './api.ts';
import { slugOf, slugRefusal } from './workspace-slug.ts';

/** The address of a workspace in the console (FRU-715): its short name, and every name that opens it. */

const acme: Workspace = { id: 'ws_acme', name: 'Acme', role: 'owner', slug: 'acme', formerSlugs: ['acme-old'] };
const globex: Workspace = { id: 'ws_globex', name: 'Globex', role: 'member', slug: 'globex' };

describe('the address of a workspace (FRU-715)', () => {
  it('is its short name, and its id from a worker that keeps none', () => {
    assert.equal(workspaceAddress(acme), 'acme');
    assert.equal(workspaceAddress({ id: 'w1' }), 'w1');
  });

  it('is named by its id, its short name and a short name it left, and by nothing else', () => {
    for (const named of ['ws_acme', 'acme', 'acme-old']) assert.equal(workspaceNamed(acme, named), true, named);
    for (const named of ['globex', 'ws_globex', 'Acme', 'acme-older', '']) {
      assert.equal(workspaceNamed(acme, named), false, named);
    }
  });

  it('finds the workspace an address names among those of the person', () => {
    assert.equal(workspaceOf([acme, globex], 'globex'), globex);
    assert.equal(workspaceOf([acme, globex], 'ws_acme'), acme);
    assert.equal(workspaceOf([acme, globex], 'acme-old'), acme);
    assert.equal(workspaceOf([acme, globex], 'initech'), undefined);
    assert.equal(workspaceOf([acme, globex], undefined), undefined);
    // A short name of one beats a name another left: the worker frees a name 30 days on.
    const taken = { ...globex, formerSlugs: ['acme'] };
    assert.equal(workspaceOf([taken, acme], 'acme'), acme);
  });
});

describe('a short name typed in « General » (FRU-715)', () => {
  it('is sent in lower case, trimmed, and its form is checked before it leaves', () => {
    assert.equal(slugOf('  Acme-Studio '), 'acme-studio');
    for (const typed of ['acme', 'a-1', ' ACME ', `a${'b'.repeat(38)}c`]) assert.equal(slugRefusal(typed), undefined);
    for (const typed of ['ab', '-acme', 'acme-', 'ac_me', 'ac me', 'acmé', '', `a${'b'.repeat(39)}c`]) {
      assert.equal(slugRefusal(typed), 'invalid-slug', typed);
    }
  });
});
