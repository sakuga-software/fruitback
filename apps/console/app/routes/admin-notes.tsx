import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type InstanceNote, type InstanceNotes, STAGES, type Stage, instanceNotes } from '../api';
import { ago } from '../ago';
import { msg, t } from '../i18n';
import { Choice, DataTable, Field, Lead, LinkButton, StatusDot, Title } from '../ui';
import { useTypedSearch } from '../typed-search';
import { useLocale } from '../use-locale';
import { KINDS, STAGE_NAMES } from './connector-parts';
import { NotePages, NotesFailed, Reference, excerptOf } from './notes';
import { siteLabel } from '../site-address';

/**
 * Every note of the instance, and where it is stored now: screen 20 of the mockup of 2026-10-13
 * (FRU-273), read from `GET /console/admin/notes` (FRU-272). The screen sends no write.
 *
 * WARNING: each read writes a trace in each workspace of the page that the administrator is not a
 * member of, and its owners read it. The screen says so under its lead.
 */

/** The filters of the screen, in its address: `?workspace=<id>` comes from the Workspaces screen. */
const FILTERS = ['workspace', 'stage', 'q'] as const;
type Filters = Record<(typeof FILTERS)[number], string>;

const AUTHOR_WORDS: Readonly<Record<InstanceNote['author']['kind'], string>> = {
  visitor: msg('Visitor'),
  member: msg('Member'),
  site: msg('Verified by {site}'),
  verified: msg('Verified'),
};

const isStage = (stage: string): stage is Stage => (STAGES as readonly string[]).includes(stage);

/** The name of the tool a note went to: the kind the console knows, else the name of the connector. */
function toolOf(place: { kind: string; label?: string }): string {
  const known = (KINDS as Readonly<Record<string, { name: string }>>)[place.kind];

  return known === undefined ? (place.label ?? place.kind) : t(known.name);
}

export default function AdminNotes() {
  useLocale();
  const [params, setParams] = useSearchParams();
  // The address as the last change wrote it: the search writes it 300 ms after its key.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);

  const filters = useMemo(
    () => Object.fromEntries(FILTERS.map((name) => [name, params.get(name) ?? ''])) as Filters,
    [params],
  );
  const cursor = params.get('cursor') ?? '';
  const from = Math.max(1, Number(params.get('from')) || 1);

  // A read again keeps the rows on the screen until its answer comes: only the first read says « Loading… ».
  const [shown, setShown] = useState<InstanceNotes | 'loading' | 'failed'>('loading');
  const [reading, setReading] = useState(false);
  const [before, setBefore] = useState<string[]>([]);
  // The workspaces that the answers named. A read of `/console/admin/workspaces` would leave a trace
  // in every workspace of the instance, so the filter lists only the workspaces that this screen saw.
  const [workspaces, setWorkspaces] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(0);

  const read = useCallback(async () => {
    const mine = (asked.current += 1);
    setReading(true);
    const query = new URLSearchParams();
    for (const name of FILTERS) if (filters[name] !== '') query.set(name, filters[name]);
    if (cursor !== '') query.set('cursor', cursor);
    const answer = await instanceNotes(query);
    // An answer to a question that is no longer asked is dropped: the filters moved on.
    if (mine !== asked.current) return;
    setReading(false);
    if (!answer.ok || !Array.isArray(answer.data?.notes)) return setShown('failed');
    const { notes } = answer.data;
    setShown(answer.data);
    setWorkspaces((known) => {
      const unknown = notes.filter((note) => known.get(note.workspace.id) !== note.workspace.name);
      if (unknown.length === 0) return known;

      return new Map([...known, ...unknown.map((note) => [note.workspace.id, note.workspace.name] as const)]);
    });
  }, [filters, cursor]);
  useEffect(() => void read(), [read]);

  /** Sets filters, and goes back to the first page: a page of another list means nothing. */
  function filter(changes: Partial<Filters>, replace = false) {
    setBefore([]);
    const next = new URLSearchParams(latest.current);
    for (const [name, value] of Object.entries(changes)) {
      if (value === '' || value === undefined) next.delete(name);
      else next.set(name, value);
    }
    next.delete('cursor');
    next.delete('from');
    latest.current = next;
    setParams(next, { replace });
  }

  function page(to: 'next' | 'previous', answer: InstanceNotes) {
    const next = new URLSearchParams(params);
    if (to === 'next' && answer.next !== undefined) {
      setBefore((pages) => [...pages, cursor]);
      next.set('cursor', answer.next);
      next.set('from', String(from + answer.notes.length));
    } else {
      const back = before.at(-1) ?? '';
      setBefore((pages) => pages.slice(0, -1));
      if (back === '') next.delete('cursor');
      else next.set('cursor', back);
      const at = from - answer.notes.length;
      if (back === '' || at <= 1) next.delete('from');
      else next.set('from', String(at));
    }
    setParams(next);
  }

  const [typed, setTyped] = useTypedSearch(filters.q, (q) => filter({ q }, true));

  const filtered = FILTERS.some((name) => filters[name] !== '');
  // The workspace of the address is an option before any answer names it.
  const workspaceOptions = [...workspaces].map(([id, name]) => ({ value: id, label: name }));
  if (filters.workspace !== '' && !workspaces.has(filters.workspace))
    workspaceOptions.push({ value: filters.workspace, label: filters.workspace });

  return (
    <>
      <header className="mb-[24px]">
        <Title>{t('Notes')}</Title>
        <Lead className="mt-[6px]">{t('Every note left on this instance, and where it is stored now.')}</Lead>
        <p className="mt-[8px] max-w-[64ch] text-small text-muted">
          {t('The owners of each workspace see that you read its notes, with your address and the day.')}
        </p>
      </header>

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

      {shown === 'failed' ? <NotesFailed onRetry={() => void read()} /> : null}

      {typeof shown === 'object' && shown.total === 0 && !filtered ? (
        <p className="max-w-[640px] text-body text-muted">{t('No note on this instance yet.')}</p>
      ) : null}

      {typeof shown === 'object' && (shown.total > 0 || filtered) ? (
        <>
          <div className="mb-[16px] flex flex-wrap items-center gap-[10px]">
            <div className="min-w-0 flex-[999_1_260px]">
              <Field
                label={t('Search notes')}
                labelHidden
                compact
                type="search"
                // What the route searches (`ADMIN_NOTES_SEARCHED` of FRU-272).
                placeholder={t('Search the text, the page, the site, the workspace, the status or the reference')}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div className="min-w-0 flex-[1_1_180px]">
              <Choice
                label={t('Workspace')}
                labelHidden
                compact
                value={filters.workspace === '' ? 'every' : filters.workspace}
                onChange={(workspace) => filter({ workspace: workspace === 'every' ? '' : workspace })}
                options={[{ value: 'every', label: t('Every workspace') }, ...workspaceOptions]}
              />
            </div>
            <div className="min-w-0 flex-[1_1_160px]">
              <Choice
                label={t('Status')}
                labelHidden
                compact
                value={filters.stage === '' ? 'any' : filters.stage}
                onChange={(stage) => filter({ stage: stage === 'any' ? '' : stage })}
                options={[
                  { value: 'any', label: t('Any status') },
                  ...STAGES.map((stage) => ({ value: stage, label: t(STAGE_NAMES[stage]) })),
                ]}
              />
            </div>
          </div>

          {shown.notes.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-[12px] text-body text-muted">
              <p>{t('No note matches.')}</p>
              <LinkButton
                onClick={() => {
                  setTyped('');
                  filter({ workspace: '', stage: '', q: '' });
                }}
              >
                {t('Clear the filters')}
              </LinkButton>
            </div>
          ) : (
            <>
              <div aria-busy={reading}>
                <DataTable label={t('Notes of the instance')} minWidth={980} hover>
                  <thead>
                    <tr>
                      <th scope="col">{t('Note')}</th>
                      <th scope="col">{t('Workspace')}</th>
                      <th scope="col">{t('Status')}</th>
                      <th scope="col">{t('Left by')}</th>
                      <th scope="col">{t('Stored in')}</th>
                      <th scope="col" data-align="end">
                        {t('When')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.notes.map((note) => (
                      <NoteRow key={note.id} note={note} />
                    ))}
                  </tbody>
                </DataTable>
              </div>
              <NotePages
                from={from}
                shown={shown.notes.length}
                total={shown.total}
                first={cursor === ''}
                last={shown.next === undefined}
                onPage={(to) => page(to, shown)}
              />
            </>
          )}
        </>
      ) : null}
    </>
  );
}

