#!/bin/sh
# A consistent copy of the PostgreSQL database of Fruitback Cloud (api.fruitback.com). FRU-143.
# The host archives every Docker volume at 03:00, and the files of a database that runs are not a
# copy to trust. This writes a dump with PostgreSQL's own tool into the volume of the worker, beside
# the copies of snapshot.sh, before 03:00. snapshot.sh still copies the notes (fb.db).
# WARNING: FRUITBACK_SECRETS_KEY, FRUITBACK_IDENTITY_SECRET and the password of the database are in
# no backup. Without the first the connector keys do not open. Without the second every session ends.
set -eu

# The two services, as Dokploy names them. PG_CONTAINER and WORKER_CONTAINER name a container
# directly: restore-drill.sh uses them, and a host that does not run Swarm can too.
PG_SERVICE=${PG_SERVICE:-fruitback-cloud-postgres}
WORKER_SERVICE=${WORKER_SERVICE:-fruitback-cloud-worker-a9zdeo}
PGUSER=${PGUSER:-fruitback}
PGDATABASE=${PGDATABASE:-fruitback}
# The command that dumps, in the container of the database. restore-drill.sh gives one that cuts
# the end of its file, to check that a dump which is not whole replaces nothing.
PG_DUMP=${PG_DUMP:-pg_dump}
DIR=/data/snapshots
NAME=fruitback.pgdump

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) snapshot-pg: $*"; }
container() {
  if [ -n "$1" ]; then echo "$1"; else docker ps -q --filter "label=com.docker.swarm.service.name=$2" | head -1; fi
}

PG=$(container "${PG_CONTAINER:-}" "$PG_SERVICE")
[ -n "$PG" ] || { say "no container for the database ($PG_SERVICE)"; exit 1; }
WORKER=$(container "${WORKER_CONTAINER:-}" "$WORKER_SERVICE")
[ -n "$WORKER" ] || { say "no container for the worker ($WORKER_SERVICE)"; exit 1; }

# 1. The dump, in a file where pg_dump runs. No pipe: the exit status is the one of pg_dump.
TMP=/tmp/$NAME.$$
docker exec "$PG" "$PG_DUMP" -Fc -U "$PGUSER" -d "$PGDATABASE" -f "$TMP"

# 2. Read to its end. `pg_restore --list` is not that check: it reads the table of contents, which
#    is at the start of the file, and accepts a dump cut to a tenth of its size (measured).
if ! docker exec "$PG" pg_restore -f /dev/null "$TMP"; then
  docker exec "$PG" rm -f "$TMP"
  say "the dump cannot be read to its end. The copy before is left as it is."
  exit 1
fi
SUM=$(docker exec "$PG" sha256sum "$TMP" | cut -d' ' -f1)

# 3. Into the volume of the worker, under another name. A pipe gives the status of its last command
#    only, so the copy is compared with the dump.
docker exec "$WORKER" mkdir -p "$DIR"
docker exec "$PG" cat "$TMP" | docker exec -i "$WORKER" sh -c "cat > '$DIR/$NAME.tmp'"
COPY=$(docker exec "$WORKER" sha256sum "$DIR/$NAME.tmp" | cut -d' ' -f1)
docker exec "$PG" rm -f "$TMP"
if [ "$SUM" != "$COPY" ]; then
  say "the copy in the volume is not the dump. The copy before is left as it is."
  exit 1
fi

# 4. Replaced only after the checks: a copy that failed must not take the place of a good one.
docker exec "$WORKER" mv "$DIR/$NAME.tmp" "$DIR/$NAME"
say "$NAME $(docker exec "$WORKER" stat -c %s "$DIR/$NAME") bytes, sha256 $SUM"
