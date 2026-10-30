/**
 * The icons of a row of the notes (FRU-546, FRU-553): the link that opens the note on its page, and
 * who left the note. Drawn as every other icon of the console (`rail-icons.tsx`): inline, on a grid
 * of 24, a stroke of 2 in `currentColor` with round ends. No icon set, no request. An icon is
 * `aria-hidden`: the name of its link, or of its tooltip, says it.
 */
import type { NoteAuthor } from './routes/notes';

const PATHS = {
  // A box with an arrow out of it: the page opens in a new tab.
  open: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  // One person in a circle: the person who reads the list.
  you: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M6.7 18.4a6 6 0 0 1 10.6 0',
  // A crown.
  owner: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  // A shield, as the administration of the rail.
  admin: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z',
  // One person.
  member: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  // A pass: a guest reads one site.
  guest:
    'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 9a2 2 0 1 0 0 4a2 2 0 1 0 0-4M6 17a3 3 0 0 1 6 0M15 10h3M15 14h2',
  // One person and a minus: no longer in the workspace.
  'former-member': 'M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M8.5 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M16 11h6',
  // A circle with a tick: the site vouched for the visitor.
  verified: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 12.5l2.5 2.5 4.5-5',
  // A circle with a question mark: nobody vouched for the visitor.
  anonymous: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.4M12 17h.01',
} as const satisfies Record<NoteAuthor['kind'] | 'open', string>;

export type NoteIconName = keyof typeof PATHS;

/** An icon of a row of the notes: 16 px, in the colour of the words beside it. */
export function NoteIcon({ name }: { name: NoteIconName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-note-icon={name}
      className="size-[16px] flex-none"
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
