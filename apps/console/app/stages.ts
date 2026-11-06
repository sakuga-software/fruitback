import { NOTE_STAGES, type NoteStage } from '@fruitback/shared';
import { msg } from './i18n.ts';

/**
 * The five stages of a note, in the order of the widget (FRU-508).
 *
 * The contract names them once, in `@fruitback/shared`. The console used to write the list twice
 * more, in `api.ts` and in `ui.tsx`.
 */
export const STAGES = NOTE_STAGES;
export type Stage = NoteStage;

/** The names of the five stages, as the widget shows them on a pin. */
export const STAGE_NAMES: Readonly<Record<Stage, string>> = {
  new: msg('New'),
  todo: msg('To do'),
  progress: msg('In progress'),
  done: msg('Done'),
  closed: msg('Closed'),
};

/** Whether a word the worker sent is one of the five stages. */
export function isStage(word: string): word is Stage {
  return (STAGES as readonly string[]).includes(word);
}
