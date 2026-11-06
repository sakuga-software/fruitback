import { useState } from 'react';
import { STAGE_NAMES, type Stage } from '../stages';
import { type Answer, type Connector, call } from '../api';
import { ago } from '../ago';
import { Button, DataTable, IconLink, Problem, StatusDot } from '../ui';
import { t } from '../i18n';
import { failureOf, writeProblemOf } from '../problems';
import { useLocale } from '../use-locale';
import { domainOf } from '../site-address';
import { NoteIcon } from '../note-icons';
import { type StatusChoice } from '../note-status';
import { type IndexedNote, type NotesAnswer, groupsOf } from './notes-model';
import { Author, NoteStatus, Place, excerptOf } from './note-parts';

export function NoteRow({
  note,
  origin,
  source,
  manages,
  retry,
  onSent,
  onStatusSaved,
  statuses,
  choose,
}: {
  note: IndexedNote;
  /** The origin of the site of the note, when the sites were read. */
  origin: string | undefined;
  /** The connector the note went to, when the connectors were read: it may have a name (FRU-404). */
  source: Connector | undefined;
  manages: boolean;
  retry: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  onSent: () => void;
  /** A status saved from the drop: the list is read again, and the focus follows the row. */
  onStatusSaved: () => void;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
}) {
  useLocale();
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  // A status the worker did not save (FRU-551): said under the note, the select keeps the choice.
  const [statusRefused, setStatusRefused] = useState<string | undefined>();
  const { author, place } = note;
  // The link of the widget opens the note by the id it gave it, or by its issue (FRU-253).
  const opened = note.note ?? note.ref;
  const show = opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
  // FRU-547: the site is its domain and its extension, `fruitback.com` for `app.fruitback.com`.
  const domain = domainOf(origin ?? note.page.host);

  async function send() {
    setSending(true);
    setRefused(undefined);
    const sent = await retry();
    setSending(false);
    if (!sent.ok) return setRefused(writeProblemOf(sent, failureOf(sent)));
    onSent();
  }

  return (
    <tr data-note={note.id}>
      {/* The note keeps 240 px of the row: the columns beside it are short words. */}
      <td className="max-w-[380px] min-[640px]:min-w-[240px]">
        {/* FRU-551: the status is its drop before the note, a list of the statuses for whoever may
          change it; the group above says it in words. */}
        <span className="flex items-start gap-[8px]">
          <span className="-my-[4px] flex h-[28px] w-[28px] flex-none items-center justify-center">
            <NoteStatus
              note={note}
              statuses={statuses}
              choose={choose}
              onSaved={onStatusSaved}
              onRefused={setStatusRefused}
              bare
            />
          </span>
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{excerptOf(note.excerpt)}</span>
        </span>
        {statusRefused === undefined ? null : (
          <span className="mt-[6px] block pl-[36px]">
            <Problem>{t(statusRefused)}</Problem>
          </span>
        )}
      </td>
      <td className="whitespace-nowrap">
        <span className="block max-w-[140px] truncate">{domain}</span>
      </td>
      <td className="max-w-[160px]">
        <Author author={author} site={domain} />
      </td>
      {place === undefined ? null : (
        <td>
          <Place
            place={place}
            source={source}
            reference={note.ref}
            address={note.url}
            late={note.delivery !== undefined}
          />
          {note.delivery === undefined ? null : (
            <span className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-hint">
              {/* The worker stopped trying (FRU-122): « Send again » still sends it, and the words say why
                it will not arrive by itself. */}
              <span className="font-semibold text-accent">
                {note.delivery.state === 'gave-up'
                  ? t('Not delivered: Fruitback stopped trying')
                  : t('Not delivered yet')}
              </span>
              {manages ? (
                <Button tone="outline" size="small" disabled={sending} onClick={() => void send()}>
                  {t('Send again')}
                </Button>
              ) : null}
            </span>
          )}
          {refused === undefined ? null : <Problem>{t(refused)}</Problem>}
        </td>
      )}
      <td data-align="end" className="whitespace-nowrap text-muted tabular-nums">
        {ago(note.createdAt)}
      </td>
      <td data-align="end">
        {/* FRU-546: the page of the note, in a new tab, its address in the tooltip. */}
        <IconLink label={t('Show on the page')} href={show} tip={note.page.url}>
          <NoteIcon name="open" />
        </IconLink>
      </td>
    </tr>
  );
}

/**
 * The table of the notes (FRU-245): a group per status (FRU-551), its head the drop, the name and the
 * notes of the whole list in it.
 */
export function NotesTable({
  notes,
  counts,
  statuses,
  seesTracker,
  manages,
  reading,
  base,
  originOf,
  sourceOf,
  choose,
  onSent,
  onStatusSaved,
}: {
  notes: readonly IndexedNote[];
  counts: NotesAnswer['counts'];
  statuses: NotesAnswer['statuses'];
  seesTracker: boolean;
  manages: boolean;
  /** A read again is on its way: the rows stay, and say they are busy. */
  reading: boolean;
  /** `/console/workspaces/<id>`. */
  base: string;
  originOf: (site: string) => string | undefined;
  sourceOf: (note: IndexedNote) => Connector | undefined;
  choose: (note: IndexedNote, status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  /** A note sent again to its address: the list is read again. */
  onSent: () => void;
  /** A status saved from the drop of a row, by the id of its note: the focus follows the row. */
  onStatusSaved: (note: string) => void;
}) {
  useLocale();

  return (
    <div aria-busy={reading}>
      <DataTable label={t('Notes')} minWidth={720} hover stack pinned>
        <thead>
          <tr>
            <th scope="col">{t('Note')}</th>
            <th scope="col">{t('Site')}</th>
            <th scope="col">{t('Left by')}</th>
            {/* The worker tells a guest nothing of where a note went (FRU-244). */}
            {seesTracker ? <th scope="col">{t('Went to')}</th> : null}
            <th scope="col" data-align="end">
              {t('When')}
            </th>
            {/* The column of the link to the page (FRU-546): its head is for a screen reader. */}
            <th scope="col" className="w-[56px]">
              <span className="sr-only">{t('Page')}</span>
            </th>
          </tr>
        </thead>
        {/* FRU-551: a group per status, its head the drop, the name and the notes of the
          whole list in it. A group that goes on to the next page has its head there too. */}
        {groupsOf(notes).map((group) => (
          <tbody key={group.stage} data-group={group.stage}>
            <tr className="kit-table-group">
              <th scope="colgroup" colSpan={seesTracker ? 6 : 5}>
                <span className="inline-flex items-center gap-[8px]">
                  <StatusDot status={group.stage} size={10} />
                  {t(STAGE_NAMES[group.stage])}
                  {/* The notes of the whole list in the group. A worker that does not
                    count them gets no number: the notes of one page are no count. */}
                  {counts.byStage?.[group.stage] === undefined ? null : (
                    <span className="font-normal text-muted tabular-nums">{counts.byStage[group.stage]}</span>
                  )}
                </span>
              </th>
            </tr>
            {group.notes.map((note) => (
              <NoteRow
                key={`${note.id} ${note.status ?? note.stage}`}
                note={note}
                origin={originOf(note.site.id)}
                source={sourceOf(note)}
                manages={manages}
                retry={() => call('POST', `${base}/notes/${encodeURIComponent(note.id)}/retry`)}
                statuses={statuses?.[note.site.id]}
                choose={(status) => choose(note, status)}
                onSent={onSent}
                onStatusSaved={() => onStatusSaved(note.id)}
              />
            ))}
          </tbody>
        ))}
      </DataTable>
    </div>
  );
}
