import { STAGES, type Stage } from './api.ts';
import type { StatusChoice } from './note-status.ts';

/**
 * The columns of the board of the notes (FRU-436), from the notes that are shown and the statuses of
 * the site in view. It knows no React and no network.
 *
 * With the statuses of one site, a column is a status, in the order of the site: the hidden ones only
 * when a note is in one, since no note can be put there. A note kept by Fruitback goes to its status.
 * A note of a tracker has a stage only: it goes to the built-in status of that stage (`own:<stage>`),
 * else to the first shown status of that stage. Without the statuses of one site (several sites, or no
 * note kept by Fruitback), a column is a stage, in the order of the stages.
 */

/** What the board needs of a note: the index gives more. */
export type BoardNote = { id: string; stage: Stage; status?: string };

export type BoardColumn<Note extends BoardNote> = {
  /** The key of its status, or `stage:<stage>`. */
  key: string;
  stage: Stage;
  /** The status of the column; absent for a column of a stage. */
  status?: StatusChoice;
  notes: Note[];
};

export function boardColumns<Note extends BoardNote>(
  notes: readonly Note[],
  statuses: readonly StatusChoice[] | undefined,
): BoardColumn<Note>[] {
  if (statuses === undefined || statuses.length === 0) {
    return STAGES.map((stage) => ({
      key: `stage:${stage}`,
      stage,
      notes: notes.filter((note) => note.stage === stage),
    }));
  }

  const columns = new Map<string, BoardColumn<Note>>(
    statuses.map((status) => [status.key, { key: status.key, stage: status.stage, status, notes: [] }]),
  );
  const shown = (status: StatusChoice) => status.hidden !== true;
  const ofStage = (stage: Stage): string | undefined => {
    const builtIn = statuses.find((status) => status.key === `own:${stage}` && shown(status));

    return (builtIn ?? statuses.find((status) => status.stage === stage && shown(status)))?.key;
  };
  // A stage that no shown status takes: a column of its own, after the statuses.
  const extra = new Map<Stage, BoardColumn<Note>>();
  for (const note of notes) {
    const key = note.status !== undefined && columns.has(note.status) ? note.status : ofStage(note.stage);
    const column = key === undefined ? undefined : columns.get(key);
    if (column !== undefined) {
      column.notes.push(note);
      continue;
    }
    const fallback = extra.get(note.stage) ?? { key: `stage:${note.stage}`, stage: note.stage, notes: [] };
    fallback.notes.push(note);
    extra.set(note.stage, fallback);
  }

  return [
    ...[...columns.values()].filter((column) => shown(column.status!) || column.notes.length > 0),
    ...STAGES.flatMap((stage) => extra.get(stage) ?? []),
  ];
}

/** Whether a note can be put in a column: a column of a status that is shown. */
export function takesNotes(column: BoardColumn<BoardNote>): boolean {
  return column.status !== undefined && column.status.hidden !== true;
}
