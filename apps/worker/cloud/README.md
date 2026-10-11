# Fruitback Cloud, on its host

How `api.fruitback.com` and `app.fruitback.com` are run, and how their data is kept (FRU-106,
FRU-128). It is for whoever operates that deployment. A self-hoster reads
[docs/self-hosting.md](../../../docs/self-hosting.md).

## Where it runs

Dokploy project `fruitback-cloud` on `em-sakuga-01`. Two applications follow `main`:

| Application | Address             | Holds                                                 |
| ----------- | ------------------- | ----------------------------------------------------- |
| `worker`    | `api.fruitback.com` | the volume `fruitback-cloud-data`, mounted on `/data` |
| `console`   | `app.fruitback.com` | static files, and no secret                           |

`/data` holds three SQLite files: `fb.db` (the notes), `sessions.db` (the sessions) and `accounts.db`
(the accounts, the workspaces, the sites and the encrypted keys of the connectors).

**After the move of the storage (switch 1, FRU-145), the accounts and the sessions are in PostgreSQL**:
a database service `postgres` in the same Dokploy project, which publishes no port, and
`FRUITBACK_DATABASE_URL` in the environment of the worker. `fb.db` stays on the volume, and so do
`accounts.db` and `sessions.db`: switch 1 reads them and never writes them, and they are its way back
until its point of no return. Until that day, the section « The database » below describes what is
ready, and nothing of it runs.

## What is backed up

1. **02:45, `snapshot.sh`**, from the crontab of the host. It writes a copy of each database into
   `/data/snapshots/` with SQLite's own backup, checks it, and only then replaces the copy before.
2. **03:00, the backup of the host** (`~/backups/backup.sh`). It archives every Docker volume to the
   bucket `backup-elastic-metal` on Scaleway Object Storage, under the date, and keeps 30 days.

The archive of the volume holds the live files and the snapshots. **Restore from the snapshots**: a
live file was open when it was archived.

**`FRUITBACK_SECRETS_KEY` and `FRUITBACK_IDENTITY_SECRET` are in no backup**, and neither is the
password of the database once there is one. They are in the
environment of the application in Dokploy, and in the Keychain of the operator's machine
(`fruitback-cloud-secrets-key`, `fruitback-cloud-identity-secret`). Without the first, the keys of
the connectors do not open, and each workspace must add its key again. Without the second, every
session ends.

## Restore

Stop the worker first: it keeps its files open, and a file replaced under it is not read.

```bash
# 1. Get the archive of a day, and take the snapshots out of it.
rclone copy scaleway:backup-elastic-metal/20261009/fruitback-cloud-data.tar.gz /tmp/restore/ &&
  mkdir -p /tmp/restore/data && tar xzf /tmp/restore/fruitback-cloud-data.tar.gz -C /tmp/restore/data &&
  test -s /tmp/restore/data/snapshots/accounts.db

# 2. Stop the worker, put the three files back, start it.
docker service scale fruitback-cloud-worker-a9zdeo=0 &&
  docker run --rm -v fruitback-cloud-data:/data -v /tmp/restore/data/snapshots:/from:ro alpine sh -c \
    'set -e; test -s /from/accounts.db; test -s /from/sessions.db;
     for f in accounts.db sessions.db fb.db; do
       if [ -s /from/$f ]; then rm -f /data/$f-wal /data/$f-shm; cp /from/$f /data/$f; chown 1000:1000 /data/$f; fi;
     done' &&
  docker service scale fruitback-cloud-worker-a9zdeo=1
```

Tried on 2026-10-09, on a scratch volume and never on the one in service: the archive the host makes
was unpacked, its snapshots were put in an empty volume, and the restored accounts, workspaces, sites
and sessions counted the same as the live ones. That trial copied the files with the same `cp` and
`chown`, before the check of the two required snapshots was added. The check was tried apart: with
no snapshot of the accounts it answers 1 and reaches no copy. **The command as it is written now has
not been run whole.** Run it once on a scratch volume before the day it is needed.

**A snapshot is in WAL mode, like its source.** SQLite must create a `-shm` file beside it, so it does
not open on a volume mounted read-only (measured: `unable to open database file`). Check a restored
file on a writable mount.

