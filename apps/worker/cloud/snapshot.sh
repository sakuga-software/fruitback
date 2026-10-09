#!/bin/sh
# A consistent copy of each database of Fruitback Cloud (api.fruitback.com). FRU-128.
# The host archives every Docker volume at 03:00, and a file that SQLite holds open is not a
# copy to trust. This writes a copy with SQLite's own backup into the same volume, before 03:00.
# WARNING: FRUITBACK_SECRETS_KEY is not in any backup. Without it the connector keys do not open.
set -eu
SERVICE=fruitback-cloud-worker-a9zdeo
DIR=/data/snapshots
C=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE" | head -1)
[ -n "$C" ] || { echo "$(date -Is) snapshot: no container for $SERVICE"; exit 1; }
docker exec "$C" mkdir -p "$DIR"
for NAME in fb.db sessions.db accounts.db; do
  # A worker that took no note yet has no notes file. That is not a failure.
  docker exec "$C" test -s "/data/$NAME" || { echo "$(date -Is) snapshot: no $NAME yet"; continue; }
  docker exec "$C" sqlite3 "/data/$NAME" ".backup '$DIR/$NAME.tmp'"
  CHECK=$(docker exec "$C" sqlite3 "$DIR/$NAME.tmp" "PRAGMA integrity_check")
  [ "$CHECK" = ok ] || { echo "$(date -Is) snapshot: $NAME does not pass the integrity check: $CHECK"; exit 1; }
  # Replaced only after the check: a copy that failed must not take the place of a good one.
  docker exec "$C" mv "$DIR/$NAME.tmp" "$DIR/$NAME"
  echo "$(date -Is) snapshot: $NAME $(docker exec "$C" stat -c %s "$DIR/$NAME") bytes"
done
