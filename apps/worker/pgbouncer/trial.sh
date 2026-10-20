#!/usr/bin/env bash
# A worker behind PgBouncer, tried on this machine (FRU-267). It starts compose.yml, plays a short path
# through the pooler, prints what it saw, and removes everything it started, volumes included.
#
#   apps/worker/pgbouncer/trial.sh <session|transaction> [schema]
#
# FRUITBACK_IMAGE names the image of the worker (default: ghcr.io/sakuga-software/fruitback-worker:edge;
# `docker build -f apps/worker/Dockerfile -t fruitback-worker:local .` then FRUITBACK_IMAGE=fruitback-worker:local).
# TRIAL_PORT is the port of the worker on 127.0.0.1 (default 8094). Every password and secret is made
# at each run and thrown away with it.
#
# It prints facts and decides nothing: docs/self-hosting.md, « Behind a connection pooler », reads them.
set -uo pipefail

MODE=${1:-}
case $MODE in session | transaction) ;; *) echo "usage: $0 <session|transaction> [schema]" >&2; exit 2 ;; esac
SCHEMA=${2:-}
case $SCHEMA in *[!a-z0-9_]*) echo "trial: the schema is a plain name" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
export TRIAL_DIR TRIAL_SCHEMA=$SCHEMA TRIAL_PORT=${TRIAL_PORT:-8094}
TRIAL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fruitback-pgbouncer.XXXXXX")
export TRIAL_PROJECT=fruitback-pgbouncer-$MODE${SCHEMA:+-$SCHEMA}
export TRIAL_PASSWORD=$(openssl rand -hex 24) TRIAL_AUTH_SECRET=$(openssl rand -hex 32) TRIAL_IDENTITY_SECRET=$(openssl rand -hex 32)
TABLES=${SCHEMA:-public}