Each step is chained with `&&`, and `test -s` comes before a file is replaced: a missing file must
stop the restore, not empty the database. **The accounts and the sessions are required**: without
either snapshot the command stops before it touches a file, and the worker stays stopped, which is
the state to investigate from. Only `fb.db` can be absent, for a worker that had taken no note when
the snapshot was made; the notes file in the volume is then left as it is. Then check `https://api.fruitback.com/health`, and sign in.

## The database (FRU-143)

Nothing here runs yet. It is what the host does once the accounts and the sessions are in PostgreSQL,
and the « What to do on the host » list says when.

### What is backed up

1. **02:40, `snapshot-pg.sh`**, from the crontab of the host. It dumps the database with `pg_dump
-Fc` where the database runs, reads the dump to its end (`pg_restore -f /dev/null`), and copies it
   into the volume of the worker, as `/data/snapshots/fruitback.pgdump`. It compares the copy with
   the dump, and only then replaces the copy before. A dump that cannot be read to its end replaces
   nothing, and the script exits 1.
2. **02:45, `snapshot.sh`**, as before. Switch 1 leaves `accounts.db` and `sessions.db` on the
   volume, as they were when the worker stopped: they are its way back (FRU-145). So `snapshot.sh`
   still copies the three files, and the copies of those two hold the accounts and the sessions of
   the day of the switch. After the point of no return, a pull request makes it copy `fb.db` alone
   and rewrites the restore above, which requires the two files; then the operator moves them out of
   `/data` (FRU-183).
3. **03:00, the backup of the host**, as before. The archive of the volume of the worker holds the
   dump, because the dump is in that volume. The volume of the database is archived too, and **it is
   not a backup**: the files of a database that runs are not a copy to trust. Restore from the dump.

The dump is checked by reading it to its end, and not with `pg_restore --list`: measured, `--list`
accepts a dump cut to a tenth of its size, because it reads the table of contents at the start of
the file.

### Restore the database

Stop the worker first, so that nothing writes while the database is replaced. The dump is restored
in a new database, and the names are exchanged at the end: the database that was in service stays
whole, as `fruitback_before`, until somebody removes it.

```bash
# 1. Get the archive of a day, and take the dump out of it.
rclone copy scaleway:backup-elastic-metal/20261009/fruitback-cloud-data.tar.gz /tmp/restore/ &&
  mkdir -p /tmp/restore/data && tar xzf /tmp/restore/fruitback-cloud-data.tar.gz -C /tmp/restore/data &&
  test -s /tmp/restore/data/snapshots/fruitback.pgdump

# 2. Stop the worker, restore the dump in a new database, exchange the names, start the worker.
PG=$(docker ps -q --filter label=com.docker.swarm.service.name=fruitback-cloud-postgres | head -1) &&
  test -n "$PG" &&
  docker service scale fruitback-cloud-worker-a9zdeo=0 &&
  docker cp /tmp/restore/data/snapshots/fruitback.pgdump "$PG:/tmp/fruitback.pgdump" &&
  docker exec "$PG" pg_restore -f /dev/null /tmp/fruitback.pgdump &&
  docker exec "$PG" createdb -U fruitback fruitback_restored &&
  docker exec "$PG" pg_restore -U fruitback -d fruitback_restored --no-owner --exit-on-error /tmp/fruitback.pgdump &&
  test "$(docker exec "$PG" psql -U fruitback -d fruitback_restored -Atc 'SELECT count(*) FROM accounts')" -gt 0 &&
  docker exec "$PG" psql -U fruitback -d postgres -q \
    -c 'ALTER DATABASE fruitback RENAME TO fruitback_before' \
    -c 'ALTER DATABASE fruitback_restored RENAME TO fruitback' &&
  docker service scale fruitback-cloud-worker-a9zdeo=1
```

Each step is chained with `&&`, and two checks come before the names are exchanged: the dump is read
to its end, and the restored database has accounts. A failure leaves the worker stopped and the
database in service whole: that is the state to investigate from. `ALTER DATABASE … RENAME` refuses
a database that a session holds; the worker is stopped, so only a `psql` left open would hold it.
Then check `https://api.fruitback.com/health`, and sign in.

