import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceNameFrom } from './workspace-name.ts';

describe('the name a workspace takes from the address of its first person (FRU-239)', () => {
  it('is the domain of a company, with a capital and no suffix', () => {
    assert.equal(workspaceNameFrom('ana@acme.dev'), 'Acme');
    assert.equal(workspaceNameFrom('tom@client.fr'), 'Client');
    assert.equal(workspaceNameFrom('paul@lumen.studio'), 'Lumen');
  });

  it('is what is before the @ for a public mailbox, less what follows a +', () => {
    assert.equal(workspaceNameFrom('ana.martin@gmail.com'), 'Ana.martin');
    assert.equal(workspaceNameFrom('tom+fruitback@proton.me'), 'Tom');
    assert.equal(workspaceNameFrom('lea@googlemail.com'), 'Lea');
    // The control: the same person at a company is named after the company.
    assert.equal(workspaceNameFrom('ana.martin@acme.dev'), 'Acme');
  });

  it('reads past a subdomain', () => {
    assert.equal(workspaceNameFrom('ana@mail.acme.dev'), 'Acme');
    assert.equal(workspaceNameFrom('ana@eu.team.acme.dev'), 'Acme');
  });

  it('reads an address in capitals, and with spaces around it', () => {
    assert.equal(workspaceNameFrom('  ANA@ACME.DEV '), 'Acme');
    assert.equal(workspaceNameFrom('Tom@GMail.com'), 'Tom');
  });

  it('reads past a suffix of two parts', () => {
    assert.equal(workspaceNameFrom('ana@acme.co.uk'), 'Acme');
    assert.equal(workspaceNameFrom('ana@mail.acme.com.au'), 'Acme');
    assert.equal(workspaceNameFrom('ana@acme.ac.nz'), 'Acme');
    // The control: `co` before a suffix of three letters is the name itself.
    assert.equal(workspaceNameFrom('ana@co.dev'), 'Co');
    // And a company named like a second level, under a country: its two labels are all there is.
    assert.equal(workspaceNameFrom('ana@com.fr'), 'Com');
  });

  it('always answers a name the worker takes: one line, 1 to 80 characters', () => {
    assert.equal(workspaceNameFrom(''), 'Workspace');
    assert.equal(workspaceNameFrom('@'), 'Workspace');
    assert.equal(workspaceNameFrom('ana'), 'Ana');
    assert.equal(workspaceNameFrom('ana@localhost'), 'Localhost');
    assert.equal(workspaceNameFrom(`ana@${'a'.repeat(120)}.dev`).length, 80);
    assert.equal(workspaceNameFrom('a\nb@gmail.com'), 'Ab');
  });
});
