import { eq } from 'drizzle-orm';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { screenshots } from './postgres-schema.ts';
import type { ScreenshotStore } from './screenshots.ts';

/** The pictures of the notes, in the database of the worker (FRU-44). See `screenshots.ts`. */
export function createPostgresScreenshotStore(database: Database): ScreenshotStore {
  return {
    async put(screenshot) {
      await migrated(database);
      await database.run((db) =>
        db.insert(screenshots).values({
          id: screenshot.id,
          workspace_id: screenshot.workspace,
          account_id: screenshot.account,
          content: screenshot.png,
          width: screenshot.width,
          height: screenshot.height,
          created_at: screenshot.createdAt,
        }),
      );
    },
    async get(id) {
      await migrated(database);
      const [row] = await database.run((db) => db.select().from(screenshots).where(eq(screenshots.id, id)).limit(1));
      if (row === undefined) return undefined;

      return {
        id: row.id,
        workspace: row.workspace_id,
        account: row.account_id,
        png: row.content,
        width: row.width,
        height: row.height,
        createdAt: row.created_at,
      };
    },
  };
}
