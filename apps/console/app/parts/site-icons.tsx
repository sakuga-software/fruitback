/**
 * The icons of the page of a site (FRU-689): its tabs, the buttons of its head, and the start of each
 * row of its cards, as the mockup « Un site » draws them. They are drawn as the icons of the rail
 * (`rail-icons.tsx`): inline, on a grid of 24, a stroke of 2 in `currentColor` with round ends. An
 * icon is `aria-hidden` and takes no focus: the words beside it name it.
 */

const PATHS = {
  // A page with a column: « Overview ».
  overview: 'M4 4h16v16H4zM9 4v16',
  // Two angle brackets: « Install », the script.
  install: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  // Two links of a chain: « Destinations ».
  destinations: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  // A flag: « Statuses ».
  statuses: 'M5 21V4h11l-2 4 2 4H5',
  // A shield: « Access ».
  access: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z',
  // Three sliders: « Advanced ».
  advanced: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  // A box and an arrow out of it: « Open site ».
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  // A bubble: the notes, and who leaves one.
  notes: 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z',
  // A globe: the address.
  address: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c-3 3.2-3 14.8 0 18M12 3c3 3.2 3 14.8 0 18',
  // Two people: who sees the notes.
  members:
    'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a3.5 3.5 0 0 1 0 6.8',
  // An envelope: the e-mail when a note is done.
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  // A piece of a puzzle: the extension.
  extension:
    'M10 4a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1z',
  // Two sheets: « Copy ».
  copy: 'M8 8h12v12H8zM4 16V4h12',
  // A plus: « Add ».
  add: 'M12 5v14M5 12h14',
  // Three dots on a line: the menu of a row.
  more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const;

export type SiteIconName = keyof typeof PATHS;

/** An icon of the page of a site: 14 px, or 16 px at the start of a row. `more` is drawn thicker. */
export function SiteIcon({ name, size = 14 }: { name: SiteIconName; size?: 14 | 16 }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-site-icon={name}
      className={`${size === 14 ? 'size-[14px]' : 'size-[16px]'} flex-none ${name === 'open' ? 'rtl:-scale-x-100' : ''}`}
    >
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={name === 'more' ? 2.6 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
