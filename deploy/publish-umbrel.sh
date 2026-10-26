#!/usr/bin/env bash
# Build Gluon on the server as <store>-gluon:<version> and publish it to your Umbrel community app
# store (UMBREL_STORE in deploy/.env).
# Usage: deploy/publish-umbrel.sh ["release notes"]
# Umbrel re-reads app stores every 5 minutes; after that the update (or first install) appears.
set -euo pipefail
cd "$(dirname "$0")/.."
# Your server's details live in deploy/.env (not tracked; copy deploy/.env.example).
[ -f deploy/.env ] && . deploy/.env
: "${GLUON_HOST:?Set GLUON_HOST (user@server) in deploy/.env}"
HOST=$GLUON_HOST
: "${UMBREL_STORE:?Set UMBREL_STORE (your app store id) in deploy/.env}"
CADDY_DIR=${UMBREL_CADDY_DIR:-/srv/caddy}
APP_TZ=${TZ:-UTC}
NOTES="${1:-Latest Gluon build.}"
VERSION="$(date +%Y.%m.%d-%H%M)"
APP_VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo local)$(git diff --quiet HEAD 2>/dev/null || echo -dirty)"

"$(dirname "$0")/sync.sh"

ssh -o BatchMode=yes "$HOST" "STORE_ID=$(printf %q "$UMBREL_STORE") CADDY_DIR=$(printf %q "$CADDY_DIR") APP_TZ=$(printf %q "$APP_TZ") VERSION=$(printf %q "$VERSION") APP_VERSION=$(printf %q "$APP_VERSION") COMMIT=$(printf %q "$COMMIT") NOTES=$(printf %q "$NOTES") bash -s" <<'REMOTE'
set -euo pipefail
STORE=/DATA/AppData/umbrel/appstore/store
APP=$STORE/$STORE_ID-gluon
echo "Building $STORE_ID-gluon:${VERSION}…"
docker build -q -t "$STORE_ID-gluon:$VERSION" --label coolify.managed=true --build-arg GLUON_VERSION="$APP_VERSION" --build-arg GLUON_COMMIT="$COMMIT" --build-arg GLUON_BUILD="$VERSION" -f ~/gluon/docker/Dockerfile ~/gluon >/dev/null
mkdir -p "$APP"
rm -rf "$APP/gluon"  # older releases shipped the source; the image replaces it
sed -e "s|__CADDY_DIR__|$CADDY_DIR|" -e "s|__TZ__|$APP_TZ|" ~/gluon/deploy/umbrel/docker-compose.yml > "$APP/docker-compose.yml"
sed -e "s|__VERSION__|$VERSION|" -e "s|__STORE__|$STORE_ID|g" ~/gluon/deploy/umbrel/Dockerfile.template > "$APP/Dockerfile.template"
cp ~/gluon/deploy/umbrel/dockerignore "$APP/.dockerignore"
sed -e "s|__VERSION__|$VERSION|" -e "s|__STORE__|$STORE_ID|g" -e "s|__NOTES__|${NOTES//|/\\|}|" ~/gluon/deploy/umbrel/umbrel-app.yml.tmpl > "$APP/umbrel-app.yml"
/DATA/AppData/umbrel/appstore/publish.sh "Gluon $VERSION"
# Keep the two newest images (the new release and the one it replaces, for a rollback).
docker images "$STORE_ID-gluon" --format '{{.Tag}}' | sort -r | tail -n +3 | xargs -r -I{} docker rmi -f "$STORE_ID-gluon:{}" >/dev/null 2>&1 || true
REMOTE
echo "Published Gluon $VERSION to the $UMBREL_STORE store. Umbrel picks it up within 5 minutes."
