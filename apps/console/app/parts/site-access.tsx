import type { ReactNode } from 'react';
import { type Access, type Level, LEVELS, levelOf, visitorReplies, withLevel } from '../access-policy';
import { VISITOR_NOTE_LIMITS, type Visibility, type VisitorNoteLimit, type VisitorRight, type Writers } from '../api';
import { msg, t } from '../i18n';
import { Choice, PickCards, StatusDot, Toggle } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The cards of the tab « Access » of a site (FRU-703), as the mockup « Onglet Access » draws them:
 * « Public access », « What a visitor can do », « How a visitor is recognised » on the left, « What a
 * visitor sees » on the right. The console only shows and sends what the worker stores: a cell that
 * no setting of the worker holds is written as words, not drawn as a list that could change it.
 *
 * The card « Safeguards » (FRU-704) grows one line by safeguard, each with its pull request: « Notes
 * per visitor » first. Drawn and not chosen: the level « Collaborate » (FRU-707) and the two ways to
 * recognise a visitor that come later (FRU-705, FRU-706).
 */

/** The icons of the tab, drawn as every icon of the console: a grid of 24, a stroke of 2. */
const PATHS = {
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c-3 3.2-3 14.8 0 18M12 3c3 3.2 3 14.8 0 18',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  bubble: 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z',
  people:
    'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a3.5 3.5 0 0 1 0 6.8',
  person: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 7.5a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  key: 'M15 4a5 5 0 1 0 0 10a5 5 0 1 0 0-10M11.5 12.5L4 20M7 17l2 2',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9c-4.6-.7-8-4.5-8-9V6z',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
} as const;

type IconName = keyof typeof PATHS;

function Icon({ name, size = 16 }: { name: IconName; size?: 14 | 16 }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-access-icon={name}
      className={`${size === 14 ? 'size-[14px]' : 'size-[16px]'} flex-none`}
    >
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A card of the tab: a head with its icon, its title and a chip at the end, then its body. */
function AccessCard({
  id,
  icon,
  title,
  chip,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  chip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 overflow-hidden rounded-card border border-line bg-surface"
      data-access-card={id}
    >
      <div className="flex min-h-[48px] items-center gap-[10px] border-b border-line px-[16px] py-[8px]">
        <span className="text-ink-soft">
          <Icon name={icon} />
        </span>
        <h2 id={`${id}-title`} className="min-w-0 flex-1 text-(length:--text-small) font-semibold text-ink">
          {title}
        </h2>
        {chip ?? null}
      </div>
      {children}
    </section>
  );
}

/** The small label at the end of the head of a card: the host, or the level of the table. */
function HeadChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-control bg-chip px-[8px] py-[2px] text-(length:--text-tiny) font-semibold text-ink-soft">
      {children}
    </span>
  );
}

const LEVEL_WORDS: Readonly<Record<Level | 'custom', string>> = {
  closed: msg('Closed'),
  'read-only': msg('Read only'),
  contribute: msg('Contribute'),
  collaborate: msg('Collaborate'),
  custom: msg('Custom'),
};
const LEVEL_DETAILS: Readonly<Record<Level, string>> = {
  closed: msg('Only members see and leave notes'),
  'read-only': msg('Visitors see the notes, cannot write'),
  contribute: msg('Visitors leave notes, edit and delete their own'),
  collaborate: msg("Visitors also edit and close each other's notes"),
};
const LEVEL_ICONS: Readonly<Record<Level, IconName>> = {
  closed: 'lock',
  'read-only': 'eye',
  contribute: 'bubble',
  collaborate: 'people',
};

/**
 * « Public access »: the four levels as cards with a radio. Choosing one fills the table. « Collaborate »
 * comes with FRU-707: it is drawn, and its radio is disabled. A table that is no level checks no card.
 */
export function AccessLevels({
  host,
  access,
  disabled,
  onChange,
}: {
  host: string;
  access: Access;
  disabled: boolean;
  onChange: (access: Access) => void;
}) {
  useLocale();
  const level = levelOf(access);

  return (
    <AccessCard
      id="public-access"
      icon="globe"
      title={t('Public access')}
      chip={<HeadChip>{t('Anyone on {site}', { site: host })}</HeadChip>}
    >
      <div className="p-[16px]">
        <PickCards
          label={t('Public access')}
          value={level}
          disabled={disabled}
          onChange={(chosen) => {
            if (chosen !== 'collaborate' && chosen !== 'custom') onChange(withLevel(access, chosen));
          }}
          options={LEVELS.map((each) => ({
            value: each,
            label: t(LEVEL_WORDS[each]),
            // « Collaborate » comes with FRU-707: drawn, and not chosen.
            detail:
              each === 'collaborate'
                ? t('Comes later. Visitors edit their own notes until then.')
                : t(LEVEL_DETAILS[each]),
            icon: <Icon name={LEVEL_ICONS[each]} />,
            disabled: each === 'collaborate',
          }))}
        />
      </div>
    </AccessCard>
  );
}

