#!/bin/sh
# The only thing the CI deploy key can run (authorized_keys: command="…/deploy.sh",restrict).
# CI streams the image it built and scanned:   docker save credoc:<sha> | gzip | ssh deploy@host deploy <sha>
# Checks the archive names only credoc:<sha>, loads it, switches the container, waits for the healthcheck, rolls back
# to the previous image if the switch or the healthcheck fails.
set -eu
cd "$(dirname "$0")"

# shellcheck disable=SC2086  # word splitting of the requested command is intended; each word is validated below
set -- ${SSH_ORIGINAL_COMMAND:-}
if [ "${1:-}" != deploy ] || [ $# -ne 2 ]; then echo "usage: deploy <40-char git sha>" >&2; exit 2; fi
TAG=$2
printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{40}$' || { echo "refused: not a commit sha" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gunzip > "$TMP/image.tar"
# the archive may only name credoc:$TAG: docker load would retag any other image of this shared host (Caddy...)
refuse() { echo "refused: the archive must contain credoc:$TAG and nothing else" >&2; exit 3; }
tags=$(tar -xOf "$TMP/image.tar" manifest.json | grep -o '"RepoTags":\[[^]]*\]') || refuse
[ "$tags" = "\"RepoTags\":[\"credoc:$TAG\"]" ] || refuse
if tar -tf "$TMP/image.tar" index.json >/dev/null 2>&1; then # OCI layout (Docker 25+): its names are loaded too
  names=$(tar -xOf "$TMP/image.tar" index.json | grep -oE '"(io.containerd.image.name|org.opencontainers.image.ref.name)":"[^"]*"' | sort | tr '\n' ' ')
  [ -z "$names" ] || [ "$names" = "\"io.containerd.image.name\":\"docker.io/library/credoc:$TAG\" \"org.opencontainers.image.ref.name\":\"$TAG\" " ] || refuse
fi
docker load -q -i "$TMP/image.tar" >/dev/null
docker image inspect "credoc:$TAG" >/dev/null 2>&1 || { echo "refused: the stream did not contain credoc:$TAG" >&2; exit 3; }

PREV=$(cat .current 2>/dev/null || true)
up() { TAG=$1 docker compose up -d --no-build --remove-orphans >/dev/null; }
rollback() { if [ -n "$PREV" ]; then up "$PREV" && echo "rolled back to credoc:$PREV" >&2; fi; }

if ! up "$TAG"; then
  echo "docker compose up failed for credoc:$TAG" >&2
  rollback
  exit 4
fi
i=0
while [ $i -lt 30 ]; do
  s=$(docker inspect --format '{{.State.Health.Status}}' credoc-web 2>/dev/null || echo missing)
  [ "$s" = healthy ] && break
  i=$((i + 1)); sleep 2
done
if [ "$s" != healthy ]; then
  echo "credoc:$TAG is $s after 60 s" >&2
  rollback
  exit 4
fi

echo "$TAG" > .current
[ -n "$PREV" ] && [ "$PREV" != "$TAG" ] && echo "$PREV" > .previous
# keep the running image and the previous one (rollback target), drop the rest
for img in $(docker image ls credoc --format '{{.Tag}}'); do
  [ "$img" = "$TAG" ] || [ "$img" = "$PREV" ] || docker image rm "credoc:$img" >/dev/null 2>&1 || true
done
echo "deployed credoc:$TAG"