**Tried on 2026-10-11, on a laptop and never on the host**, by `restore-drill.sh`, which CI runs in
the `docker image` job on every pull request to `main`. It starts a database and the worker of the
pull request, fills every table (41 rows in 19 tables, `schema_migrations` and the seven tables of
better-auth included), takes a snapshot with `snapshot-pg.sh`, and runs step 2 above on another
server: every table had the same number of rows and the same rows on both sides. It then cut the end
of a dump: the snapshot exited 1, and the copy before was the same, byte for byte.

**Not tried:** step 1 (`rclone`, `tar`), `docker service scale`, the label of a Swarm service in
`snapshot-pg.sh` (the drill names the containers directly), the crontab, a database of real size, and
the time the dump takes on it. Run the whole of step 2 once on the host, on a copy, before the day
it is needed.

### What to do on the host, and in which order

For the operator. **No agent did any of this**: no database was created, no service, no crontab line.
Steps 1 to 3 come before switch 1 (the runbook of FRU-145), step 4 after it.

1. **Create the database in Dokploy**, in the project `fruitback-cloud`: a PostgreSQL 17 service
   named so that its Swarm service is `fruitback-cloud-postgres`, with no external port. The user and
   the database are `fruitback`. If Dokploy names the service otherwise, set `PG_SERVICE` on the
   crontab line of step 3.
2. **Give it a random password of 32 characters or more, letters and digits, and keep it in the
   Keychain** of the operator (`fruitback-cloud-postgres-password`), as the two other secrets. The
   password is in no backup, but the volume of the database is in the archive of 03:00, and it holds
   the verifier of the password: a short one can be guessed from a copy of the archive (`SECURITY.md`).
3. **Copy `snapshot-pg.sh` next to `snapshot.sh` on the host, and add it to the crontab, before
   `snapshot.sh`:**

   ```cron
   40 2 * * * sh /root/fruitback/snapshot-pg.sh >> /var/log/fruitback-snapshot.log 2>&1
   ```

   Run it once by hand. It must write `fruitback.pgdump … bytes`, and `/data/snapshots/` in the
   volume of the worker must hold the file. Before switch 1 the database has no table yet: the dump
   is small, and that is expected.

4. **After switch 1**, the next morning: the log has the line of `snapshot-pg.sh` at 02:40, and the
   archive of 03:00 holds `snapshots/fruitback.pgdump`. Restore it once on a copy, with step 2 above.

`FRUITBACK_AUTH_SECRET` came with better-auth (FRU-144), which stays off on a worker that does not
have it. When the Cloud sets it, it joins the secrets that are in no backup, and step 2 of this list.

## The two OAuth applications

Both send a person back to the worker, so `FRUITBACK_PUBLIC_URL` is `https://api.fruitback.com`.
Each value below is `<client id>:<client secret>`, in the environment of the worker in Dokploy and in
the Keychain of the operator. `saveEnvironment` replaces the whole environment: build it again from
the Keychain entries, and add these two.

| Variable                 | Where the application is made                                                                   | Its callback                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `FRUITBACK_GITHUB_OAUTH` | GitHub, the organisation's settings, « OAuth Apps »                                             | `https://api.fruitback.com/auth/github/callback` |
| `FRUITBACK_GOOGLE_OAUTH` | Google Cloud, « APIs & Services », « Credentials », an OAuth client of type « Web application » | `https://api.fruitback.com/auth/google/callback` |
| `FRUITBACK_LINEAR_OAUTH` | Linear, Settings, API, « OAuth applications »                                                   | `https://api.fruitback.com/auth/linear/callback` |

- **GitHub** signs a person in (FRU-97). The console shows its button only when it is built with
  `VITE_FRUITBACK_GITHUB=1`: set that build argument of the console when the worker has the variable,
  and not before, or the button leads to a `404`.
- **Google** signs a person in (FRU-135). The console asks the worker which providers it has, so it
  needs no build argument. The consent screen of the Google project must be published (« In
  production »), or only its test users can sign in.
- **Linear** connects the Linear of a workspace (FRU-134). The console asks the worker whether it has
  the application, so it needs no build argument. The Cloud serves workspaces of Linear other than
  ours: if the form of the application has a « Public » switch, turn it on. This was not tried yet
  with a second workspace of Linear.
