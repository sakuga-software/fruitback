#!/bin/sh
# The restore of the PostgreSQL database, tried from one end to the other (FRU-143).
#
# It starts a database and a worker, fills every table, takes a snapshot with snapshot-pg.sh, and
# restores it on another server with the commands of the runbook (README.md, « Restore the
# database »). It then compares every table of the two databases: the number of rows, and a digest
# of the rows. Last it takes a snapshot whose dump lost its end, and checks that the copy before stays.
#
# CI runs it in the `docker image` job. On a machine:
#   WORKER_IMAGE=<an image of the worker> sh apps/worker/cloud/restore-drill.sh
# It makes its own containers, network and volume under one name, publishes no port, and removes
# them when it ends.
set -eu

: "${WORKER_IMAGE:?the image of the worker to try, for example fruitback-worker:ci}"
PG_IMAGE=${PG_IMAGE:-postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24}
HERE=$(cd "$(dirname "$0")" && pwd)
P=fruitback-drill-$$
PASSWORD=drill-not-a-real-password
WORK=$(mktemp -d)

cleanup() {
  docker rm -f "$P-source" "$P-worker" "$P-restored" >/dev/null 2>&1 || true
  docker network rm "$P" >/dev/null 2>&1 || true
  docker volume rm "$P-data" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "restore-drill: $*" >&2
  exit 1
}

# Over TCP, and not on the socket: the image starts a first server on the socket alone to make
# the database, then stops it. A check on the socket answers during that time.
ready() {
  for attempt in $(seq 1 60); do
    if docker exec "$1" pg_isready -h 127.0.0.1 -U fruitback -d fruitback -q; then return 0; fi
    sleep 1
  done
  fail "$1 never became ready"
}

database() {
  docker run -d --name "$1" --network "$P" \
    -e POSTGRES_USER=fruitback -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=fruitback "$PG_IMAGE" >/dev/null
  ready "$1"
}

