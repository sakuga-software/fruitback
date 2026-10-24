import { minimalNoteFixture, noteFixture, noteIssueFixture } from './note.fixture.ts';

/**
 * The fixtures of `@fruitback/shared/seed.fixture`, the name of this export before FRU-378. Each one
 * is the fixture of `@fruitback/shared/note.fixture` under its old name. They go in FRU-446.
 */

/** @deprecated Use `noteFixture` of `@fruitback/shared/note.fixture` (FRU-378). */
export const seedFixture = noteFixture;
/** @deprecated Use `minimalNoteFixture` of `@fruitback/shared/note.fixture` (FRU-378). */
export const minimalSeedFixture = minimalNoteFixture;
/** @deprecated Use `noteIssueFixture` of `@fruitback/shared/note.fixture` (FRU-378). */
export const seedIssueFixture = noteIssueFixture;
