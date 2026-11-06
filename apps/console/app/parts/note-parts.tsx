import { type ReactNode, useState } from 'react';
import { STAGE_NAMES, type Stage } from '../stages';
import { type Answer, type Connector } from '../api';
import { Choice, LoadFailed, Mark, Problem, StatusDot, Tip } from '../ui';
import { KINDS, connectorName } from './connector-parts';
import { ConnectorMark } from '../connector-marks';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { useLocale } from '../use-locale';
import { NoteIcon } from '../note-icons';
import { STATUS_NOT_SAVED, STATUS_PROBLEMS, type StatusChoice, offeredFor, statusName } from '../note-status';
import { ReadProblem } from '../read-problem';
import { type IndexedNote, type NoteAuthor, type NotePlace } from './notes-model';

const AUTHOR_WORDS: Readonly<Record<NoteAuthor['kind'], string>> = {
  you: msg('You'),
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
  'former-member': msg('Former member'),
  verified: msg('Verified by {site}'),
  anonymous: msg('Anonymous'),
};

/** What Fruitback keeps of the text of a note: its first 64 characters (Q6, FRU-237). */
const EXCERPT = 64;

/**
 * The excerpt as a person reads it: one that fills its 64 characters was cut, and says so with « … ».
 * One of 64 characters exactly that was the whole note reads « … » too: the index does not say.
 */
export function excerptOf(excerpt: string): string {
  return [...excerpt].length >= EXCERPT ? `${excerpt.trimEnd()}…` : excerpt;
}

