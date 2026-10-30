/**
 * The icons of the entries of the rails (FRU-477, FRU-476). They are drawn as every other icon of the
 * console is: inline, on a grid of 24, a stroke of 2 in `currentColor` with round ends. No icon set,
 * no request. An icon is `aria-hidden` and takes no focus: the words of the entry name it.
 */

/** The path of each icon, on a grid of 24. */
const PATHS = {
  // A globe: a site is a place on the web.
  sites: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c-3 3.2-3 14.8 0 18M12 3c3 3.2 3 14.8 0 18',
  // A bubble: what somebody wrote.
  notes: 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z',
  // Two links of a chain: the notes go on to a tracker.
  connectors: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  // Two people.
  members:
    'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a3.5 3.5 0 0 1 0 6.8',
  // Three sliders: the settings of the workspace (FRU-503).
  settings: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  // One person.
  account: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  // A shield: the administration of the instance.
  admin: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z',
  // A server of two units: the instance.
  instance:
    'M5 3.5h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2zM5 13.5h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2zM7 7h.01M7 17h.01',
  // Four squares: the workspaces of the instance.
  workspaces: 'M4 4h6v6H4zM14 4h6v6h-6zM14 14h6v6h-6zM4 14h6v6H4z',
  // An arrow to the start of the line: back to the workspaces of the person (FRU-476).
  back: 'M19 12H5M11 6l-6 6 6 6',
} as const;

export type RailIconName = keyof typeof PATHS;

/**
 * An icon of an entry of the rail: 18 px, in the colour of the words beside it. `back` points to the
 * start of the line, so it turns in a page written from right to left.
 */
export function RailIcon({ name }: { name: RailIconName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-rail-icon={name}
      className={`size-[18px] flex-none ${name === 'back' ? 'rtl:-scale-x-100' : ''}`}
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