function NoteRow({ note }: { note: InstanceNote }) {
  useLocale();
  const { author, place } = note;
  const host = siteLabel(note.site.origin);

  return (
    <tr>
      <td className="max-w-[380px]">
        <NoteText note={note} />
        <span className="mt-[2px] block text-hint text-muted [overflow-wrap:anywhere]">{`${note.page.host}${note.page.path}`}</span>
      </td>
      <td className="[overflow-wrap:anywhere]">{note.workspace.name}</td>
      <td className="whitespace-nowrap">
        {isStage(note.stage) ? (
          <span className="inline-flex items-center gap-[8px]">
            <StatusDot status={note.stage} size={10} />
            {t(STAGE_NAMES[note.stage])}
          </span>
        ) : (
          note.stage
        )}
      </td>
      <td className="[overflow-wrap:anywhere]">
        {t(AUTHOR_WORDS[author.kind] ?? AUTHOR_WORDS.visitor, { site: host })}
      </td>
      <td>
        {place.kind === 'fruitback' ? <span className="block font-semibold">{t('In Fruitback')}</span> : null}
        {place.kind === 'removed' ? (
          <span className="block font-semibold">{t('A connector that was removed')}</span>
        ) : null}
        {place.kind !== 'fruitback' && place.kind !== 'removed' ? (
          <>
            <span className="block font-semibold">{toolOf(place)}</span>
            <Reference reference={note.ref} address={note.url} />
          </>
        ) : null}
      </td>
      <td data-align="end" className="whitespace-nowrap text-muted tabular-nums">
        {ago(note.createdAt)}
      </td>
    </tr>
  );
}

/**
 * The text of a note that Fruitback keeps. A note that went to another tool is read there: Fruitback
 * keeps its first 64 characters, and the line under them says so.
 */
function NoteText({ note }: { note: InstanceNote }) {
  useLocale();
  const { place } = note;
  if (note.text !== undefined) return <span className="line-clamp-2 [overflow-wrap:anywhere]">{note.text}</span>;

  return (
    <>
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{excerptOf(note.excerpt)}</span>
      {place.kind === 'fruitback' ? null : (
        <span className="mt-[2px] block text-hint text-muted">
          {place.kind === 'removed'
            ? t('Kept in a connector that was removed. Fruitback keeps the first 64 characters.')
            : t('Kept in {tool}. Fruitback keeps the first 64 characters.', { tool: toolOf(place) })}
        </span>
      )}
    </>
  );
}
