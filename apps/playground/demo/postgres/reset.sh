#!/bin/sh
# Empties a public demonstration whose notes are in PostgreSQL (FRU-223). Prepared, not in use:
# `../reset.sh` is the script of the demonstration of today, which keeps its notes in SQLite.
#
# It deletes the notes, their replies and their pictures, and gives the numbers of the notes back
# to 1. The workspace and the site stay: seed.sql made them, and runs again here in case the
# database is a new one. The worker is not restarted: it holds no copy of a note.
#
#   PG_CONTAINER=<the container of the database> ORIGIN=https://demo.fruitback.com sh reset.sh
#   PGUSER and PGDATABASE default to `fruitback`.
set -eu
: "${PG_CONTAINER:?the name of the container of the PostgreSQL of the demonstration}"
: "${ORIGIN:?the address of the page of the demonstration, for example https://demo.fruitback.com}"
PGUSER=${PGUSER:-fruitback}
PGDATABASE=${PGDATABASE:-fruitback}
HERE=$(cd "$(dirname "$0")" && pwd)
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sql() { docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -At -v ON_ERROR_STOP=1 "$@"; }

# A database on which no worker started yet has no table. That is an empty store already.
if [ "$(sql -c "SELECT to_regclass('seeds') IS NOT NULL")" != t ]; then
  echo "$(now) reset: nothing stored yet"
  exit 0
fi
sql -q -c 'TRUNCATE seeds, seed_comments, screenshots RESTART IDENTITY'
sql -q -v "origin=$ORIGIN" <"$HERE/seed.sql"
SEEDS=$(sql -c 'SELECT count(*) FROM seeds')
COMMENTS=$(sql -c 'SELECT count(*) FROM seed_comments')
PICTURES=$(sql -c 'SELECT count(*) FROM screenshots')
SITES=$(sql -c "SELECT count(*) FROM sites WHERE id = 'playground'")
echo "$(now) reset: seeds=$SEEDS comments=$COMMENTS screenshots=$PICTURES site=$SITES"
[ "$SEEDS" = 0 ] && [ "$COMMENTS" = 0 ] && [ "$PICTURES" = 0 ] && [ "$SITES" = 1 ]
