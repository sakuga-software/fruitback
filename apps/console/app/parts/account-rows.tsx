import type { ReactNode } from 'react';
import type { Linkable } from '../api';

/** What the sections of My account share (FRU-614): the names of the providers, a title, a row. */

export const PROVIDER_NAMES: Readonly<Record<Linkable, string>> = { github: 'GitHub', google: 'Google' };

/** The title of a section: the section is named by it. */
export function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-section font-bold">
      {children}
    </h2>
  );
}

/** What a section is for, under its title. */
export function SectionHelp({ children }: { children: string }) {
  return <p className="mt-[4px] mb-[12px] text-small text-muted">{children}</p>;
}

/**
 * The box of a list of one row, where there is no list yet: its two rules, and the height of a row.
 *
 * WARNING: the list of the browsers arrives after the screen is drawn, and « Sign out » is under it.
 * While the list is read, and when it could not be, its place is the one of the row of this browser,
 * which every list has. So the buttons do not move under a press: a press that starts before a
 * button moves and ends after is lost. `e2e/console-account.spec.ts` holds the list back to see it.
 * A second browser still adds its row under the first.
 */
export const ONE_ROW = 'box-content flex min-h-[56px] flex-wrap items-center border-y border-line py-[8px]';

/**
 * A row of a list of the account: a name, a line under it, and at its end a state or one action. The
 * mockup sizes it by its content: 56 px at the least inside its padding.
 */
export function Row({
  title,
  detail,
  under,
  children,
}: {
  title: string;
  detail: string;
  /** Under the row: why its action did not go through. */
  under?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="box-content flex min-h-[56px] flex-wrap items-center gap-x-[16px] gap-y-[4px] border-b border-line py-[8px]">
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="block leading-auto font-semibold">{title}</span>
        <span className="block text-hint leading-auto text-muted [overflow-wrap:anywhere]">{detail}</span>
      </span>
      {children ?? null}
      {under === undefined ? null : <div className="w-full">{under}</div>}
    </li>
  );
}
