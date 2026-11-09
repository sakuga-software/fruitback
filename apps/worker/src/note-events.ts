import type { DeliveryEvent } from './accounts.ts';
import { noteIdOf } from './console-notes.ts';
import { DELIVERY_VERSION } from './rest-connector.ts';

/**
 * What the author did to a note already sent to an address (FRU-605), as the address receives it:
 * `note.edited` for now. Identifiers only, as `agent.requested` (FRU-468): the address reads the note
 * of now by `/mcp` (`get_note` takes `note.id`), or keeps the one `note.created` sent. Never the text:
 * a person may edit a note to take out what they should not have written.
 */
export type NoteEvent = Extract<DeliveryEvent, 'note.edited'>;

export function noteEventBody(
  event: NoteEvent,
  of: { workspace: string; site: string; origin?: string; identifier: string; note: string; at: number },
): string {
  return JSON.stringify({
    version: DELIVERY_VERSION,
    event,
    workspace: of.workspace,
    site: { id: of.site, ...(of.origin === undefined ? {} : { origin: of.origin }) },
    identifier: of.identifier,
    note: { id: noteIdOf(of.site, of.note) },
    at: new Date(of.at).toISOString(),
  });
}