/** The host of the address of a REST connector, from its name: « hooks.acme.dev/feedback ». */
export function hostOfLabel(label: string | undefined): string | undefined {
  const address = label
    ?.split(' · ')
    .at(-1)
    ?.replace(/^https?:\/\//, '');
  const host = address?.split('/')[0];

  return host === undefined || host === '' ? undefined : host;
}

/**
 * Who left a note (FRU-553): the icon of their role, then their name cut to its room. The tooltip,
 * under the pointer, says the name whole and the role; a screen reader reads both in the cell.
 */
export function Author({ author, site }: { author: NoteAuthor; site: string }) {
  useLocale();
  const visitor = author.kind === 'verified' || author.kind === 'anonymous';
  const who = visitor ? t('Visitor') : (author.name ?? t('Somebody of the workspace'));
  const role = author.kind === 'verified' ? t(AUTHOR_WORDS.verified, { site }) : t(AUTHOR_WORDS[author.kind]);

  return (
    <Tip tip={`${who} · ${role}`}>
      <span className="text-muted">
        <NoteIcon name={author.kind} />
      </span>
      <span className="min-w-0 truncate">{who}</span>
      <span className="sr-only">{`, ${role}`}</span>
    </Tip>
  );
}

/**
 * The status of a note (FRU-384). A note the worker keeps shows its status by name; to its author, and
 * to an owner or an admin, as a select of the site's statuses. A note of a tracker shows its stage: its
 * status changes in the tracker.
 *
 * The select shows what the person chose at once. Refused, it keeps that choice and says why under
 * it, so that nothing chosen is silently undone; saved, the row takes the stage the worker answered.
 */
export function NoteStatus({
  note,
  statuses,
  choose,
  onSaved,
  bare = false,
  onRefused,
}: {
  note: IndexedNote;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  /** Saved: the board reads the notes again, and the card goes to its column (FRU-436). */
  onSaved?: () => void;
  /**
   * The drop alone, its words for a screen reader (FRU-551): the status of a row of the table, and of
   * a card of the board (FRU-589).
   */
  bare?: boolean;
  /**
   * Where a refusal is said, for a bare select: under the note, where there is room for it. Called
   * with `undefined` before each try, so a try clears the refusal of before; then, on a refusal, with
   * the sentence of `problemOf`: an English sentence, the key that `messages.fr.ts` maps, which
   * the caller shows through `t()`.
   */
  onRefused?: (refusal: string | undefined) => void;
}) {
  useLocale();
  const [chosen, setChosen] = useState(note.status);
  const [stage, setStage] = useState(note.stage);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  const stageName = (of: Stage) => t(STAGE_NAMES[of]);
  const current = chosen === undefined ? undefined : statuses?.find((status) => status.key === chosen);

  // The refusal goes to the caller when it shows it (`onRefused`), else under this select.
  const refuse = (refusal: string | undefined) => (onRefused === undefined ? setRefused(refusal) : onRefused(refusal));

  async function save(status: string) {
    setChosen(status);
    setSaving(true);
    refuse(undefined);
    const answer = await choose(status);
    setSaving(false);
    if (!answer.ok) return refuse(problemOf(answer, STATUS_PROBLEMS, STATUS_NOT_SAVED));
    setStage(answer.data.stage);
    onSaved?.();
  }

  const words = (text: string) => (bare ? <span className="sr-only">{text}</span> : text);
  // A note of a tracker, or a list read without the statuses of the site: the stage.
  if (chosen === undefined || statuses === undefined || (current === undefined && note.canSetStatus !== true)) {
    return (
      <span className="inline-flex items-center gap-[8px]" data-status-of-note>
        <StatusDot status={stage} size={10} />
        {words(stageName(stage))}
      </span>
    );
  }
  if (note.canSetStatus !== true) {
    return (
      <span className="inline-flex items-center gap-[8px]" data-status-of-note>
        <StatusDot status={current?.stage ?? stage} size={10} color={current?.color} />
        {words(current === undefined ? stageName(stage) : statusName(current, stageName))}
      </span>
    );
  }

  return (
    // A fixed width: a refusal wraps under the select and never widens the column.
    <div className={bare ? '' : 'w-[200px]'}>
      <Choice
        label={t('Status of this note')}
        labelHidden
        compact
        bare={bare}
        disabled={saving}
        status={current?.stage ?? stage}
        value={chosen}
        onChange={(status) => void save(status)}
        options={offeredFor(statuses, chosen).map((status) => ({
          value: status.key,
          label: statusName(status, stageName),
          drop: { status: status.stage, ...(status.color === undefined ? {} : { color: status.color }) },
        }))}
      />
      {refused === undefined ? null : (
        <span className="block whitespace-normal">
          <Problem>{t(refused)}</Problem>
        </span>
      )}
    </div>
  );
}

/** Where a note went: the tracker and its reference, an address, Fruitback, or a source that is gone. */
export function Place({
  place,
  source,
  reference,
  address,
  late,
}: {
  place: NotePlace;
  /** Its connector, when it is still there: its name is the one its workspace gave it (FRU-404). */
  source: Connector | undefined;
  reference: string | undefined;
  address: string | undefined;
  late: boolean;
}) {
  useLocale();
  if (place.kind === 'removed') return <span className="block font-semibold">{t('A connector that was removed')}</span>;
  // FRU-552: the mark of the place, then its reference, on one line. The name of the place is said to
  // a screen reader only, where a reference or an address follows it.
  if (place.kind === 'fruitback') {
    return (
      <span className="flex items-center gap-[6px] whitespace-nowrap">
        <Mark size={14} />
        {t('In Fruitback')}
      </span>
    );
  }
  const name = source === undefined ? t(KINDS[place.kind].name) : connectorName(source);
  // An address that did not take the note yet shows no host beside « Not delivered yet ».
  const host = place.kind === 'rest' && !late ? hostOfLabel(place.label) : undefined;
  let after: ReactNode = null;
  if (reference !== undefined) after = <Reference reference={reference} address={address} />;
  else if (host !== undefined) after = <span className="text-muted">{host}</span>;

  return (
    <span className="flex items-center gap-[6px]" data-place={place.kind}>
      <ConnectorMark kind={place.kind} />
      {after === null ? (
        <span className="font-semibold">{name}</span>
      ) : (
        <>
          <span className="sr-only">{name}</span>
          {after}
        </>
      )}
    </span>
  );
}

/** The reference of a note in a tracker: a link to its issue when the worker knows its address. */
export function Reference({ reference, address }: { reference: string | undefined; address: string | undefined }) {
  if (reference === undefined) return null;
  if (address === undefined) return <span className="block text-hint text-muted">{reference}</span>;

  return (
    // The reference reads at 400, as the mockup draws it: a link of the kit is at 600, for an action.
    <a
      href={address}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-[4px] text-hint text-ink underline decoration-1 underline-offset-[3px] hover:text-accent-strong"
    >
      {reference}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[12px] w-[12px]">
        <path
          d="M8 16L16 8M9.5 8H16v6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

/** A read of the notes that failed: the alert of the Sites screen, never « No note yet ». */
export function NotesFailed({ onRetry }: { onRetry: () => void }) {
  useLocale();

  return (
    <LoadFailed
      title={t('The notes did not load')}
      detail={
        <>
          <ReadProblem /> {t('Your notes are safe.')}
        </>
      }
      retry={t('Try again')}
      onRetry={onRetry}
    />
  );
}