/** A cell that no setting holds: the value, in words. */
function Fixed({ children }: { children: ReactNode }) {
  return <span className="text-(length:--text-small) text-muted">{children}</span>;
}

/** One row of the table: the icon and the action, then the two columns. */
function Row({ icon, action, own, others }: { icon: IconName; action: string; own: ReactNode; others: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-[6px] pr-[12px] pl-[16px] text-left font-normal">
        <span className="flex items-center gap-[10px] text-(length:--text-small) text-ink">
          <span className="text-ink-soft">
            <Icon name={icon} size={14} />
          </span>
          {action}
        </span>
      </th>
      <td className="py-[6px] pr-[12px]">{own}</td>
      <td className="py-[6px] pr-[16px]">{others}</td>
    </tr>
  );
}

/**
 * « What a visitor can do »: one row by action, a column for the notes of the visitor and one for the
 * notes of others. The lists are the settings of the worker: who reads (`visibility`), who writes
 * (`writers`), and what a visitor does to a note of their own (`visitorEdit`, `visitorDelete`). The
 * other cells say what the worker does, and change with them.
 */
export function VisitorRights({
  access,
  disabled,
  onChange,
}: {
  access: Access;
  disabled: boolean;
  onChange: (access: Access) => void;
}) {
  useLocale();
  const level = levelOf(access);
  const reads = access.visibility === 'everyone';
  const writes = access.writers === 'anyone';
  const seen = reads ? t('All notes') : t('Hidden');
  const replies = visitorReplies(access) ? t('Allowed') : t('Never');
  const rights = [
    { value: 'never', label: t('Never') },
    { value: 'while-open', label: t('While open') },
  ] as const;
  const own = (field: 'visitorEdit' | 'visitorDelete', label: string) =>
    // Where only members write, a visitor has no note of their own: the right is not offered.
    writes ? (
      <Choice
        compact
        labelHidden
        label={label}
        value={access[field]}
        disabled={disabled}
        options={rights}
        onChange={(value) => onChange({ ...access, [field]: value as VisitorRight })}
      />
    ) : (
      <Fixed>{t('Never')}</Fixed>
    );

  return (
    <AccessCard
      id="visitor-rights"
      icon="person"
      title={t('What a visitor can do')}
      chip={<HeadChip>{t(LEVEL_WORDS[level])}</HeadChip>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="text-left text-(length:--text-hint) text-muted">
              <th scope="col" className="py-[10px] pr-[12px] pl-[16px] font-normal">
                {t('Action')}
              </th>
              <th scope="col" className="w-[200px] py-[10px] pr-[12px] font-normal">
                {t('On their own notes')}
              </th>
              <th scope="col" className="w-[200px] py-[10px] pr-[16px] font-normal">
                {t('On notes of others')}
              </th>
            </tr>
          </thead>
          <tbody>
            <Row
              icon="eye"
              action={t('See notes')}
              own={<Fixed>{seen}</Fixed>}
              others={
                <Choice
                  compact
                  labelHidden
                  label={t('See notes of others')}
                  value={access.visibility}
                  disabled={disabled}
                  options={[
                    { value: 'everyone', label: t('All notes') },
                    { value: 'members', label: t('Hidden') },
                  ]}
                  onChange={(value) => onChange({ ...access, visibility: value as Visibility })}
                />
              }
            />
            <Row
              icon="pin"
              action={t('Leave a note')}
              own={
                <Choice
                  compact
                  labelHidden
                  label={t('Leave a note')}
                  value={access.writers}
                  disabled={disabled}
                  options={[
                    { value: 'anyone', label: t('Allowed') },
                    { value: 'members', label: t('Never') },
                  ]}
                  onChange={(value) => onChange({ ...access, writers: value as Writers })}
                />
              }
              others={<Fixed>{t('n/a')}</Fixed>}
            />
            <Row icon="bubble" action={t('Reply')} own={<Fixed>{replies}</Fixed>} others={<Fixed>{replies}</Fixed>} />
            <Row
              icon="pencil"
              action={t('Edit the text')}
              own={own('visitorEdit', t('Edit the text of their own notes'))}
              others={<Fixed>{t('Never')}</Fixed>}
            />
            <Row
              icon="trash"
              action={t('Delete')}
              own={own('visitorDelete', t('Delete their own notes'))}
              others={<Fixed>{t('Never')}</Fixed>}
            />
            <Row
              icon="flag"
              action={t('Change the status')}
              own={<Fixed>{t('Never')}</Fixed>}
              others={<Fixed>{t('Never')}</Fixed>}
            />
            {/* The read of a visitor carries the issue of the tracker: what the worker does, said as it is. */}
            <Row
              icon="tag"
              action={t('See the tracker and assignee')}
              own={<Fixed>{seen}</Fixed>}
              others={<Fixed>{seen}</Fixed>}
            />
          </tbody>
        </table>
      </div>
    </AccessCard>
  );
}

/**
 * « How a visitor is recognised »: a key kept in the browser, the one way today (FRU-700). The other
 * two come later (FRU-705, FRU-706): drawn, and not chosen. Nothing here is stored.
 */
export function VisitorRecognition() {
  useLocale();
  const ways = [
    {
      id: 'browser',
      icon: 'screen',
      title: t('This browser'),
      detail: t('A key kept in the browser. Lost if they clear it or switch device.'),
      later: false,
    },
    {
      id: 'email',
      icon: 'mail',
      title: t('A confirmed e-mail'),
      detail: t('A link by e-mail before the first edit. Works on any device.'),
      later: true,
    },
    {
      id: 'signed',
      icon: 'key',
      title: t('Signed by your site'),
      detail: t('Your backend signs who the visitor is. For logged-in users of your app.'),
      later: true,
    },
  ] as const;

  return (
    <AccessCard id="recognition" icon="key" title={t('How a visitor is recognised')}>
      <PickCards
        label={t('How a visitor is recognised')}
        layout="rows"
        value="browser"
        onChange={() => undefined}
        options={ways.map((way) => ({
          value: way.id,
          label: way.later ? `${way.title} · ${t('Later')}` : way.title,
          detail: way.detail,
          icon: <Icon name={way.icon} />,
          disabled: way.later,
        }))}
      />
    </AccessCard>
  );
}

const EDIT_LINES: Readonly<Record<VisitorRight, string>> = {
  never: msg('Cannot be changed once sent'),
  'while-open': msg('Editable while the note is open'),
};

/** A note of the preview, drawn as the widget draws one. */
function PreviewNote({
  status,
  statusWord,
  who,
  you,
  actions,
  text,
  under,
}: {
  status: 'new' | 'progress';
  statusWord: string;
  who?: string;
  you?: boolean;
  actions?: ReactNode;
  text: string;
  under?: ReactNode;
}) {
  useLocale();

  return (
    <div className="flex flex-col gap-[8px] rounded-card border border-line bg-surface p-[12px] [box-shadow:var(--shadow-frame)]">
      <div className="flex items-center gap-[8px]">
        <StatusDot status={status} />
        <span className="text-(length:--text-small) font-semibold text-ink">{statusWord}</span>
        {you === true ? (
          <span className="rounded-control bg-chip px-[6px] text-(length:--text-tiny) font-semibold text-ink-soft">
            {t('You')}
          </span>
        ) : null}
        <span className="flex-1" />
        {who === undefined ? null : <span className="text-(length:--text-hint) text-muted">{who}</span>}
        {actions ?? null}
      </div>
      <p className="text-(length:--text-small) text-ink">{text}</p>
      {under ?? null}
    </div>
  );
}

/**
 * « What a visitor sees »: the widget as a visitor of the site finds it, with this access. A picture
 * of test words, which follows the table: it reads nothing of the site.
 */
export function VisitorPreview({ access }: { access: Access }) {
  useLocale();
  const reads = access.visibility === 'everyone';
  const writes = access.writers === 'anyone';
  const mine = reads && writes;

  return (
    <AccessCard id="visitor-preview" icon="eye" title={t('What a visitor sees')}>
      <div className="flex flex-col gap-[12px] bg-subtle p-[16px]" data-preview>
        {mine ? (
          <PreviewNote
            status="new"
            statusWord={t('New')}
            you
            actions={
              <span className="flex items-center gap-[8px] text-ink-soft">
                {access.visitorEdit === 'never' ? null : (
                  <span data-preview-action="edit">
                    <Icon name="pencil" size={14} />
                  </span>
                )}
                {access.visitorDelete === 'never' ? null : (
                  <span data-preview-action="delete">
                    <Icon name="trash" size={14} />
                  </span>
                )}
              </span>
            }
            text={t('The order form rejects postcodes with a space.')}
            under={<p className="text-(length:--text-hint) text-muted">{t(EDIT_LINES[access.visitorEdit])}</p>}
          />
        ) : null}
        {reads ? (
          <PreviewNote
            status="progress"
            statusWord={t('In progress')}
            who={t('Another visitor')}
            text={t('The headline runs to three lines on a phone.')}
            under={
              visitorReplies(access) ? (
                <span className="inline-flex w-fit items-center gap-[6px] rounded-control border border-line px-[10px] py-[4px] text-(length:--text-small) text-ink">
                  <Icon name="bubble" size={14} />
                  {t('Reply')}
                </span>
              ) : null
            }
          />
        ) : null}
        <p className="text-(length:--text-hint) text-muted" data-preview-summary>
          {summaryOf(reads, writes)}
        </p>
      </div>
    </AccessCard>
  );
}

function summaryOf(reads: boolean, writes: boolean): string {
  if (reads && writes) return t('A visitor reads the notes and leaves one.');
  if (reads) return t('A visitor reads the notes and leaves none.');
  if (writes) return t('A visitor leaves a note and cannot read it back.');

  return t('A visitor sees no note and leaves none.');
}

/**
 * The e-mail of a note done (FRU-604), offered where anybody may leave a note: the switch the page of
 * a site had under « Who sees the notes », in the tab now. Not in the mockup, which draws no place
 * for it.
 */
export function DoneNotice({
  access,
  disabled,
  onChange,
}: {
  access: Access;
  disabled: boolean;
  onChange: (access: Access) => void;
}) {
  useLocale();
  if (access.writers !== 'anyone') return null;

  return (
    <AccessCard id="done-notice" icon="mail" title={t('After a note')}>
      <div className="px-[16px] py-[12px]">
        <Toggle
          label={t('Offer visitors an e-mail when their note is done')}
          hint={t(
            'After a note, a visitor may give an address. Fruitback writes to it once, when the note is done, then deletes it.',
          )}
          value={access.notifyDone}
          disabled={disabled}
          onChange={(notifyDone) => onChange({ ...access, notifyDone })}
        />
      </div>
    </AccessCard>
  );
}

/** One line of the card « Safeguards »: its icon, its name and what it does, then its control. */
function Safeguard({
  icon,
  title,
  hint,
  children,
}: {
  icon: IconName;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-[12px] border-t border-line px-[16px] py-[10px] first:border-t-0">
      <span className="text-ink-soft">
        <Icon name={icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-(length:--text-small) font-medium text-ink">{title}</span>
        <span className="text-(length:--text-hint) text-muted">{hint}</span>
      </span>
      <span className="flex-none">{children}</span>
    </div>
  );
}

/**
 * « Safeguards » (FRU-704): what keeps the notes of anybody in hand, one line each, as the mockup
 * draws them. The worker applies each value. « Notes per visitor »: the notes a visitor with no account
 * leaves on the site in an hour, by the key of their browser and by their address; then the widget asks
 * them to wait. Where only members write, no visitor is counted: the value is said, not changed.
 */
export function Safeguards({
  access,
  disabled,
  onChange,
}: {
  access: Access;
  disabled: boolean;
  onChange: (access: Access) => void;
}) {
  useLocale();
  const writes = access.writers === 'anyone';
  const limitWord = (limit: VisitorNoteLimit) =>
    limit === 0 ? t('No limit') : t('{count} / hour', { count: String(limit) });

  return (
    <AccessCard id="safeguards" icon="shield" title={t('Safeguards')}>
      <Safeguard icon="clock" title={t('Notes per visitor')} hint={t('Per hour, then the widget asks to wait')}>
        {writes ? (
          <Choice
            compact
            labelHidden
            label={t('Notes per visitor')}
            value={String(access.visitorNotesPerHour)}
            disabled={disabled}
            options={VISITOR_NOTE_LIMITS.map((limit) => ({ value: String(limit), label: limitWord(limit) }))}
            onChange={(value) => onChange({ ...access, visitorNotesPerHour: Number(value) as VisitorNoteLimit })}
          />
        ) : (
          // Members only: no visitor leaves a note, so none is counted.
          <Fixed>{t('n/a')}</Fixed>
        )}
      </Safeguard>
    </AccessCard>
  );
}
