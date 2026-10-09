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

## What is backed up

1. **02:45, `snapshot.sh`**, from the crontab of the host. It writes a copy of each database into
   `/data/snapshots/` with SQLite's own backup, checks it, and only then replaces the copy before.
2. **03:00, the backup of the host** (`~/backups/backup.sh`). It archives every Docker volume to the
   bucket `backup-elastic-metal` on Scaleway Object Storage, under the date, and keeps 30 days.

The archive of the volume holds the live files and the snapshots. **Restore from the snapshots**: a
live file was open when it was archived.

**`FRUITBACK_SECRETS_KEY` and `FRUITBACK_IDENTITY_SECRET` are in no backup.** They are in the
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