cat >"$TRIAL_DIR/pgbouncer.ini" <<INI
[databases]
fruitback = host=postgres port=5432 dbname=fruitback
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = $MODE
max_client_conn = 200
default_pool_size = 40
INI
printf '"fruitback" "%s"\n' "$TRIAL_PASSWORD" >"$TRIAL_DIR/userlist.txt"
chmod 0644 "$TRIAL_DIR"/*

DC() { docker compose -f "$HERE/compose.yml" "$@"; }
SQL() { DC exec -T postgres psql -U fruitback -d fruitback -At -c "$1"; }
BOUNCER() { DC exec -T -e PGPASSWORD="$TRIAL_PASSWORD" postgres psql -h pgbouncer -p 6432 -U fruitback -d fruitback -At "$@"; }
say() { echo "## $*"; }
finish() {
  DC --profile two down -v >/dev/null 2>&1
  rm -rf "$TRIAL_DIR"
}
trap finish EXIT
W=http://127.0.0.1:$TRIAL_PORT
CALL() { curl -s -o "$TRIAL_DIR/body" -w '%{http_code}' "$@"; }
FROM_CONSOLE=(-H 'Origin: http://localhost:8081' -H 'Content-Type: application/json')
FROM_SITE=(-H 'Origin: http://localhost:5500')
healthy() {
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$W/health")" = 200 ] && return 0
    sleep 1
  done
  return 1
}
# The lock of the migrations and the one of the role of administrator, read from the code of the
# worker: a trial that measured a lock the worker no longer takes would say nothing true.
SRC=$HERE/../src
MIGRATION_LOCK=$(sed -n 's/^const MIGRATION_LOCK = \(0x[0-9A-Fa-f_]*\);$/\1/p' "$SRC/postgres-migrate.ts" | tr -d _)
ADMIN_ROLE_LOCK=$(sed -n 's/^export const ADMIN_ROLE_LOCK = \([0-9]*\);$/\1/p' "$SRC/instance-admin-postgres.ts")
[ -n "$MIGRATION_LOCK" ] && [ -n "$ADMIN_ROLE_LOCK" ] || { echo "trial: the two locks are not where trial.sh reads them" >&2; exit 1; }
MIGRATION_LOCK=$((MIGRATION_LOCK))

say "pool_mode=$MODE schema=$TABLES"
DC up -d --wait postgres pgbouncer >/dev/null 2>&1 || { say "the database or the pooler did not start"; exit 1; }

# 1. One worker: its start, its migrations, the first administrator, a workspace, a site, a note, reads.
export TRIAL_FIRST_ADMIN=ana@example.com TRIAL_RATE=8
DC up -d worker >/dev/null 2>&1
healthy && say "worker: /health $(curl -s "$W/health")" || say "worker: /health never answered 200"
sleep 2
TOKEN=$(DC logs --no-color worker 2>&1 | grep -o 'http[^ ]*/sign-in#[^ ]*' | tail -n 1)
TOKEN=${TOKEN#*#}
say "redeem the link of the first administrator (a trigger takes the lock of the role): $(CALL -c "$TRIAL_DIR/cookies" "${FROM_CONSOLE[@]}" -d "{\"token\":\"$TOKEN\"}" "$W/console/auth/email/redeem")"
say "make a workspace: $(CALL -b "$TRIAL_DIR/cookies" "${FROM_CONSOLE[@]}" -d '{"name":"Acme"}' "$W/console/workspaces")"
WS=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$TRIAL_DIR/body")
say "add a site: $(CALL -b "$TRIAL_DIR/cookies" "${FROM_CONSOLE[@]}" -d '{"url":"http://localhost:5500","visibility":"everyone"}' "$W/console/workspaces/$WS/sites")"
SITE=$(sed -n 's/.*"id":"\(site_[^"]*\)".*/\1/p' "$TRIAL_DIR/body")
NOTE="{\"kind\":\"fruitback.seed\",\"v\":2,\"id\":\"sd_pgbouncer\",\"createdAt\":\"2026-10-21T00:00:00.000Z\",\"note\":\"Through PgBouncer\",\"page\":{\"url\":\"http://localhost:5500/\",\"path\":\"/\"},\"viewport\":{\"width\":1280,\"height\":800},\"anchor\":{\"selector\":\"main > h1\",\"tag\":\"h1\",\"bounds\":{\"xPct\":0,\"yPct\":0,\"wPct\":100,\"hPct\":8}},\"client\":{\"id\":\"$SITE\"}}"
say "send a note: $(CALL -X POST "${FROM_SITE[@]}" -H 'Content-Type: application/json' -d "$NOTE" "$W/feedback") $(head -c 60 "$TRIAL_DIR/body")"
READ="$W/feedback?url=http%3A%2F%2Flocalhost%3A5500%2F&client=$SITE"
reads=""
for _ in 1 2 3 4 5; do reads="$reads $(CALL "${FROM_SITE[@]}" "$READ")"; done
say "five reads, RATE_LIMIT_PER_MINUTE=8 (the counter is a row of the database):$reads"
say "the database: $(SQL "SELECT count(*) FROM pg_tables WHERE schemaname='$TABLES'") tables in $TABLES, $(SQL "SELECT count(*) FROM pg_tables WHERE schemaname='public'") in public, $(SQL "SELECT count(*) FROM \"$TABLES\".__drizzle_migrations") migrations applied, $(SQL "SELECT count(*) FROM \"$TABLES\".seeds") note"
DC restart worker >/dev/null 2>&1
healthy && say "after a restart: /health 200, a read $(CALL "${FROM_SITE[@]}" "$READ") (429: the counter was kept)" || say "after a restart: /health never answered 200"
say "lines of the log that name a failure:"
DC logs --no-color worker 2>&1 | grep -iE 'error|fail|refus|pooler|search path|did not' | sed 's/sign-in#[^ ]*/sign-in#…/' | cut -c1-240 | sort | uniq -c
DC rm -sf worker >/dev/null 2>&1
rm -f "$TRIAL_DIR/cookies"

