#!/usr/bin/env bash
# Gluon's self-updater. Gluon copies this file to the host and runs it as a transient systemd unit
# (systemd-run), so it keeps going while the Gluon container it replaces stops and starts.
#
#   gluon-update.sh github  <repo> <ref> <version> <commit> <mode> [mode args…]
#   gluon-update.sh pull    <mode> [mode args…]
#
# github: download <repo>@<ref> from GitHub, build it as gluon:<version>, then put it in place.
# pull:   pull the newer image the compose file already names (CasaOS / registry installs).
#
# mode args:
#   umbrel  <appId> <appDataDir> <umbrelContainer|-> <container>
#           Tags the build as <appId>:<version>, points <appDataDir>/Dockerfile at it and asks
#           umbreld to restart the app (which rebuilds from that Dockerfile).
#   compose <workdir> <project> <service> <image> <container> <configFile>[,<configFile>…]
#           Tags the build as the service's own image and recreates the service.
#
# Progress goes to stdout as lines the app reads: "::stage <name>", "::done ok <msg>",
# "::done failed <msg>". Everything else is plain log output.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
stage() { printf '::stage %s\n' "$1"; say "$2"; }
fail() { printf '::done failed %s\n' "$1"; exit 1; }
trap 'fail "The update stopped unexpectedly (line $LINENO)."' ERR

action=$1; shift
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------- build from GitHub
if [ "$action" = github ]; then
  repo=$1 ref=$2 version=$3 commit=$4; shift 4
  [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "That isn't a GitHub repository name."
  [[ $ref =~ ^[A-Za-z0-9_./-]{1,100}$ ]] || fail "That isn't a version Gluon can download."
  [[ $version =~ ^[A-Za-z0-9_.+-]{1,64}$ ]] || fail "That isn't a version name Gluon can use."
  WORK=$(mktemp -d /var/tmp/gluon-update.XXXXXX)

  stage download "Downloading $repo at $ref…"
  curl -fsSL --retry 3 --max-time 600 "https://codeload.github.com/$repo/tar.gz/$ref" | tar -xz --strip-components=1 -C "$WORK"
  [ -f "$WORK/docker/Dockerfile" ] || fail "That version of Gluon has no docker/Dockerfile to build."

  stage build "Building Gluon $version (this takes a few minutes)…"
  docker build --progress=plain -t "gluon:$version" \
    --build-arg GLUON_VERSION="$version" --build-arg GLUON_COMMIT="$commit" --build-arg GLUON_BUILD="github" \
    -f "$WORK/docker/Dockerfile" "$WORK" 2>&1
  NEW="gluon:$version"
elif [ "$action" = pull ]; then
  NEW=""
else
  fail "Unknown update action: $action"
fi

mode=$1; shift
wait_healthy() { # <container> <image id> → 0 when it runs that image and is healthy (or has no healthcheck)
  local c=$1 want=$2
  for _ in $(seq 1 90); do
    sleep 4
    local img state health
    img=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true)
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || true)
    if [ -n "$want" ] && [ "$img" != "$want" ]; then continue; fi
    if [ "$state" = running ] && { [ "$health" = healthy ] || [ "$health" = none ]; }; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- put it in place: Umbrel
if [ "$mode" = umbrel ]; then
  app=$1 appdata=$2 umbrel=$3 container=$4
  [[ $app =~ ^[a-z0-9-]+$ ]] || fail "That isn't an Umbrel app id."
  [ -f "$appdata/Dockerfile" ] || fail "Umbrel's copy of Gluon has no Dockerfile at $appdata."
  umbreld() {
    if [ "$umbrel" != "-" ]; then
      docker exec -w /opt/umbreld -e UMBREL_DATA_DIR=/srv/umbrel -e UMBREL_TRPC_ENDPOINT=http://localhost/trpc "$umbrel" ./umbreld client "$@"
    else
      umbreld client "$@"
    fi
  }
  [ -n "$NEW" ] || fail "Umbrel updates come from its app store; use \"Update through Umbrel\"."
  prev=$(head -n1 "$appdata/Dockerfile")
  tag="$app:${NEW#gluon:}"
  stage apply "Handing Gluon $tag to Umbrel…"
  docker tag "$NEW" "$tag"
  newid=$(docker image inspect -f '{{.Id}}' "$tag")
  printf 'FROM %s\n' "$tag" > "$appdata/Dockerfile"
  umbreld apps.restart.mutate --appId "$app" >/dev/null
  stage verify "Waiting for Gluon to come back…"
  # Umbrel rebuilds a thin image on top of the new one, so check the result by health, not image id.
  sleep 10
  if wait_healthy "$container" ""; then
    printf '::done ok %s\n' "Gluon ${NEW#gluon:} is running."
    exit 0
  fi
  say "Gluon didn't come back healthy; going back to ${prev#FROM }."
  printf '%s\n' "$prev" > "$appdata/Dockerfile"
  umbreld apps.restart.mutate --appId "$app" >/dev/null || true
  fail "The new version didn't start, so Gluon went back to the previous one."
fi

# ---------------------------------------------------------------- put it in place: Compose (incl. CasaOS)
if [ "$mode" = compose ]; then
  workdir=$1 project=$2 service=$3 image=$4 container=$5 configs=$6
  args=(-p "$project")
  IFS=',' read -r -a files <<< "$configs"
  for f in "${files[@]}"; do [ -n "$f" ] && args+=(-f "$f"); done
  cd "$workdir"
  previd=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
  if [ -n "$NEW" ]; then
    stage apply "Replacing $container with Gluon ${NEW#gluon:}…"
    docker tag "$NEW" "$image"
  else
    stage download "Pulling the newest $image…"
    docker compose "${args[@]}" pull "$service" 2>&1
    stage apply "Replacing $container…"
  fi
  newid=$(docker image inspect -f '{{.Id}}' "$image")
  if [ "$newid" = "$previd" ]; then
    printf '::done ok %s\n' "Gluon is already on the newest image."
    exit 0
  fi
  docker compose "${args[@]}" up -d --no-build --no-deps "$service" 2>&1
  stage verify "Waiting for Gluon to come back…"
  if wait_healthy "$container" "$newid"; then
    printf '::done ok %s\n' "Gluon is running the new version."
    exit 0
  fi
  if [ -n "$previd" ]; then
    say "Gluon didn't come back healthy; putting the previous image back."
    docker tag "$previd" "$image"
    docker compose "${args[@]}" up -d --no-build --no-deps "$service" 2>&1 || true
  fi
  fail "The new version didn't start, so Gluon went back to the previous one."
fi

fail "Gluon doesn't know how to replace itself in \"$mode\" mode."
