import type { AccountStore } from './accounts.ts';
import type { ClientConfig } from './clients.ts';
import { json } from './http.ts';
import type { PlaceUnavailable } from './store.ts';

/**
 * The page of the documentation for a person who is not of the workspace (FRU-640): their note is
 * kept, and who to tell. A page of fruitback.com, because the widget knows no console and a visitor
 * has no account.
 */
export const NOTE_NOT_SENT_HELP = {
  en: 'https://fruitback.com/note-not-sent',
  fr: 'https://fruitback.com/note-not-sent.fr',
};

/** Who reads the answer: a person of the workspace who sees the tracker, or anybody else. */
export type PlaceGoneReader = 'member' | 'visitor';

/**
 * The address that helps the author of a note whose place is gone (FRU-640).
 *
 * - A member: the page of the site in the console, where an owner or an admin changes the place.
 * - A visitor, or a worker with no console: the page of the documentation, in their language.
 */
export function placeGoneHelp(options: {
  reader: PlaceGoneReader;
  consoleUrl: string | undefined;
  workspace: string | undefined;
  site: string | undefined;
  locale: string | undefined;
}): { help: string; for: PlaceGoneReader } {
  const { reader, consoleUrl, workspace, site, locale } = options;
  if (reader === 'member' && consoleUrl !== undefined && workspace !== undefined && site !== undefined) {
    const page = new URL(
      `w/${encodeURIComponent(workspace)}/sites/${encodeURIComponent(site)}`,
      `${new URL(consoleUrl).origin}/`,
    );

    return { help: page.href, for: 'member' };
  }

  return {
    help: locale?.toLowerCase().startsWith('fr') === true ? NOTE_NOT_SENT_HELP.fr : NOTE_NOT_SENT_HELP.en,
    for: 'visitor',
  };
}

/**
 * Writes the refusal in the log, and keeps it on the destination of the site for the console.
 *
 * WARNING: this never rejects. The note is not kept, and the answer to the widget must still go.
 */
export async function notePlaceGone(
  accounts: AccountStore | undefined,
  site: string | undefined,
  target: ClientConfig | undefined,
  error: PlaceUnavailable,
  now: number = Date.now(),
): Promise<void> {
  const place = [target?.connector, target?.teamId, target?.projectId].map((each) => each ?? '-').join(' ');
  console.error(`[fruitback] the tracker refused the place of site ${site ?? '-'} (${place}): ${error.message}`);
  await noteDestinationOf(accounts, site, target, 'place-gone', now);
}

/** After a note that arrived: the place of the site loses its trouble. It never rejects. */
export async function notePlaceWorks(
  accounts: AccountStore | undefined,
  site: string | undefined,
  target: ClientConfig | undefined,
  now: number = Date.now(),
): Promise<void> {
  await noteDestinationOf(accounts, site, target, undefined, now);
}

async function noteDestinationOf(
  accounts: AccountStore | undefined,
  site: string | undefined,
  target: ClientConfig | undefined,
  trouble: 'place-gone' | undefined,
  now: number,
): Promise<void> {
  const connector = target?.connector;
  if (accounts === undefined || site === undefined || connector === undefined) return;
  try {
    await accounts.noteDestination(
      site,
      { connector, teamId: target?.teamId, projectId: target?.projectId },
      trouble,
      now,
    );
  } catch (failure) {
    console.error('[fruitback] the state of a destination was not kept', site, failure);
  }
}

/** `502 destination-unavailable`: an old widget reads a `502` and keeps the note, as before. */
export function placeGoneResponse(
  help: { help: string; for: PlaceGoneReader },
  corsHeaders: Record<string, string>,
  extra: Record<string, unknown> = {},
): Response {
  return json(502, { error: 'destination-unavailable', ...help, ...extra }, corsHeaders);
}
