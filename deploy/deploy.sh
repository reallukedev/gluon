#!/usr/bin/env bash
# Ship main to a standalone Compose install of Gluon on your server (GLUON_DEPLOY_DIR). Runs Gluon's
# own updater there, the same one Settings → Updates uses: it downloads this commit from GitHub,
# builds it as gluon:<version>, retags it gluon:local, recreates the container and waits until the
# new one is healthy.
#
# Only main's HEAD is deployed. An install on the nightly channel follows the nightly channel, which installs main's
# newest commit at 4 AM and treats anything else as an update, so another commit wouldn't last.
# Usage: deploy/deploy.sh   (push main first)
set -euo pipefail
cd "$(dirname "$0")/.."
# Your server's details live in deploy/.env (not tracked; copy deploy/.env.example).
[ -f deploy/.env ] && . deploy/.env
: "${GLUON_HOST:?Set GLUON_HOST (user@server) in deploy/.env}"
HOST=$GLUON_HOST
REPO=${GLUON_REPO:-reallukedev/gluon}
: "${GLUON_DEPLOY_DIR:?Set GLUON_DEPLOY_DIR (the install folder on the server, absolute) in deploy/.env}"
DIR=$GLUON_DEPLOY_DIR

git fetch -q origin main
sha="$(git rev-parse origin/main)"
if [ "$(git rev-parse HEAD)" != "$sha" ]; then
  echo "HEAD isn't origin/main ($(git rev-parse --short HEAD) vs ${sha:0:7}). Merge and push to main, then deploy." >&2
  exit 1
fi

# The same name the nightly updater gives a build: <package version>-nightly.<commit day, UTC>.<sha>.
base="$(git show "$sha:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
[[ $base =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || base=0.0.0
day="$(TZ=UTC git show -s --date=format-local:%Y%m%d --format=%cd "$sha")"
version="$base-nightly.$day.${sha:0:7}"

running="$(ssh -o BatchMode=yes "$HOST" "docker inspect gluon --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^GLUON_COMMIT=//p'")"
if [ "$running" = "${sha:0:12}" ]; then
  echo "The server already runs $version."
  exit 0
fi

log="$DIR/update-$(date +%Y%m%d-%H%M%S).log"
scp -q -o BatchMode=yes docker/gluon-update.sh "$HOST:$DIR/.gluon-update.sh"
# Detached, so the update finishes even if this connection drops while the container is swapped.
ssh -o BatchMode=yes "$HOST" "chmod 700 $DIR/.gluon-update.sh && setsid nohup bash $DIR/.gluon-update.sh github $REPO $sha $version ${sha:0:12} \
  compose $DIR gluon gluon gluon:local gluon $DIR/compose.yaml > $log 2>&1 < /dev/null &"
echo "Deploying Gluon $version (log on the server: $log)…"

for _ in $(seq 1 90); do
  sleep 10
  done_line="$(ssh -o BatchMode=yes "$HOST" "grep -m1 '^::done' $log" || true)"
  stage="$(ssh -o BatchMode=yes "$HOST" "grep '^::stage' $log | tail -1" || true)"
  [ -n "$stage" ] && [ "$stage" != "${last:-}" ] && { echo "  ${stage#::stage }"; last=$stage; }
  case "$done_line" in
    "::done ok"*) ssh -o BatchMode=yes "$HOST" "rm -f $DIR/.gluon-update.sh"; echo "${done_line#::done ok }"; echo "Gluon $version is running: http://${HOST#*@}:8130"; exit 0 ;;
    "::done failed"*) echo "${done_line#::done failed }" >&2; echo "See $log on the server." >&2; exit 1 ;;
  esac
done
echo "The update is still going after 15 minutes. Follow $log on the server." >&2
exit 1
