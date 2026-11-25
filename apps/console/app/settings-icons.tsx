/**
 * The icons of the settings (FRU-692): the entries of their navigation, the head of each card, and the
 * start of each row of a card. They are drawn as the icons of the rail (`rail-icons.tsx`): inline, on
 * a grid of 24, a stroke of 2 in `currentColor` with round ends. No icon set, no request. An icon is
 * `aria-hidden` and takes no focus: the words beside it name it.
 */

/** The path of each icon, on a grid of 24. */
const PATHS = {
  // One person: the profile.
  profile: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  // A key: how the person signs in.
  key: 'M14.5 3.5a6 6 0 1 1-5.3 8.8L3 18.5V21h3v-2h2v-2h2l1.7-1.7M16.5 7.5h.01',
  // A screen on its foot: a browser where the console is signed in.
  screen: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4',
  // A piece of a puzzle: a browser of the extension.
  extension:
    'M9 4.5a2 2 0 1 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 1 0 0 4H18v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 1 0 0-4H4V7a1 1 0 0 1 1-1h4z',
  // A half-filled circle: the look of the console.
  appearance: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 8l5-4.2M12 13l8-6.5M12 18l8-4.5',
  // A bell.
  bell: 'M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9M10 19.5a2 2 0 0 0 4 0',
  // Three sliders: what the whole workspace is.
  general: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  // A spark: what an AI agent needs.
  ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  // A bolt: a key that lets an agent act.
  agents: 'M13 2L4 14h7l-1 8 9-12h-7z',
  // Two people.
  members:
    'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a3.5 3.5 0 0 1 0 6.8',
  // Two links of a chain.
  connectors: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  // An envelope: an address.
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3.5 6.5L12 13l8.5-6.5',
  // A plus: « Add ».
  add: 'M12 5v14M5 12h14',
  // A door and an arrow out of it: « Sign out ».
  out: 'M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M14 16l4-4-4-4M18 12H8',
  // Three dots on a line: the menu of a row.
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  // A bin: a gesture that deletes, in the danger zone (FRU-693).
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
} as const;

export type SettingsIconName = keyof typeof PATHS;

/**
 * An icon of the settings: 16 px, in the colour of what it is in. `out` points to the end of the
 * line, so it turns in a page written from right to left. `more` is drawn thicker: three dots of a
 * stroke of 2 read as dust.
 */
export function SettingsIcon({ name, size = 16 }: { name: SettingsIconName; size?: 14 | 16 }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-settings-icon={name}
      className={`${size === 14 ? 'size-[14px]' : 'size-[16px]'} flex-none ${name === 'out' ? 'rtl:-scale-x-100' : ''}`}
    >
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={name === 'more' ? 3 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
