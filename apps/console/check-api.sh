#!/bin/sh
# Stops the container when the Content-Security-Policy would block the worker the bundle calls.
# The bundle holds the address given at build time, and the policy gets the address of this run.
set -e
BUILT=$(cat /etc/fruitback-api)
if [ "$FRUITBACK_API" != "$BUILT" ]; then
  echo "FRUITBACK_API is '$FRUITBACK_API', but this image was built for '$BUILT'." >&2
  echo "The browser would block every call to the worker. Unset FRUITBACK_API, or rebuild the image." >&2
  exit 1
fi
