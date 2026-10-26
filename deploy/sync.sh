#!/usr/bin/env bash
# Push the working tree to the server for the dev container (hot reload picks it up), and remove
# files under src/, docker/, scripts/, public/ and deploy/ that no longer exist here, so a deleted or renamed
# file can't linger on the server and break the production build made from ~/gluon.
set -euo pipefail
cd "$(dirname "$0")/.."
# Your server's details live in deploy/.env (not tracked; copy deploy/.env.example).
[ -f deploy/.env ] && . deploy/.env
: "${GLUON_HOST:?Set GLUON_HOST (user@server) in deploy/.env}"
HOST=$GLUON_HOST
# Top-level entries only: a pattern like `--exclude data` would also drop src/app/api/widgets/data.
entries=()
for e in * .[!.]*; do
  case "$e" in node_modules|.next|.git|.impeccable|data|.dev-credentials|'.[!.]*') ;; *) [ -e "$e" ] && entries+=("$e") ;; esac
done
COPYFILE_DISABLE=1 tar czf - "${entries[@]}" 2>/dev/null \
  | ssh -o BatchMode=yes "$HOST" 'mkdir -p ~/gluon && tar xzf - -C ~/gluon 2>/dev/null'
{ find src docker scripts public deploy -type f 2>/dev/null || true; } | LC_ALL=C sort \
  | ssh -o BatchMode=yes "$HOST" 'cd ~/gluon && keep=$(mktemp) && cat > "$keep" && find src docker scripts public deploy -type f 2>/dev/null | LC_ALL=C sort | LC_ALL=C comm -13 "$keep" - | while IFS= read -r f; do rm -f -- "$f"; echo "removed stale $f" >&2; done; rm -f "$keep"; find src -type d -empty -delete 2>/dev/null || true'
