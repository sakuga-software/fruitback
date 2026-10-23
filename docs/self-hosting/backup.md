# Back up and restore

Everything the instance keeps is in its database: back it up with `pg_dump`, and keep apart the four
secrets that no dump holds.

## Back it up

The database holds everything the instance keeps: the notes and the replies of the store `postgres`,
the accounts, the workspaces and their sites, the sessions as digests, and the keys of the connectors
encrypted. A note that a site sent to Linear or GitHub is in that tracker, and its backups are the
tracker's.

Back it up with PostgreSQL's own tool, never with a copy of the volume: the files of a database that
runs are not a copy to trust. The second command reads the dump to its end. `pg_restore --list` is not
that check: it reads the table of contents, and accepts a dump cut to a tenth of its size (measured).

```bash
docker compose exec -T postgres pg_dump -Fc -U fruitback -d fruitback -f /tmp/fruitback.pgdump &&
docker compose exec -T postgres pg_restore -f /dev/null /tmp/fruitback.pgdump &&
docker compose cp postgres:/tmp/fruitback.pgdump "./fruitback-$(date +%F).pgdump"
```

Measured on 2026-10-16: the dump held the data of every table of the worker, `seeds`,
`seed_comments`, `sites`, `user` and `session` among them.

**Four values are in no dump: keep them apart, somewhere other than the server.**

- `FRUITBACK_POSTGRES_PASSWORD`: the database keeps the password it was made with. A new one in `.env`
  does not change it, and the worker then cannot connect.
- `FRUITBACK_AUTH_SECRET`: lost or changed, every session of the console ends, and everybody signs in
  again.
- `FRUITBACK_IDENTITY_SECRET`: lost or changed, every extension gets `401` until its next refresh.
- `FRUITBACK_SECRETS_KEY`, if you set one: without it, the keys of the connectors do not open, and
  each workspace adds its key again.

With `FRUITBACK_DATABASE_SCHEMA`, dump the schema only: `pg_dump -n fruitback`, as
`apps/worker/cloud/snapshot-pg.sh` does with `PGSCHEMA=fruitback`. A dump of the whole database holds
the other application too.

## Restore it

The dump is restored in a new database, and the two names are exchanged at the end. The database that
was in service stays whole, under the name `fruitback_before`. `test -s` refuses a file that is missing
or empty before anything is stopped, and the commands stop at the first step that fails: the worker
then stays stopped. Fix the cause, and run them again.

```bash
test -s ./fruitback-2026-10-16.pgdump &&
docker compose stop worker &&
docker compose cp ./fruitback-2026-10-16.pgdump postgres:/tmp/restore.pgdump &&
docker compose exec -T postgres pg_restore -f /dev/null /tmp/restore.pgdump &&
docker compose exec -T postgres createdb -U fruitback fruitback_restored &&
docker compose exec -T postgres pg_restore -U fruitback -d fruitback_restored --no-owner --exit-on-error /tmp/restore.pgdump &&
docker compose exec -T postgres psql -U fruitback -d postgres -q \
  -c 'ALTER DATABASE fruitback RENAME TO fruitback_before' -c 'ALTER DATABASE fruitback_restored RENAME TO fruitback' &&
docker compose up -d --wait
```

Measured on 2026-10-16, with this compose file: with the name of a file that does not exist, the
commands stopped at `test -s`, and the worker kept serving. With the dump, a pin planted after the
backup was gone, the pin planted before it was read, and the server held `fruitback` and
`fruitback_before`. The worker starts with an empty read cache. A second restore needs the name
`fruitback_before` free. Remove that database with `dropdb` when you are sure you do not need it: that
last step was not run in the trial.

## Change `FRUITBACK_IDENTITY_SECRET`

The worker signs with this key the access token of a session of the extension. The console signs in
with the cookie of better-auth, which this key does not sign.

- **Give it to no site.** A site signs nothing: who reads it is chosen in the console.
- **Change it if a site ever had it**, for example an instance of before FRU-225 that served one site
  with no accounts, and when you think it was read by somebody else.

To change it, set a new value of 32 characters or more, different from `FRUITBACK_SECRETS_KEY` and
`FRUITBACK_AUTH_SECRET`, and start the worker again. What it cuts:

- Every token signed with the old key answers `401` at once.
- **Nobody signs in again, and no extension pairs again.** A session of an extension is kept as a
  digest of its refresh token, which this key does not sign: the extension gets a new access token
  at its next refresh. A console session is not signed with this key at all.
- **It ends no session.** Deleting a workspace ends the extensions paired for it, and so does
  removing the person from it.
