import { DEFAULT_NOTE_STAGE, type NoteStage } from '@fruitback/shared';
import { requestAgent } from './agent-triggers.ts';
import type { AccountStore } from './accounts.ts';
import { type DoneNoticeSeams, sendDoneNotices } from './done-notices.ts';
import { OWN_SOURCE, readSiteStatus } from './site-statuses.ts';

/**
 * A status asked by the console (FRU-384): `own:<key>`, a key of the worker's store. Answers the key,
 * or the error of the route.
 */
export function ownKeyOf(asked: unknown): { key: string } | { error: 'invalid-status' | 'not-own' } {
  const prefix = `${OWN_SOURCE}:`;
  if (typeof asked !== 'string') return { error: 'invalid-status' };
  if (!asked.startsWith(prefix)) return { error: 'not-own' };
  const key = asked.slice(prefix.length);
  if (!readSiteStatus({ source: OWN_SOURCE, key, stage: DEFAULT_NOTE_STAGE }).ok) return { error: 'invalid-status' };

  return { key };
}

/**
 * What follows a status a person chose in the console, for one note or several (FRU-656): moved to
 * Done, whoever left it is told, once (FRU-604, `take` holds the once); moved to To do from another
 * stage, the trigger of its site may call (FRU-468).
 */
export async function afterStatusMoved(
  context: {
    workspace: string;
    done?: DoneNoticeSeams;
    accounts: Pick<AccountStore, 'agentTrigger' | 'enqueueDelivery'>;
  },
  moved: { site: string; note: string; identifier: string; page: string; stage: NoteStage; was: NoteStage },
): Promise<void> {
  if (moved.stage === 'done' && moved.was !== 'done' && context.done !== undefined) {
    void sendDoneNotices(context.done, moved.site, [
      { stage: 'done', note: { id: moved.note, page: { url: moved.page } } },
    ]);
  }
  if (moved.stage === 'todo' && moved.was !== 'todo') {
    await requestAgent(
      context.accounts,
      {
        workspace: context.workspace,
        site: moved.site,
        identifier: moved.identifier,
        note: moved.note,
        reason: 'moved-to-todo',
      },
      Date.now(),
    );
  }
}
