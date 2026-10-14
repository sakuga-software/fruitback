#!/bin/sh
# What the container of the console does before nginx starts (FRU-222).
#
# One image serves every instance, so the address of the worker is read here, when the container
# starts, and never compiled in. This script writes the two files that hold it:
#   - /tmp/fruitback/config.js, which the page loads before its bundle (app/instance.ts);
#   - /tmp/fruitback/console.conf, the server of nginx, whose Content-Security-Policy lets the page
#     call that worker and no other origin.
#
# WARNING: FRUITBACK_API goes into a header and into a script. It is therefore held to the letters
# of an address before anything is written: a quote, a space or a semicolon would add a source to
# the policy, or a statement to the script. Do not relax the pattern below without reading both files.
set -eu

fail() {
  echo "fruitback-console: $1" >&2
  exit 1
}

API="${FRUITBACK_API:-}"
PORT="${FRUITBACK_CONSOLE_LISTEN:-80}"

[ -n "$API" ] || fail "FRUITBACK_API is not set. Give the address your browser reaches the worker at, for example FRUITBACK_API=https://api.example.com (with docker-compose.yml: FRUITBACK_PUBLIC_URL in .env). The console cannot call a worker it does not know."

# The scheme, a host, a port if any, a path if any. Nothing else: no user, no query, no fragment.
printf '%s' "$API" | grep -Eq '^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' ||
  fail "FRUITBACK_API is not an address the console can use. Write it as https://host, https://host:port or https://host/path, with nothing after it."
[ "$(printf '%s' "$API" | wc -l)" -eq 0 ] || fail "FRUITBACK_API holds more than one line."
printf '%s' "$PORT" | grep -Eq '^[0-9]{1,5}$' || fail "FRUITBACK_CONSOLE_LISTEN is not a port."

# No slash at the end, as the bundle writes its paths after it.
while [ "${API%/}" != "$API" ]; do API="${API%/}"; done
# The policy names an origin. A source with a path allows that path alone, and the worker has many.
ORIGIN=$(printf '%s' "$API" | sed -E 's|^(https?://[^/]+).*$|\1|')

mkdir -p /tmp/fruitback
printf 'globalThis.__FRUITBACK__ = { api: "%s" };\n' "$API" >/tmp/fruitback/config.js
sed -e "s|__WORKER_ORIGIN__|$ORIGIN|g" -e "s|__LISTEN__|$PORT|g" /etc/fruitback/console.conf.template >/tmp/fruitback/console.conf

echo "fruitback-console: serving on port $PORT, for the worker at $API"
exec "$@"
