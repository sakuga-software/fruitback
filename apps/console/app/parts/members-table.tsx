import { type ReactNode, type RefObject, useState } from 'react';
import { type Role, type SharedSite } from '../api';
import { Confirmation } from '../confirm';
import { Field, Initial, LineTab, Menu, type MenuItem, Problem } from '../ui';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { hostOf, siteName } from '../site-address';
import { SiteTile } from './notes-table';
import { useSlashKey } from './notes-filters';

/** The head, the tabs and the lists go from one edge of the screen to the other (FRU-691). */
const BLEED = '-mx-[clamp(16px,4vw,48px)]';

export const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

/**
 * The head of the screen (FRU-691): « Members » at 14 px, and « Invite » at its right. 48 px, from one
 * edge of the screen to the other, as the head of Notes (FRU-686).
 */
export function MembersHead({ action }: { action: ReactNode }) {
  useLocale();

  return (
    <header
      className={`${BLEED} -mt-[40px] flex min-h-[48px] items-center gap-[8px] border-b border-line pr-[16px] pl-[20px]`}
    >
      <h1 className="text-step font-semibold text-ink">{t('Members')}</h1>
      <div className="ml-auto flex items-center gap-[8px]">{action}</div>
    </header>
  );
}

export type MembersTab = 'members' | 'invitations';

/**
 * The tabs of the screen (FRU-691): « Members » and « Invitations », each with its count, and the
 * search at the right, which « / » gives the focus to. 44 px, from one edge of the screen to the
 * other. A tab is a button that says whether it is pressed (`LineTab`), as the tabs of Notes
 * (FRU-686). Whoever may not read the invitations has the tab « Members » alone.
 */
export function MembersTabs({
  tab,
  onTab,
  tabs,
  search,
}: {
  tab: MembersTab;
  onTab: (tab: MembersTab) => void;
  tabs: readonly { id: MembersTab; label: string; count: number | undefined }[];
  search: ReactNode;
}) {
  useLocale();

  return (
    <div
      className={`${BLEED} flex min-h-[44px] flex-wrap items-center gap-x-[18px] border-b border-line pr-[16px] pl-[20px]`}
    >
      <div role="group" aria-label={t('Members and invitations')} className="flex min-w-0 items-center gap-[18px]">
        {tabs.map((each) => (
          <LineTab
            key={each.id}
            pressed={each.id === tab}
            onPress={() => onTab(each.id)}
            {...(each.count === undefined ? {} : { count: each.count })}
          >
            {each.label}
          </LineTab>
        ))}
      </div>
      <div className="ml-auto flex min-w-0 items-center py-[8px]">{search}</div>
    </div>
  );
}

/**
 * The search of the screen (FRU-691): 240 px, « Search by name or address », and « / » gives it the
 * focus, as on Notes (FRU-686). The worker searches the members; the screen searches the invitations.
 */
export function MembersSearch({
  typed,
  onType,
  longest,
  field,
}: {
  typed: string;
  onType: (typed: string) => void;
  longest: number;
  field: RefObject<HTMLInputElement | null>;
}) {
  useLocale();
  useSlashKey(field);

  return (
    <div className="relative w-[240px] max-w-full min-w-0">
      <Field
        label={t('Search members')}
        labelHidden
        compact
        type="search"
        someoneElse
        inputRef={field}
        placeholder={t('Search by name or address')}
        maxLength={longest}
        value={typed}
        onChange={(event) => onType(event.target.value)}
      />
      {typed === '' ? (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-[6px] inline-flex h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded-inner border border-line bg-page px-[4px] font-sans text-tiny leading-none font-medium text-muted"
        >
          /
        </kbd>
      ) : null}
    </div>
  );
}

/** A column of a list: its head, and its width (a share of the list, or pixels for the menu). */
export type Column = { key: string; label: string; width: string };

/**
 * A list of the screen (FRU-691), as the mockup draws it: a table from one edge of the screen to the
 * other, 8 px in, heads of 32 px, rows of 36 px. Its frame is a region named as its tab. It keeps
 * `minWidth` and scrolls in its frame on a phone; the frame takes focus, so a keyboard scrolls it
 * (WCAG 2.1.1). The frame holds what is positioned in it: the name of the column of the menu, for a
 * screen reader only, is absolute, and out of a frame with no position it widened the page (FRU-505).
 */
