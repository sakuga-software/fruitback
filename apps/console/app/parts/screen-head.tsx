import type { ReactNode } from 'react';

/**
 * The head of a screen of the bar and the spaces under it (FRU-738). A module of its own, which a
 * route and a part both import: `routes/workspace.tsx` imports parts, so a part that imported it back
 * would close a cycle.
 *
 * Each value leaves the side padding of `Screen` of `routes/workspace.tsx`: `clamp(16px, 4vw, 48px)`.
 */

/** Takes a box out of the side padding of `Screen`, to the edges of the screen. */
export const SCREEN_BLEED = '-mx-[clamp(16px,4vw,48px)]';

/**
 * Puts the content under a `ScreenHead` 20 px from the edges of the screen, as its title (FRU-738).
 * It is the inset of the rows of Sites and Members, and of the band under the table of Sites.
 */
export const SCREEN_INSET = 'mx-[calc(20px_-_clamp(16px,4vw,48px))]';

/**
 * The head of a screen of the bar (FRU-686, FRU-688, FRU-691, FRU-738): 48 px from one edge of the
 * screen to the other, out of the padding of `Screen`, the title at 14 px and 20 px in, and the
 * actions at the right, 16 px from the edge. Sites, Members and Connectors draw this one head, so a
 * screen cannot keep a space of its own.
 */
export function ScreenHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header
      className={`${SCREEN_BLEED} -mt-[40px] flex min-h-[48px] items-center gap-[8px] border-b border-line pr-[16px] pl-[20px]`}
    >
      <h1 className="text-step font-semibold text-ink">{title}</h1>
      {/* `empty:hidden`: no action draws no box, whatever form the nothing takes (a `null`, a fragment of nulls). */}
      <div className="ml-auto flex items-center gap-[8px] empty:hidden">{children}</div>
    </header>
  );
}
