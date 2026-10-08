#!/bin/sh
# Empties the public Fruitback demonstration (api.demo.fruitback.com). FRU-79.
# The worker keeps its connection, so the rows are deleted in the running container.
# Removing the file does nothing. The pragma makes the replies go with their notes.
set -eu
SERVICE=app-navigate-virtual-monitor-apawmf
DB=/data/fb.db
C=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE" | head -1)
[ -n "$C" ] || { echo "$(date -Is) no container for $SERVICE"; exit 1; }
# A container that took no note yet has no table. That is an empty store already.
TABLES=$(docker exec "$C" sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE name = 'seeds'" 2>/dev/null || echo 0)
if [ "$TABLES" = 0 ]; then echo "$(date -Is) reset: nothing stored yet"; exit 0; fi
docker exec "$C" sqlite3 "$DB" "PRAGMA foreign_keys = ON; DELETE FROM seeds; DELETE FROM sqlite_sequence WHERE name IN ('seeds', 'comments');"
SEEDS=$(docker exec "$C" sqlite3 "$DB" "SELECT count(*) FROM seeds")
COMMENTS=$(docker exec "$C" sqlite3 "$DB" "SELECT count(*) FROM comments")
echo "$(date -Is) reset: seeds=$SEEDS comments=$COMMENTS"
[ "$SEEDS" = 0 ] && [ "$COMMENTS" = 0 ]