export function MembersList({
  tab,
  label,
  columns,
  minWidth = 880,
  children,
}: {
  tab: MembersTab;
  label: string;
  columns: readonly Column[];
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-tab={tab}
      className={`${BLEED} relative overflow-x-auto px-[8px] [scrollbar-width:thin]`}
    >
      <table className="w-full table-fixed border-separate border-spacing-0 text-table" style={{ minWidth }}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="h-[32px] border-b border-line px-[12px] py-0 text-left text-hint leading-auto font-medium whitespace-nowrap text-muted"
              >
                {column.key === 'menu' ? <span className="sr-only">{column.label}</span> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A cell of a row: one line of 36 px, its border counted. What is longer is cut with « … ». */
const CELL = 'h-[36px] border-b border-line/60 px-[12px] py-0 whitespace-nowrap overflow-hidden text-ellipsis';
/** What a cell holds when it is more than words: on one line, and cut. */
const LINE = 'flex min-w-0 items-center';

/** The first cell of a row: the round initial, the name at 600, and « (you) ». */
export function NameCell({
  initial,
  name,
  you = false,
  pending = false,
}: {
  initial: string;
  name: string;
  you?: boolean;
  pending?: boolean;
}) {
  useLocale();

  return (
    <td className={CELL}>
      <span className={`${LINE} gap-[10px]`}>
        <Initial name={initial} size="dense" pending={pending} />
        <span className={`min-w-0 truncate text-ink ${pending ? 'font-medium' : 'font-semibold'}`}>{name}</span>
        {/* After a space: « Ana (you) » is what a screen reader and a search of the page read. */}
        {you ? (
          <>
            {' '}
            <span className="flex-none text-muted">{t('(you)')}</span>
          </>
        ) : null}
      </span>
    </td>
  );
}

/** A cell of words: the address, the day, the role that is not a list. */
export function TextCell({ children, tone = 'muted' }: { children: ReactNode; tone?: 'ink' | 'soft' | 'muted' }) {
  const colour = { ink: 'text-ink font-medium', soft: 'text-ink-soft', muted: 'text-muted tabular-nums' }[tone];

  return <td className={`${CELL} ${colour}`}>{children}</td>;
}

/**
 * The column « Sites » (FRU-250): « Every site » with the globe for a role that reads every site; the
 * tile and the host of the site of a guest, and how many more it has.
 */
export function SitesCell({ role, sites }: { role: Role; sites: readonly SharedSite[] | undefined }) {
  useLocale();
  let shown: ReactNode;
  if (role !== 'guest') {
    shown = (
      <>
        <Globe />
        <span className="truncate">{t('Every site')}</span>
      </>
    );
  } else if (sites === undefined || sites.length === 0) {
    shown = <span className="truncate">{sites === undefined ? t('Shared ones') : t('No site')}</span>;
  } else {
    const [first, ...more] = sites;
    shown = (
      <>
        <SiteTile host={hostOf(first!.origin)} />
        <span className="truncate">{siteName(first!.origin)}</span>
        {more.length === 0 ? null : <span className="flex-none text-muted tabular-nums">+{more.length}</span>}
      </>
    );
  }

  return (
    <td className={CELL}>
      <span className={`${LINE} gap-[6px] text-ink-soft`}>{shown}</span>
    </td>
  );
}

/** The globe of « Every site »: a stroke of 2 in `currentColor`, as the icons of the console. */
export function Globe() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[14px] flex-none text-muted">
      <path
        d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c-3 3.2-3 14.8 0 18M12 3c3 3.2 3 14.8 0 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[12px] flex-none text-muted">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Dots() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M5 12h.01M12 12h.01M19 12h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The list of the role of a row (FRU-691): its role, a chevron, and the roles it may take. */
const ROLE_TRIGGER =
  'inline-flex max-w-full items-center gap-[6px] h-control-sm px-[8px] border border-line rounded-control bg-page text-ink font-medium whitespace-nowrap [&:hover]:bg-hover data-[hovered=true]:bg-hover';

/**
 * The role of a row that may change (FRU-691), as a list in the row: the roles a change of role gives
 * (`GIVEN_ROLES` of the worker), with « Guest » kept for a guest, who has it already.
 */
export function RoleCell({
  role,
  roles,
  name,
  onChoose,
  cell,
}: {
  role: Role;
  /** The roles it may take, its own among them. Empty: the role is words, not a list. */
  roles: readonly Role[];
  name: string;
  onChoose: (role: Role) => void;
  cell: RefObject<HTMLTableCellElement | null>;
}) {
  useLocale();
  if (roles.length === 0)
    return (
      <td ref={cell} className={`${CELL} font-medium text-ink`}>
        {t(ROLE_WORDS[role])}
      </td>
    );

  return (
    <td ref={cell} className={CELL}>
      <Menu
        items={roles.map((each) => ({ id: each, label: t(ROLE_WORDS[each]) }))}
        chosen={role}
        choiceLabel={t('Role of {name}', { name })}
        onAction={(chosen) => {
          if (chosen !== role) onChoose(chosen as Role);
        }}
        triggerLabel={t('{role}, role of {name}', { role: t(ROLE_WORDS[role]), name })}
        triggerClassName={ROLE_TRIGGER}
      >
        <span className="truncate">{t(ROLE_WORDS[role])}</span>
        <Chevron />
      </Menu>
    </td>
  );
}

/** The last cell of a row: « … », the menu of what may be done to it. No item: an empty cell. */
export function MenuCell({
  label,
  items,
  onAction,
  cell,
}: {
  label: string;
  items: readonly MenuItem[];
  onAction: (id: string) => void;
  cell: RefObject<HTMLTableCellElement | null>;
}) {
  return (
    <td ref={cell} className={`${CELL} overflow-visible pr-[4px] text-right`}>
      {items.length === 0 ? null : (
        <span className="inline-flex justify-end">
          <Menu items={items} onAction={onAction} trigger="icon" triggerLabel={label}>
            <Dots />
          </Menu>
        </span>
      )}
    </td>
  );
}

/** What a row asks before it acts (FRU-165): what it costs, the button that acts, and « Keep it ». */
export type Asked = { confirmLabel: string; consequence: string; onConfirm: () => void };

/**
 * What a row says under its line: the second time of a gesture, a refusal, a copy. Only then is a row
 * taller. On a phone the table scrolls in its frame: what is said stays in what is seen of it.
 */
export function UnderRow({
  span,
  asked,
  onKeep,
  problem,
  said,
}: {
  span: number;
  asked: Asked | undefined;
  onKeep: () => void;
  problem: string | undefined;
  /** A sentence that is no refusal: « The link is copied. » */
  said?: string | undefined;
}) {
  useLocale();
  if (asked === undefined && problem === undefined && said === undefined) return null;

  return (
    <tr className="bg-subtle">
      <td colSpan={span} className="border-b border-line/60 px-[12px] py-[8px]">
        <div className="sticky left-[12px] flex max-w-[calc(100vw-56px)] flex-col gap-[8px]">
          {asked === undefined ? null : (
            <Confirmation
              confirmLabel={asked.confirmLabel}
              consequence={asked.consequence}
              onConfirm={asked.onConfirm}
              onKeep={onKeep}
            />
          )}
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          {said === undefined ? null : (
            <p role="status" className="text-hint text-muted">
              {t(said)}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * What one row of the screen asks, and where focus goes back: « Keep it » and Escape give it back to
 * the control that asked, the list of the role or « … ». One row asks at a time.
 */
export function useAsking() {
  const [asking, setAsking] = useState<
    { row: string; asked: Asked; from: RefObject<HTMLTableCellElement | null> } | undefined
  >();
  const keep = () => {
    const from = asking?.from;
    setAsking(undefined);
    // After the render that takes the confirmation away: the button is the one of the row again.
    requestAnimationFrame(() => from?.current?.querySelector<HTMLElement>('button')?.focus());
  };

  return {
    /** What the row `row` asks, if it is the one that asks. */
    askedOf: (row: string) => (asking?.row === row ? asking.asked : undefined),
    ask: (row: string, asked: Asked, from: RefObject<HTMLTableCellElement | null>) =>
      setAsking({
        row,
        asked: {
          ...asked,
          onConfirm: () => {
            setAsking(undefined);
            asked.onConfirm();
          },
        },
        from,
      }),
    done: () => setAsking(undefined),
    keep,
  };
}