# One line for each table: its name, its number of rows, and a digest of its rows in one order.
# The name is quoted: better-auth names a table "user", which is a reserved word.
tables() {
  for table in $(docker exec "$1" psql -U fruitback -d fruitback -Atc \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"); do
    docker exec "$1" psql -U fruitback -d fruitback -At -F ' ' -c \
      "SELECT '$table', count(*), coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '-') FROM public.\"$table\" t"
  done
  # And one line for each sequence: its name and the last number it gave (FRU-218). The number of a
  # note is `FB-<n>`: a restore that left a sequence at its start would give a new note the number
  # of one that exists.
  docker exec "$1" psql -U fruitback -d fruitback -At -F ' ' -c \
    "SELECT 'sequence:' || sequencename, coalesce(last_value, 0), '-' FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename"
}

snapshot() {
  PG_CONTAINER="$P-source" WORKER_CONTAINER="$P-worker" sh "$HERE/snapshot-pg.sh"
}

docker network create "$P" >/dev/null
docker volume create "$P-data" >/dev/null

echo "restore-drill: 1. a database, a worker on it, and rows in every table"
database "$P-source"
docker run -d --name "$P-worker" --network "$P" -v "$P-data:/data" \
  -e ALLOWED_ORIGINS=http://localhost:5173 \
  -e LINEAR_API_KEY=drill-not-a-real-key \
  -e LINEAR_TEAM_ID=drill-team \
  -e FRUITBACK_IDENTITY_SECRET=drill-not-a-real-secret-of-32-characters \
  -e FRUITBACK_CONSOLE_URL=https://app.fruitback.example \
  -e "FRUITBACK_DATABASE_URL=postgres://fruitback:$PASSWORD@$P-source:5432/fruitback" \
  "$WORKER_IMAGE" >/dev/null
# The worker makes its tables at the first call that needs the database. `pair` is one.
docker exec "$P-worker" node server.mjs pair --subject drill >/dev/null
docker exec -i "$P-source" psql -U fruitback -d fruitback -q -v ON_ERROR_STOP=1 <"$HERE/drill-seed.sql"
tables "$P-source" >"$WORK/source.txt"
EMPTY=$(awk '$2 == 0 { printf "%s ", $1 }' "$WORK/source.txt")
[ -z "$EMPTY" ] || fail "no row in: $EMPTY. A table with no row, or a sequence that gave no number, proves nothing: add its rows to drill-seed.sql."

echo "restore-drill: 2. the snapshot, as the host takes it"
snapshot
GOOD=$(docker exec "$P-worker" sha256sum /data/snapshots/fruitback.pgdump | cut -d' ' -f1)

echo "restore-drill: 3. another server with an empty database, and the restore of the runbook"
database "$P-restored"
docker cp "$P-worker:/data/snapshots/fruitback.pgdump" "$WORK/fruitback.pgdump"
PG=$P-restored
# From here to the next comment, the commands are the ones of README.md, in its order. A change to
# one side is a change to the other.
test -s "$WORK/fruitback.pgdump" &&
  docker cp "$WORK/fruitback.pgdump" "$PG:/tmp/fruitback.pgdump" &&
  docker exec "$PG" pg_restore -f /dev/null /tmp/fruitback.pgdump &&
  docker exec "$PG" createdb -U fruitback fruitback_restored &&
  docker exec "$PG" pg_restore -U fruitback -d fruitback_restored --no-owner --exit-on-error /tmp/fruitback.pgdump &&
  test "$(docker exec "$PG" psql -U fruitback -d fruitback_restored -Atc 'SELECT count(*) FROM "user"')" -gt 0 &&
  docker exec "$PG" psql -U fruitback -d postgres -q \
    -c 'ALTER DATABASE fruitback RENAME TO fruitback_before' \
    -c 'ALTER DATABASE fruitback_restored RENAME TO fruitback' ||
  fail "the restore of the runbook stopped before its end"
# The end of the commands of the runbook.

echo "restore-drill: 4. every table, in the source and in the restored database"
tables "$P-restored" >"$WORK/restored.txt"
printf '%-20s %8s %8s  %s\n' table source restored rows
paste -d ' ' "$WORK/source.txt" "$WORK/restored.txt" |
  awk '{ printf "%-20s %8s %8s  %s\n", $1, $2, $5, ($2 == $5 && $3 == $6 ? "the same" : "DIFFERENT") }'
cmp -s "$WORK/source.txt" "$WORK/restored.txt" || fail "the restored database is not the source"

# The dump loses its last 100 bytes, and not its half. The table of contents is at the start of the
# file: a small dump cut to half loses a part of it, and `pg_restore --list` then refuses the dump
# too. With the end alone gone, only a check that reads the whole file refuses it (measured: this
# step passed with `--list` in snapshot-pg.sh while the dump was cut to half).
echo "restore-drill: 5. a dump that lost its end replaces nothing"
# As root (`-u 0`), here and in step 6: the file goes in /usr/local/bin, and the user of an image
# given in PG_IMAGE may not write there (measured with `USER postgres`: « Permission denied »).
docker exec -i -u 0 "$P-source" sh -c 'cat >/usr/local/bin/pg_dump_cut && chmod +x /usr/local/bin/pg_dump_cut' <<'CUT'
#!/bin/sh
# pg_dump, and then its file without its end: a disk that is full, a process that was killed.
pg_dump "$@" || exit 1
while [ $# -gt 1 ]; do
  if [ "$1" = -f ]; then file=$2; fi
  shift
done
size=$(stat -c %s "$file")
head -c $((size - 100)) "$file" >"$file.cut" && mv "$file.cut" "$file" && echo "$size" >/tmp/pg_dump_cut.ran
CUT
if PG_DUMP=pg_dump_cut snapshot; then fail "a dump that lost its end was accepted"; fi
docker exec "$P-source" test -s /tmp/pg_dump_cut.ran || fail "the dump was not cut: this check proved nothing"
AFTER=$(docker exec "$P-worker" sha256sum /data/snapshots/fruitback.pgdump | cut -d' ' -f1)
[ "$GOOD" = "$AFTER" ] || fail "a dump that lost its end replaced the copy before"

# Nothing of a failed snapshot is left behind: a dump that stopped half way still holds accounts.
left() {
  docker exec "$P-source" sh -c 'ls /tmp/fruitback.pgdump.* 2>/dev/null' || true
  docker exec "$P-worker" sh -c 'ls /data/snapshots/*.tmp 2>/dev/null' || true
}
[ -z "$(left)" ] || fail "a failed snapshot left a file: $(left)"

echo "restore-drill: 6. a pg_dump that stops half way replaces nothing, and leaves nothing"
docker exec -i -u 0 "$P-source" sh -c 'cat >/usr/local/bin/pg_dump_dies && chmod +x /usr/local/bin/pg_dump_dies' <<'DIES'
#!/bin/sh
# pg_dump, and then a failure after it wrote: a process that was killed while it wrote.
pg_dump "$@" && echo ran >/tmp/pg_dump_dies.ran
exit 1
DIES
if PG_DUMP=pg_dump_dies snapshot; then fail "a pg_dump that failed was accepted"; fi
docker exec "$P-source" test -s /tmp/pg_dump_dies.ran || fail "the dump did not run: this check proved nothing"
AFTER=$(docker exec "$P-worker" sha256sum /data/snapshots/fruitback.pgdump | cut -d' ' -f1)
[ "$GOOD" = "$AFTER" ] || fail "a pg_dump that failed replaced the copy before"
[ -z "$(left)" ] || fail "a pg_dump that failed left a file: $(left)"

ROWS=$(awk '{ sum += $2 } END { print sum }' "$WORK/source.txt")
echo "restore-drill: done. $(wc -l <"$WORK/source.txt" | tr -d ' ') tables and $ROWS rows are the same on both sides, and a failed snapshot replaced nothing and left nothing."