# 2. What a pooler keeps of a session, asked with psql through it. A second client takes a
#    transaction between two statements of the first, as another request of the worker would.
say "LISTEN, another client in between, then NOTIFY:"
(BOUNCER -c 'LISTEN fruitback' -c '\! sleep 2' -c 'SELECT pg_sleep(3)' -c 'SELECT 1' 2>&1 | grep -c 'Asynchronous notification' | sed 's/^/##    notifications received: /') &
sleep 1
(BOUNCER -c 'BEGIN' -c 'SELECT pg_sleep(6)' -c 'COMMIT' >/dev/null 2>&1) &
sleep 2.5
BOUNCER -c "NOTIFY fruitback, 'hello'" >/dev/null 2>&1
wait
say "pg_advisory_lock, another client in between, then pg_advisory_unlock (what migrate() does):"
(BOUNCER -c 'SELECT pg_advisory_lock(424242)' -c '\! sleep 2' -c 'SELECT pg_advisory_unlock(424242)' 2>&1 | tail -n 2 | tr '\n' ' ' | sed 's/^/##    unlock answered: /'; echo) &
sleep 1
(BOUNCER -c 'BEGIN' -c 'SELECT pg_sleep(3)' -c 'COMMIT' >/dev/null 2>&1) &
wait
sleep 1
say "   that lock still held by the server once its client left: $(SQL "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=424242")"
say "SET search_path, then the next client sees: $(BOUNCER -c 'SET search_path TO elsewhere' >/dev/null 2>&1; BOUNCER -c 'SHOW search_path' 2>&1)"
(BOUNCER -c 'BEGIN' -c "SELECT pg_advisory_xact_lock($ADMIN_ROLE_LOCK)" -c 'SELECT pg_sleep(3)' -c 'COMMIT' >/dev/null 2>&1) &
sleep 0.5
started=$(date +%s)
BOUNCER -c "SELECT pg_advisory_xact_lock($ADMIN_ROLE_LOCK)" >/dev/null 2>&1
say "pg_advisory_xact_lock held 3 s in a transaction (the lock of the role): the second client waited $(($(date +%s) - started)) s"
wait
say "set_config('synchronous_commit', 'off', true), then the next statement: $(BOUNCER -c "SELECT set_config('synchronous_commit', 'off', true)" -c 'SHOW synchronous_commit' 2>&1 | tr '\n' ' ')"
SQL "SELECT pg_advisory_unlock_all()" >/dev/null 2>&1
DC restart pgbouncer >/dev/null 2>&1

# 3. Two workers that start together on an empty database: the lock of the migrations.
SQL "DROP SCHEMA IF EXISTS \"$TABLES\" CASCADE; CREATE SCHEMA IF NOT EXISTS public" >/dev/null 2>&1
export TRIAL_FIRST_ADMIN= TRIAL_RATE=1000
DC --profile two up -d --wait pgbouncer >/dev/null 2>&1
DC --profile two up -d worker worker2 >/dev/null 2>&1
sleep 20
read_in() { DC exec -T "$1" node -e 'fetch("http://127.0.0.1:8080/feedback?url=http%3A%2F%2Flocalhost%3A5500%2F&client=site_nobody", { headers: { Origin: "http://localhost:5500" }, signal: AbortSignal.timeout(10000) }).then(async (r) => console.log(r.status, (await r.text()).slice(0, 60)), (e) => console.log("no answer in 10 s:", e.name))' 2>&1; }
say "two workers started together:"
for s in worker worker2; do
  say "   $s: a read answers $(read_in "$s")"
  DC logs --no-color "$s" 2>&1 | grep -iE 'better-auth|error|fail|refus|pooler' | cut -c1-200 | sed 's/^/##      /'
done
say "   migrations applied: $(SQL "SELECT count(*) FROM \"$TABLES\".__drizzle_migrations" 2>&1); the lock of the migrations held: $(SQL "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=$MIGRATION_LOCK"); sessions that wait on an advisory lock: $(SQL "SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'")"
