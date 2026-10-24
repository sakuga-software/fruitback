import {
  type Note,
  type NoteAnchor,
  type NoteAnchorStrategy,
  type NoteBounds,
  type NoteClient,
  type NoteEnv,
  type NoteInput,
  type NoteParseFailure,
  type NotePage,
  type NoteReporter,
  type NoteScreenshot,
  type NoteSource,
  type NoteViewport,
  NOTE_ANCHOR_STRATEGIES,
  createNote,
  noteAnchorSchema,
  noteBoundsSchema,
  noteClientSchema,
  noteEnvSchema,
  notePageSchema,
  noteReporterSchema,
  noteSchema,
  noteScreenshotSchema,
  noteSourceSchema,
  noteViewportSchema,
  parseNote,
} from './note.ts';
import {
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  type NoteStatus,
  DEFAULT_NOTE_STAGE,
  NOTE_STAGES,
  noteCommentSchema,
  noteIssueSchema,
  noteStatusSchema,
} from './issue.ts';
import { NOTE_BLOCK_CAPTION, buildNoteBlock, parseNoteFromDescription } from './markdown-description.ts';
import { type NoteAttachment, noteAttachmentSchema } from './attachments.ts';

/**
 * The names of the contract before FRU-378, when a note was a « seed ». Each one is the new name
 * under the old one, so a consumer of 0.3.0 keeps building. They go in FRU-446.
 *
 * Only the two parsers differ: they answer `{ ok: true, seed }`, where the new ones answer
 * `{ ok: true, note }`.
 */

/** @deprecated Use `Note` (FRU-378). */
export type Seed = Note;
/** @deprecated Use `NoteAnchor` (FRU-378). */
export type SeedAnchor = NoteAnchor;
/** @deprecated Use `NoteAnchorStrategy` (FRU-378). */
export type SeedAnchorStrategy = NoteAnchorStrategy;
/** @deprecated Use `NoteBounds` (FRU-378). */
export type SeedBounds = NoteBounds;
/** @deprecated Use `NotePage` (FRU-378). */
export type SeedPage = NotePage;
/** @deprecated Use `NoteViewport` (FRU-378). */
export type SeedViewport = NoteViewport;
/** @deprecated Use `NoteSource` (FRU-378). */
export type SeedSource = NoteSource;
/** @deprecated Use `NoteClient` (FRU-378). */
export type SeedClient = NoteClient;
/** @deprecated Use `NoteReporter` (FRU-378). */
export type SeedReporter = NoteReporter;
/** @deprecated Use `NoteEnv` (FRU-378). */
export type SeedEnv = NoteEnv;
/** @deprecated Use `NoteScreenshot` (FRU-378). */
export type SeedScreenshot = NoteScreenshot;
/** @deprecated Use `NoteInput` (FRU-378). */
export type SeedInput = NoteInput;
/** @deprecated Use `NoteParseFailure` (FRU-378). */
export type SeedParseFailure = NoteParseFailure;
/** @deprecated Use `NoteParseResult` (FRU-378): it answers `note` where this one answers `seed`. */
export type SeedParseResult = { ok: true; seed: Note } | NoteParseFailure;
/** @deprecated Use `NoteStage` (FRU-378). */
export type SeedStage = NoteStage;
/** @deprecated Use `NoteStatus` (FRU-378). */
export type SeedStatus = NoteStatus;
/** @deprecated Use `NoteComment` (FRU-378). */
export type SeedComment = NoteComment;
/** @deprecated Use `NoteIssue` (FRU-378). */
export type SeedIssue = NoteIssue;
/** @deprecated Use `NoteAttachment` (FRU-378). */
export type SeedAttachment = NoteAttachment;

/** @deprecated Use `noteSchema` (FRU-378). */
export const seedSchema = noteSchema;
/** @deprecated Use `noteBoundsSchema` (FRU-378). */
export const seedBoundsSchema = noteBoundsSchema;
/** @deprecated Use `noteAnchorSchema` (FRU-378). */
export const seedAnchorSchema = noteAnchorSchema;
/** @deprecated Use `notePageSchema` (FRU-378). */
export const seedPageSchema = notePageSchema;
/** @deprecated Use `noteViewportSchema` (FRU-378). */
export const seedViewportSchema = noteViewportSchema;
/** @deprecated Use `noteSourceSchema` (FRU-378). */
export const seedSourceSchema = noteSourceSchema;
/** @deprecated Use `noteClientSchema` (FRU-378). */
export const seedClientSchema = noteClientSchema;
/** @deprecated Use `noteReporterSchema` (FRU-378). */
export const seedReporterSchema = noteReporterSchema;
/** @deprecated Use `noteEnvSchema` (FRU-378). */
export const seedEnvSchema = noteEnvSchema;
/** @deprecated Use `noteScreenshotSchema` (FRU-378). */
export const seedScreenshotSchema = noteScreenshotSchema;
/** @deprecated Use `noteStatusSchema` (FRU-378). */
export const seedStatusSchema = noteStatusSchema;
/** @deprecated Use `noteCommentSchema` (FRU-378). */
export const seedCommentSchema = noteCommentSchema;
/** @deprecated Use `noteIssueSchema` (FRU-378). */
export const seedIssueSchema = noteIssueSchema;
/** @deprecated Use `noteAttachmentSchema` (FRU-378). */
export const seedAttachmentSchema = noteAttachmentSchema;

/** @deprecated Use `NOTE_ANCHOR_STRATEGIES` (FRU-378). */
export const SEED_ANCHOR_STRATEGIES = NOTE_ANCHOR_STRATEGIES;
/** @deprecated Use `NOTE_STAGES` (FRU-378). */
export const SEED_STAGES = NOTE_STAGES;
/** @deprecated Use `DEFAULT_NOTE_STAGE` (FRU-378). */
export const DEFAULT_SEED_STAGE = DEFAULT_NOTE_STAGE;
/** @deprecated Use `NOTE_BLOCK_CAPTION` (FRU-378). */
export const SEED_BLOCK_CAPTION = NOTE_BLOCK_CAPTION;

/** @deprecated Use `createNote` (FRU-378). */
export const createSeed = createNote;
/** @deprecated Use `buildNoteBlock` (FRU-378). */
export const buildSeedBlock = buildNoteBlock;

/** @deprecated Use `parseNote` (FRU-378), which answers `note` where this one answers `seed`. */
export function parseSeed(value: unknown): SeedParseResult {
  return withSeed(parseNote(value));
}

/** @deprecated Use `parseNoteFromDescription` (FRU-378), which answers `note` where this one answers `seed`. */
export function parseSeedFromDescription(description: string | null | undefined): SeedParseResult {
  return withSeed(parseNoteFromDescription(description));
}

function withSeed(result: ReturnType<typeof parseNote>): SeedParseResult {
  return result.ok ? { ok: true, seed: result.note } : result;
}
