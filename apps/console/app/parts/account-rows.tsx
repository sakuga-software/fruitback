import type { ReactNode } from 'react';
import type { Linkable } from '../api';
import { SettingsIcon, type SettingsIconName } from '../settings-icons';

/**
 * What the cards of the settings share (FRU-614, FRU-692): the names of the providers, a card with
 * its head, a row with its icon, and the room of a row while a list is read.
 */

export const PROVIDER_NAMES: Readonly<Record<Linkable, string>> = { github: 'GitHub', google: 'Google' };

/**
 * A card of the settings: a head with an icon, the title that names the card, and the actions of the
 * card at the right (« Add », « See all »). Its rows come under it.
 */
export function SettingsCard({
  id,
  icon,
  title,
  actions,
  danger = false,
  busy = false,
  children,
}: {
  /** The id of the title: the card is a region named by it. */
  id: string;
  /** No icon on the danger zone: its title, in red, says what it is. */
  icon?: SettingsIconName;
  title: string;
  actions?: ReactNode;
  /** The danger zone (FRU-693): a light red border and a red title. */
  danger?: boolean;
  /** Something of the card is on its way to the worker. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      aria-busy={busy}
      className={`kit-settings-card overflow-hidden rounded-card border bg-surface ${danger ? 'border-danger-line' : 'border-line'}`}
    >
      <div className="flex min-h-[44px] items-center gap-[8px] px-[16px]">
        {icon === undefined ? null : (
          <span className="inline-flex text-muted">
            <SettingsIcon name={icon} />
          </span>
        )}
        <h2 id={id} className={`min-w-0 text-small leading-auto font-semibold ${danger ? 'text-accent-strong' : ''}`}>
          {title}
        </h2>
        {actions === undefined ? null : <span className="ms-auto flex items-center gap-[8px]">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/** The box of the icon of a row: 24 px, its icon 14 px, a mark of a provider in its own colours. */
export function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-[24px] flex-none items-center justify-center rounded-control border border-line text-muted [&_svg]:size-[14px]!">
      {children}
    </span>
  );
}

/** The icon of a row, drawn by `settings-icons.tsx`. */
export function RowMark({ name }: { name: SettingsIconName }) {
  return (
    <RowIcon>
      <SettingsIcon name={name} size={14} />
    </RowIcon>
  );
}

/**
 * The room of one row, where there is no list yet, and of a line that says what is missing.
 *
 * WARNING: a list arrives after the screen is drawn. While it is read, and when it could not be, its
 * place is the one of a row, which every list has: the cards under it move by one row less.
 */
export const ONE_ROW = 'flex min-h-[52px] flex-wrap items-center gap-[12px] border-t border-line px-[16px] py-[8px]';

/**
 * A row of a card: its icon, a name, a line under it, and at its end a state or its actions. Every
 * row has an icon (FRU-692). The words wrap: an address is never cut.
 */
export function Row({
  icon,
  title,
  detail,
  under,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  /** Under the row: why its action did not go through, or the second time of an action that asks twice. */
  under?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="kit-settings-row border-t border-line px-[16px]">
      <div className="flex min-h-[52px] items-center gap-[12px] py-[8px]">
        {icon}
        <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <span className="text-small leading-auto font-semibold [overflow-wrap:anywhere]">{title}</span>
          <span className="text-hint text-muted [overflow-wrap:anywhere]">{detail}</span>
        </span>
        {children ?? null}
      </div>
      {under === undefined ? null : <div className="pb-[12px]">{under}</div>}
    </li>
  );
}

/** A line at the foot of a card, under its rows: what happened, or what this Fruitback cannot do. */
export function CardNote({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return (
    <p
      {...(status ? { role: 'status' } : {})}
      className="border-t border-line px-[16px] py-[12px] text-hint text-muted [overflow-wrap:anywhere]"
    >
      {children}
    </p>
  );
}
