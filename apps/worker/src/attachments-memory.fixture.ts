import type { AttachmentStore, StoredAttachment } from './attachments.ts';

/** The files in memory, for the tests of the routes (FRU-507: out of `attachments.ts`). A worker keeps its files in PostgreSQL. */
export function createMemoryAttachmentStore(): AttachmentStore & { size(): number; all(): StoredAttachment[] } {
  const held = new Map<string, StoredAttachment>();
  const live = (now: number) => [...held.values()].filter((each) => each.expiresAt > now);

  return {
    size: () => held.size,
    all: () => [...held.values()],
    async put(attachment) {
      held.set(attachment.id, { ...attachment, content: new Uint8Array(attachment.content) });
    },
    async get(id, now) {
      const found = held.get(id);

      return found !== undefined && found.expiresAt > now ? found : undefined;
    },
    async heldBy(account, now) {
      const mine = live(now).filter((each) => each.account === account && each.beforeTransit !== true);

      return { files: mine.length, bytes: mine.reduce((sum, each) => sum + each.content.byteLength, 0) };
    },
    async claim(ids, note, now) {
      const taken: StoredAttachment[] = [];
      for (const id of ids) {
        const found = held.get(id);
        if (found === undefined || found.expiresAt <= now) continue;
        if (found.note !== undefined && found.note !== note) continue;
        found.note = note;
        taken.push(found);
      }

      return taken;
    },
    async endAt(ids, at) {
      for (const id of ids) {
        const found = held.get(id);
        if (found !== undefined && found.expiresAt > at) found.expiresAt = at;
      }
    },
    async remove(ids) {
      for (const id of ids) held.delete(id);
    },
    async sweep(now) {
      let gone = 0;
      for (const [id, each] of held) {
        if (each.expiresAt > now) continue;
        held.delete(id);
        gone += 1;
      }

      return gone;
    },
  };
}
