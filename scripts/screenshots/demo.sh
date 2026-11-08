#!/bin/sh
# Usage: sudo demo.sh up | down
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/apps"
for app in *; do
  if [ "$1" = down ]; then
    docker compose -f "$app/compose.yaml" down --rmi all
  else
    docker compose -f "$app/compose.yaml" up -d --build --quiet-pull
  fi
done
if [ "$1" != down ]; then node "$here/files.mjs" /DATA; fi
