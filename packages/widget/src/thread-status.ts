import { NOTE_STAGES, type NoteIssue, type NoteStage } from '@fruitback/shared';
import { createIcon } from './icons.ts';
import type { Translator } from './messages.ts';
import { createStageRing, ringColor } from './stage-ring.ts';
import { stageToken } from './theme.ts';
import { wireMenu } from './thread-more.ts';

/**
 * The status of a note, changed from the head of its thread (FRU-718): the chip of the status becomes a
 * button with a chevron, as the mock-up of the thread draws it, and opens the five stages of Fruitback.
 *
 * Offered only on a note whose read says `canSetStatus`: a member who left it, or a role that manages
 * the sites, on a site whose store keeps statuses. For everybody else the chip stays as FRU-696 drew it,
 * read only. The worker decides again (`POST /feedback/<id>/status`).
 */

/** What the store kept: the stage of the note now, and the key of its status, `own:<stage>`. */
export type StatusAnswer = { stage: NoteStage; status: string };

/** Why a status did not go. `refused`: the worker takes none from this reader on this note now. */
export type StatusFailure = 'retry' | 'wait' | 'signed-out' | 'refused';

/**
 * A seam like the withdrawal's (FRU-605): the overlay does not know the worker. `nameOf`: the name the
 * team gave the built-in status of a stage on this site, or `undefined` for the word of the stage.
 */
export type StatusSeam = {
  send(issue: NoteIssue, stage: NoteStage): Promise<StatusAnswer | StatusFailure>;
  nameOf?(stage: NoteStage): string | undefined;
};

/** What the status menus of the threads share, by note: a head is built again with its thread. */
export type StatusFooter = {
  seam: StatusSeam;
  inFlight: Set<string>;
  said: Map<string, string>;
  /** Draws the thread again; with `kept`, the pins too, with this thread kept open. */
  settled: (issue: NoteIssue, kept?: StatusAnswer) => void;
};

const FAILURES = {
  retry: 'status.failed',
  wait: 'status.failedWait',
  'signed-out': 'status.failedSignedOut',
  refused: 'status.refused',
} as const;

/** The word of a stage in the menu: the name the team gave its built-in status, or the stage's own. */
function nameOf(stage: NoteStage, footer: StatusFooter, t: Translator): string {
  return footer.seam.nameOf?.(stage) || t.stage(stage);
}

/**
 * The chip of the status as a button, and its menu. `chip`: the round and the word the head drew, put
 * inside the button as they are. The items are the five stages, each with its round, the one of the
 * note checked. Taking the checked one closes the menu and sends nothing.
 */
export function statusMenu(
  document: Document,
  issue: NoteIssue,
  t: Translator,
  footer: StatusFooter,
  chip: readonly Element[],
  state: string,
): HTMLElement {
  const id = issue.note.id;
  const wrap = document.createElement('div');
  wrap.className = 'fruitback-thread-status-wrap';
  const menuId = `fruitback-thread-status-${id}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'fruitback-thread-stage';
  trigger.dataset.fruitbackSettable = '';
  trigger.setAttribute('aria-label', t.text('status.open', { state }));
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menuId);
  const sending = footer.inFlight.has(id);
  if (sending) trigger.setAttribute('aria-busy', 'true');
  const chevron = createIcon(document, 'chevron');
  chevron.classList.add('fruitback-thread-status-chevron');
  trigger.append(...chip, chevron);

  const menu = document.createElement('ul');
  menu.className = 'fruitback-thread-more-menu fruitback-thread-status-menu';
  menu.id = menuId;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t.text('status.menu'));
  menu.hidden = true;
  let close: (refocus: boolean) => void = () => undefined;

  const items = NOTE_STAGES.map((stage) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-thread-more-item fruitback-thread-status-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(stage === issue.stage));
    button.tabIndex = -1;
    button.dataset.fruitbackStage = stage;
    const ring = createStageRing(document, stage, 'fruitback-thread-ring');
    ring.style.color = ringColor(stage, undefined, stageToken(stage), 'var(--fruitback-color-text-muted)');
    button.append(ring, nameOf(stage, footer, t));
    button.addEventListener('click', () => {
      close(true);
      if (stage === issue.stage || footer.inFlight.has(id)) return;
      footer.inFlight.add(id);
      footer.said.set(id, t.text('status.saving'));
      footer.settled(issue);
      void footer.seam
        .send(issue, stage)
        .catch((): StatusFailure => 'retry')
        .then((answer) => {
          footer.inFlight.delete(id);
          if (typeof answer === 'string') {
            footer.said.set(id, t.text(FAILURES[answer]));
            footer.settled(issue);

            return;
          }
          footer.said.set(id, t.text('status.done', { state: nameOf(answer.stage, footer, t) }));
          footer.settled(issue, answer);
        });
    });
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    li.append(button);
    menu.append(li);

    return button;
  });

  close = wireMenu(document, { wrap, trigger, menu, items }, Math.max(0, NOTE_STAGES.indexOf(issue.stage)));
  wrap.append(trigger, menu);

  return wrap;
}

/** What the last change of the status said, under the head: on its way, done, or why not. */
export function statusSaid(document: Document, issue: NoteIssue, footer: StatusFooter | undefined): HTMLElement[] {
  const said = footer?.said.get(issue.note.id);
  if (said === undefined) return [];
  const line = document.createElement('p');
  line.className = 'fruitback-thread-status-said';
  line.setAttribute('role', 'status');
  line.textContent = said;

  return [line];
}

/**
 * The stage and the status the store answers, on the issue on screen. The store's word was for the
 * status of before: the name of the new status, or its stage, says it until the next read. What the
 * read offered for the stage of before goes with it: the next read says it again.
 */
export function applyStatus(issue: NoteIssue, answer: StatusAnswer): void {
  issue.stage = answer.stage;
  issue.status = answer.status;
  issue.stateName = '';
  if (answer.stage !== 'done') delete issue.checked;
  if (answer.stage === 'done' || answer.stage === 'closed') {
    delete issue.editable;
    delete issue.withdrawable;
  }
}
