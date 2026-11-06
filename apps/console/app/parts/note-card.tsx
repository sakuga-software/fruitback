import { useState } from 'react';
import { type Stage } from '../stages';
import { type Answer, type Connector } from '../api';
import { ago } from '../ago';
import { IconLink, Problem } from '../ui';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { NoteIcon } from '../note-icons';
import { type StatusChoice } from '../note-status';
import { type IndexedNote } from './notes-model';
import { NoteStatus, Place, excerptOf } from './note-parts';

/**
 * A note on the board (FRU-436): what a row of the table says, one under the other.
 *
 * FRU-589: the card writes no status, as its column says it. Whoever may change the status gets the
 * drop of the table after the note: the select that is the way of the keyboard to another column.
 * FRU-588: the card writes no address. The page opens from the icon at its foot, its address in the
 * tooltip, as in the table.
 */
export function NoteCard({
  note,
  source,
  seesTracker,
  statuses,
  choose,
  onSaved,
}: {
  note: IndexedNote;
  source: Connector | undefined;
  seesTracker: boolean;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  onSaved: () => void;
}) {
  useLocale();
  // A status the worker did not save: said under the note, the select keeps the choice.
  const [statusRefused, setStatusRefused] = useState<string | undefined>();
  const opened = note.note ?? note.ref;
  const show = opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
  const visitor = note.author.kind === 'verified' || note.author.kind === 'anonymous';
  const who = visitor ? t('Visitor') : (note.author.name ?? t('Somebody of the workspace'));
  // When `NoteStatus` draws a select. Any other status is only words, and the column says them.
  const settable = note.canSetStatus === true && note.status !== undefined && statuses !== undefined;

  return (
    <div className="flex flex-col gap-[8px]">
      <div>
        <div className="flex items-start gap-[8px] text-body">
          <span className="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]">{excerptOf(note.excerpt)}</span>
          {/* At the right: the text of every card of a column starts at one edge, with a select or not. */}
          {settable ? (
            <span className="-my-[4px] flex h-[28px] w-[28px] flex-none items-center justify-center">
              {/* Keyed by the status read: a read again that says another status starts the select from it. */}
              <NoteStatus
                key={note.status ?? note.stage}
                note={note}
                statuses={statuses}
                choose={choose}
                onSaved={() => {
                  // `NoteStatus` clears the refusal before each try; a save clears it here too.
                  setStatusRefused(undefined);
                  onSaved();
                }}
                onRefused={setStatusRefused}
                bare
              />
            </span>
          ) : null}
        </div>
        {statusRefused === undefined ? null : (
          <span className="mt-[6px] block">
            <Problem>{t(statusRefused)}</Problem>
          </span>
        )}
      </div>
      {seesTracker && note.place !== undefined ? (
        <div className="text-hint">
          <Place
            place={note.place}
            source={source}
            reference={note.ref}
            address={note.url}
            late={note.delivery !== undefined}
          />
          {note.delivery === undefined ? null : (
            <span className="font-semibold text-accent">
              {note.delivery.state === 'gave-up'
                ? t('Not delivered: Fruitback stopped trying')
                : t('Not delivered yet')}
            </span>
          )}
        </div>
      ) : null}
      <div className="flex items-center gap-x-[12px] text-hint text-muted">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{who}</span>
        <span className="tabular-nums">{ago(note.createdAt)}</span>
        {/* FRU-588: the page of the note in a new tab, its address in the tooltip, as in the table. */}
        <IconLink label={t('Show on the page')} href={show} tip={note.page.url}>
          <NoteIcon name="open" />
        </IconLink>
      </div>
    </div>
  );
}
