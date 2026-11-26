/**
 * The icons of the bar (FRU-477, FRU-476, FRU-684). They are drawn as every other icon of the
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
  // FRU-704: « To approve », the notes of visitors that wait for a member: a tray.
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  workspaces: 'M4 4h6v6H4zM14 4h6v6h-6zM14 14h6v6h-6zM4 14h6v6H4z',
  // An arrow to the start of the line: back to the workspaces of the person (FRU-476).
  back: 'M19 12H5M11 6l-6 6 6 6',
  // FRU-684, the head and the foot of the bar, as the mockup draws them.
  // A magnifier: the search of the notes.
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5',
  // A chevron down: the name of the workspace opens a menu.
  chevron: 'M6 9l6 6 6-6',
  // Two chevrons, up and down: the menu of the person opens above or below.
  upDown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  // A spark: what is new in Fruitback.
  news: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  // A piece of a puzzle: the browser extension.
  extension:
    'M10 4a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1z',
  // A question in a circle: the help and the documentation.
  help: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
  // Three lines: the bar folded under 1024 px opens.
  menu: 'M4 7h16M4 12h16M4 17h16',
  // FRU-722, the views of the mockup. A circle of dashes: what came in, new this week.
  fresh:
    'M12.56 4.02A8 8 0 0 1 15.85 4.99M18.04 6.75A8 8 0 0 1 19.68 9.76M19.98 12.56A8 8 0 0 1 19.01 15.85M17.25 18.04A8 8 0 0 1 14.24 19.68M11.44 19.98A8 8 0 0 1 8.15 19.01M5.96 17.25A8 8 0 0 1 4.32 14.24M4.02 11.44A8 8 0 0 1 4.99 8.15M6.75 5.96A8 8 0 0 1 9.76 4.32',
  // Two braces: what a connector was sent, and did not take.
  braces:
    'M9 4c-2 0-3 1-3 3v2c0 1.2-.8 2.4-2 3 1.2.6 2 1.8 2 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.2.8 2.4 2 3-1.2.6-2 1.8-2 3v2c0 2-1 3-3 3',
  // FRU-723: a view of the person, the lines of « Filter » of the bar of the notes.
  filter: 'M4 6h16M7 12h10M10 18h4',
} as const;

export type RailIconName = keyof typeof PATHS;

/**
 * An icon of the bar: 16 px beside the words of an entry (FRU-684), 14 px on a button of the head, in
 * the colour of the words beside it. `back` points to the start of the line, so it turns in a page
 * written from right to left.
 */
export function RailIcon({ name, small = false }: { name: RailIconName; small?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-rail-icon={name}
      className={`${small ? 'size-[14px]' : 'size-[16px]'} flex-none ${name === 'back' ? 'rtl:-scale-x-100' : ''}`}
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
