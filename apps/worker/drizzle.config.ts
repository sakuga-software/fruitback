import { defineConfig } from 'drizzle-kit';

/**
 * What `drizzle-kit` reads (FRU-180). It writes the migrations and never applies them: the worker
 * does, with `migrate` of `src/postgres-migrate.ts`, under a lock. No address of a database is here,
 * and `generate` opens none.
 *
 * `migrations` names the table the worker writes, so a `drizzle-kit migrate` that somebody runs by
 * hand reads the same journal as the worker and not a second one.
 */
export default defineConfig({
  dialect: 'postgresql',
  // The tables of the worker, and the ones of better-auth: one database, one schema, one journal.
  // The schema is `public` here, and the worker writes the one of `FRUITBACK_DATABASE_SCHEMA` in its
  // place when it applies a migration (`inSchema` of `postgres-migrate.ts`, FRU-219).
  schema: ['./src/postgres-schema.ts', './src/auth-schema.ts'],
  out: './drizzle',
  migrations: { table: '__drizzle_migrations', schema: 'public' },
});
