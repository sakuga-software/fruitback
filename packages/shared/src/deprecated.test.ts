import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from './index.ts';
import * as oldFixtures from './seed.fixture.ts';
import { minimalNoteFixture, noteFixture, noteIssueFixture } from './note.fixture.ts';

/**
 * The names of before FRU-378 stay, each one the new name under the old one, until FRU-446. A
 * consumer of 0.3.0 that upgrades must build, and must read the same values.
 */

const SAME: [name: string, old: unknown, now: unknown][] = [
  ['seedSchema', contract.seedSchema, contract.noteSchema],
  ['seedBoundsSchema', contract.seedBoundsSchema, contract.noteBoundsSchema],
  ['seedAnchorSchema', contract.seedAnchorSchema, contract.noteAnchorSchema],
  ['seedPageSchema', contract.seedPageSchema, contract.notePageSchema],
  ['seedViewportSchema', contract.seedViewportSchema, contract.noteViewportSchema],
  ['seedSourceSchema', contract.seedSourceSchema, contract.noteSourceSchema],
  ['seedClientSchema', contract.seedClientSchema, contract.noteClientSchema],
  ['seedReporterSchema', contract.seedReporterSchema, contract.noteReporterSchema],
  ['seedEnvSchema', contract.seedEnvSchema, contract.noteEnvSchema],
  ['seedScreenshotSchema', contract.seedScreenshotSchema, contract.noteScreenshotSchema],
  ['seedStatusSchema', contract.seedStatusSchema, contract.noteStatusSchema],
  ['seedCommentSchema', contract.seedCommentSchema, contract.noteCommentSchema],
  ['seedIssueSchema', contract.seedIssueSchema, contract.noteIssueSchema],
  ['seedAttachmentSchema', contract.seedAttachmentSchema, contract.noteAttachmentSchema],
  ['SEED_ANCHOR_STRATEGIES', contract.SEED_ANCHOR_STRATEGIES, contract.NOTE_ANCHOR_STRATEGIES],
  ['SEED_STAGES', contract.SEED_STAGES, contract.NOTE_STAGES],
  ['DEFAULT_SEED_STAGE', contract.DEFAULT_SEED_STAGE, contract.DEFAULT_NOTE_STAGE],
  ['SEED_BLOCK_CAPTION', contract.SEED_BLOCK_CAPTION, contract.NOTE_BLOCK_CAPTION],
  ['createSeed', contract.createSeed, contract.createNote],
  ['buildSeedBlock', contract.buildSeedBlock, contract.buildNoteBlock],
];

describe('the names of before FRU-378', () => {
  it('are each the value of its new name', () => {
    for (const [name, old, now] of SAME) {
      assert.notEqual(now, undefined, `the new name of ${name} is exported`);
      assert.equal(old, now, name);
    }
  });

  it('parseSeed answers seed where parseNote answers note', () => {
    const note = JSON.parse(JSON.stringify(noteFixture()));

    assert.deepEqual(contract.parseSeed(note), { ok: true, seed: noteFixture() });
    assert.deepEqual(contract.parseNote(note), { ok: true, note: noteFixture() });
  });

  it('parseSeed answers a failure as parseNote does', () => {
    assert.deepEqual(contract.parseSeed({ hello: 'world' }), { ok: false, reason: 'not-found' });
    assert.deepEqual(contract.parseSeed({ ...noteFixture(), v: 9 }), {
      ok: false,
      reason: 'unsupported-version',
      version: 9,
    });
  });

  it('parseSeedFromDescription answers seed where parseNoteFromDescription answers note', () => {
    const description = contract.buildIssueDescription(noteFixture());

    assert.deepEqual(contract.parseSeedFromDescription(description), { ok: true, seed: noteFixture() });
    assert.deepEqual(contract.parseSeedFromDescription(null), { ok: false, reason: 'not-found' });
  });

  it('the fixtures of @fruitback/shared/seed.fixture are those of note.fixture', () => {
    assert.equal(oldFixtures.seedFixture, noteFixture);
    assert.equal(oldFixtures.minimalSeedFixture, minimalNoteFixture);
    assert.equal(oldFixtures.seedIssueFixture, noteIssueFixture);
  });
});
