# Upgrade and roll back

**Upgrade:**

1. [Back up](backup.md#back-it-up) every database.
2. Write down the image you run now, as a digest from the registry:

   <!-- {% raw %} -->

   ```bash
   docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
     "$(docker compose images -q worker)" | grep '^ghcr.io/'
   ```

   <!-- {% endraw %} -->

   Keep the `ghcr.io/` line. An image that also has a local tag lists a name no registry serves, and
   on the containerd image store that name came first (measured).

3. If `FRUITBACK_IMAGE` in `.env` names a digest, or a version such as `1.4.2`, set it to the new
   one first: the pull below does not change a digest, and a version tag moves only when that release
   is rebuilt. A moving tag (`edge`, `latest`, `1.4`) needs nothing set: the pull takes its new image.
   Pull and restart, then check `/health` and a read:

   ```bash
   docker compose pull
   docker compose up -d --wait
   ```

The database migrates by itself, at the first request that needs it, under a lock, with the
migrations that `drizzle-kit` wrote (FRU-180). A database that an earlier image made with its own
migration tool is adopted as it is, and nothing in it runs again, when that image had the tables of
better-auth (FRU-144, image `sha-e74be5311941918429e9b5cf15a1518e49ba828c`, and the ones after it). A
database that an image from before FRU-144 made is refused, and the log says why: start that image of
FRU-144 on it once, then the new one. An image of before still opens a database that was adopted.

**Roll back:** set `FRUITBACK_IMAGE` in `.env` to the digest from step 2, then
`docker compose up -d --wait`.

**An older image does not refuse a database that a newer one migrated.** It runs its own code against
the newer schema. When a release adds a migration that an older image cannot read, its notes say so,
and a rollback past it means restoring the backup from step 1 — and losing the pins planted since.

**`0030_note_names` (FRU-378) renames tables: an image of before it cannot read the database after
it.** The tables `seeds` and `seed_comments` are now `notes` and `note_comments`. The columns `seed`
and `seed_id` are now `payload` and `note_id`, and the sequences, indexes and keys follow. Only names
change, no row is rewritten, and the migration takes a lock for the time it needs to rename. To roll
back past it, stop the worker, run the reverse statements (`REVERSE_SQL` in
`apps/worker/src/note-names-migration.test.ts`, which proves them) with `psql`, then start the image
of before. Without them, every query of the image of before that names `seeds` fails: the table is
not there.

**What an instance of before FRU-225 loses on the way, and nothing else:** the pairings of the
extension, when it had no accounts. Each reviewer pairs again, once, from the console. The notes, the
sites and the accounts move with `migrate-to-postgres`, below.

## Upgrading a worker of before 0.4.0 (FRU-378)

**A worker of before 0.4.0 goes through 0.4.0 first, and runs `node server.mjs rewrite-notes` there,
before it takes a later version**: the notes it wrote are of a kind that no later worker reads, and
the command that rewrote them is gone since FRU-449.

**What 0.4.0 changes for what reads Fruitback**, beside the pins: the extension 0.3.0 reads the old
answer of `GET /session/notes` and needs 0.4.0; a receiver of the REST connector written for version
1 receives version 2 (`docs/rest-connector.md`); `node server.mjs forget` takes `--note`, and
`migrate-to-postgres` takes `--notes`.

**The widget 0.3.0 and the worker 0.4.0 do not work together**: the widget cannot send a note
(`invalid-note`) and draws no pin. Update the worker, the widget and the extension at the same time.
The widget 0.4.0 keeps the notes saved for later under a new key of `sessionStorage`, so **the drafts
that the widget 0.3.0 kept in an open tab are lost** (Mathieu's decision of 2026-10-25: no reader of
the payload of before in the widget). A draft lives only as long as its tab.

## Upgrading a worker that has no database (FRU-225)

A worker with no `FRUITBACK_DATABASE_URL` stops at the upgrade: `/health` answers `503`, every other
route `500`, and the log names `FRUITBACK_DATABASE_URL`, the four variables below and this section
(measured on the image). Nothing is lost: the files stay on the volume, and the image of before
still reads them. To move:

1. Take the new `docker-compose.yml` and the new `.env.example`. In `.env`, fill the five lines that
   `.env.example` asks for: `FRUITBACK_POSTGRES_PASSWORD`, `FRUITBACK_AUTH_SECRET`,
   `FRUITBACK_IDENTITY_SECRET` (keep the one of before if it had one), `FRUITBACK_FIRST_ADMIN`, and the
   two addresses, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL`. Empty `FRUITBACK_CLIENTS`,
   `FRUITBACK_SESSION_PATH`, `FRUITBACK_SQLITE_PATH` and `FRUITBACK_FIRST_REVIEWER`, and set
   `FRUITBACK_STORE=postgres`, or `linear` or `github` to keep sending the notes to that tracker.
2. `docker compose up -d --wait`, then open the link of `docker compose logs worker`: the first
   administrator makes the first workspace. Add each site in the console, one for each client of
   `FRUITBACK_CLIENTS`, or one for the one client of a worker that had no map.
3. A worker that kept its notes in SQLite copies them:
   [Moving the notes of the SQLite file into PostgreSQL](#moving-the-notes-of-the-sqlite-file-into-postgresql).
   Notes in Linear or GitHub stay there: the site reads them where they are, once the console gives
   it that tracker, or through `FRUITBACK_STORE`.
4. **Each reviewer pairs the extension again, once**, from the console. A session of a worker with
   no workspace names no member, and is not copied.

**The way back** is the image of before, by its digest, and the `.env` of before.

## Upgrading a deployment that has an accounts file

Only for a worker that had `FRUITBACK_ACCOUNTS_PATH`. Since FRU-150 the accounts are in PostgreSQL
and nowhere else, and the worker **refuses to start** with that variable: `/health` answers `500`
and the log says what to set. It does not start without the accounts, because a console with no
workspace reads as the accounts lost. The same holds for `FRUITBACK_GITHUB_OAUTH`, the GitHub App of
the sign-in of before.

1. Keep the image that runs, by its digest (step 2 of « Upgrade »), and stop the worker. Copy
   `accounts.db` and `sessions.db`, each with its `-wal`, out of the volume: they are the way back.
2. Take the new `docker-compose.yml`, set `FRUITBACK_POSTGRES_PASSWORD` in `.env`
   (`openssl rand -hex 32`), and start the database alone: `docker compose up -d --wait postgres`.
3. Copy the two files into it, with the new image. The command reads `FRUITBACK_DATABASE_URL` and
   the two paths, and never writes the files. Try it with `--dry-run` first, then without:

   ```bash
   docker compose run --rm --no-deps worker \
     node server.mjs migrate-to-postgres --accounts /data/accounts.db --sessions /data/sessions.db --dry-run
   ```

   Each line says `same`, and the last one `dry run`, then `copied`. A file of a worker older than the
   last one with an accounts file is refused: start that last image on it once, then copy.

4. In `.env`: remove `FRUITBACK_ACCOUNTS_PATH`, `FRUITBACK_SESSION_PATH` and
   `FRUITBACK_GITHUB_OAUTH`; set `FRUITBACK_DATABASE_URL`, `FRUITBACK_AUTH_SECRET` (32 random
   characters or more, not one of the other secrets) and `FRUITBACK_PUBLIC_URL`. For GitHub, a
   GitHub OAuth App whose callback is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/github`, in
   `FRUITBACK_AUTH_GITHUB_OAUTH`. For Google, the redirect URI of the client becomes
   `<FRUITBACK_PUBLIC_URL>/console/auth/callback/google`.
5. `docker compose up -d --wait`, with the console of the same release. The log
   says « better-auth is ready, under /console/auth ». **Everybody signs in to the console again,
   once**, with the same address or the same GitHub or Google account, and finds their workspaces. No
   extension pairs again.

**The way back** is the image of step 1, the `.env` of before and the two files. What was written
to the database since is not in them.

The copy is held by `postgres-copy.test.ts` and `accounts-move.test.ts`, on PGlite and on
PostgreSQL 17. **Not tried:** these five steps with `docker compose`, as written here.

## Moving the notes of the SQLite file into PostgreSQL

For a worker that kept its notes itself, with `FRUITBACK_STORE=sqlite`, which was the default of the
compose file. PostgreSQL is required since FRU-225, and that file is read by nothing else. The notes
and their replies move with one command, and **a pin keeps its number**.

1. Keep the image that runs, by its digest, and stop the worker. Copy the file of
   `FRUITBACK_SQLITE_PATH` with its `-wal` out of the volume: it is the way back.
2. Steps 1 and 2 of [Upgrading a worker that has no database](#upgrading-a-worker-that-has-no-database-fru-225):
   the database, the console, and each site. A site has an id of its own, which the console shows.
3. Try the copy, then run it without `--dry-run`. It reads `FRUITBACK_DATABASE_URL`, and never
   writes the file:

   ```bash
   docker compose run --rm --no-deps worker \
     node server.mjs migrate-to-postgres --notes /data/fruitback.db --no-client <the id of the site> --dry-run
   ```

   `--no-client` gives a site the notes of a worker that had one client. A worker that had
   `FRUITBACK_CLIENTS` takes one `--client <its id of before>=<the id of the site>` for each client.
   The command says, for each client of the file, how many notes it has and where they go, and
   whether that is a site of the database: **a note that goes to no site is copied, and no page
   reads it**. The two lines of counts say `same`, and the last one `dry run`, then `copied`.

4. Nothing to change in `.env`: step 1 of the section above set `FRUITBACK_STORE=postgres` and
   emptied the variables of before. The notes of the file are of the kind of before 0.4.0: make the
   copy with the image of 0.4.0, and run `rewrite-notes` there. A later image refuses the file (see
   [Upgrading a worker of before 0.4.0](#upgrading-a-worker-of-before-040-fru-378)).
5. **Each reviewer pairs the extension again, once**: `pair` writes its code in the database now.
   A session of a worker that had no accounts names no member of a workspace, and is not copied.

**The way back** is the image of step 1, the `.env` of before and the file. A note sent since is
not in it. `apps/worker/cloud/README.md`, « Switch 1 bis », is the same switch for the Cloud, with
what was tried. **Not tried:** these five steps with `docker compose`, as written here.

## Upgrading a deployment from before FRU-48

The old compose file built the image, kept no volume, read `PORT` for the host port, defaulted
`TRUSTED_PROXY_HOPS` to 1, and passed no `FRUITBACK_STORE`, so the worker ran on Linear. An `.env`
written for it keeps those values, and the new file reads it differently. **Since FRU-225 this is the
first half of the move**: the files land on the volume of the new file, and
[Upgrading a worker that has no database](#upgrading-a-worker-that-has-no-database-fru-225) then
copies them into the database. The blocks below were measured before FRU-225; the last command of the
second one starts a worker that refuses to serve until `.env` has the lines that section names.

**If the old deployment kept SQLite notes or extension sessions under `/data`, copy them out first.**
The old file mounted no volume, so `/data` was an anonymous volume that the image of before declared. The new
file mounts the named volume there, which starts empty, and the pins and sessions then seem to be
gone. The old volume is not deleted, but nothing mounts it.

In the `for` line of both blocks below, write the files the old deployment used: the value of
`FRUITBACK_SQLITE_PATH`, and the value of `FRUITBACK_SESSION_PATH` if it was set. A file outside
`/data` was never on a volume, and nothing is left to copy. The list is written in the loop, not in a
variable, because zsh does not split a variable into words. With the **old** file still in place:

```bash
for db in /data/fruitback.db /data/sessions.db; do
  docker compose exec -T worker sqlite3 "$db" ".backup '$db.migrate'" &&
  docker compose cp "worker:$db.migrate" "./$(basename "$db").migrate"
done
```

Then replace the compose file, and make the changes below with the **same** paths in `.env`. Restore
into the new volume before the worker serves anything. `docker compose create` makes the container and
the empty volume without starting it, each restore runs in a one-off container, and the worker starts
only if every restore succeeded:

```bash
docker compose create &&
ok=yes &&
for db in /data/fruitback.db /data/sessions.db; do
  docker compose cp "./$(basename "$db").migrate" "worker:$db.migrate" &&
  docker compose run --rm --no-deps --entrypoint sh worker -c \
    "test -s '$db.migrate' && sqlite3 '$db' \".restore '$db.migrate'\" && rm -f '$db.migrate' '$db.migrate-shm' '$db.migrate-wal'" ||
  { ok=no; echo "restore of $db failed: the worker stays stopped"; break; }
done &&
[ "$ok" = yes ] &&
docker compose up -d --wait
```

If a restore fails, the worker is not started, and the old volume and the `.migrate` files are left
as they were: fix the cause, then run the block again.

Measured with sessions on, in bash and in zsh, on a volume that started empty: with both files, the
pin was back and the pairing code was still in `sessions.db`. With `sessions.db.migrate` missing, the
block stopped at that restore, and the worker was created but never started.

Before the first `docker compose up` with the new file, change these lines in `.env`:

1. **If the notes are in Linear, add `FRUITBACK_STORE=linear`.** Otherwise the worker refuses to start,
   and says to name the store: a worker with a key of Linear and no store ran on Linear before FRU-225.
2. **Rename `PORT` to `FRUITBACK_PORT`.** The new file ignores `PORT`, so a custom host port falls
   back to 8080.
3. **Set `TRUSTED_PROXY_HOPS` to the number of proxies in front.** The old template wrote 1. Keep 1
   behind one Traefik; change it to 0 if the port is published directly, or a forged
   `X-Forwarded-For` escapes the rate limit.
4. **Add `FRUITBACK_IMAGE`** only to choose a version or to pin a digest. Without it, the file pulls `edge`.

## Tags and digests

Every push to `main` publishes `ghcr.io/sakuga-software/fruitback-worker`, for `linux/amd64` and
`linux/arm64`. Docker picks the architecture from the manifest list; there is no per-architecture tag.

**`edge` and not `latest`, until the first release.** The versioned tags come from a `v*` git tag, so
before one is pushed `latest`, `1.4.2` and `1.4` resolve to nothing, and asking for one gets
`manifest unknown`. `edge` and `sha-<commit>` exist from the first merge onwards.

| Tag            | Moves                           | Published by         | Use it for                                                                                                 |
| -------------- | ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `1.4.2`        | Only if that release is rebuilt | A `v1.4.2` git tag   | Choosing a release for production. Pin its digest, from step 2 of the upgrade, to deploy and to roll back. |
| `1.4`          | On every patch in that minor    | Any `v1.4.x` git tag | Taking patches without reading a changelog. It moves — do not call it a pin.                               |
| `latest`       | On every release                | Any `v*` git tag     | A deployment that follows releases and nothing else.                                                       |
| `edge`         | Every push to `main`            | A merge to `main`    | Running what is not released yet.                                                                          |
| `sha-<commit>` | Only if that commit is rebuilt  | Every publish        | Naming one commit's build, in an incident or a bisect.                                                     |
| `@sha256:…`    | **Never**                       | Every publish        | The only immutable reference. Pin this when it must not move.                                              |

`latest` does **not** follow `main`: a `latest` that moved on every merge would take away the one
thing a tag is for.

**No tag is immutable, `sha-<commit>` included.** Re-running the workflow on the same commit, or
publishing a `v*` tag that points at a commit already on `main`, builds again and republishes every
tag it computes. `org.opencontainers.image.created` moves, so the digest does. A tag names a commit;
only a digest names a build.

The image runs as `node` rather than root, carries no `node_modules` — the build stage bundles
everything into one file — and declares a `HEALTHCHECK` against `/health`. Every published build ships
a provenance attestation and an SBOM:

<!-- {% raw %} -->

```bash
gh attestation verify oci://ghcr.io/sakuga-software/fruitback-worker:edge --owner sakuga-software
docker buildx imagetools inspect ghcr.io/sakuga-software/fruitback-worker:edge --format '{{json .SBOM}}'
```

<!-- {% endraw %} -->

**Nothing is published before it has been booted and scanned, on every architecture.** The release
workflow builds each platform separately, starts it, waits for `/health`, asserts the image still
**refuses** `FRUITBACK_STORE=memory`, and runs Trivy at `CRITICAL,HIGH`. Both must pass before either
is pushed.
