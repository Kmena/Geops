#!/usr/bin/env bash
# CI-only, non-destructive rehearsal of the detached checkout and Linux secret permissions.
set -Eeuo pipefail
umask 077
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && $(uname -s) == Linux ]] || {
  echo 'Isolated GitHub Actions runner required' >&2
  exit 1
}

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$root"
[[ -z $(git symbolic-ref --quiet --short HEAD || true) ]] || { echo 'Detached HEAD required' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Checkout must start clean' >&2; exit 1; }
operator=$(id -un)
[[ $(id -u) != 1000 && $(id -u) != 999 ]] || { echo 'Test operator UID must differ from container UIDs' >&2; exit 1; }
[[ ! -e $root/infrastructure/compose/.local ]] || { echo 'Private test directory already exists' >&2; exit 1; }
docker image inspect postgis/postgis:18-3.6 >/dev/null
group=geops-stage-secrets
gid=24001
network=geops_spec02_stage_edge
volumes=(geops_spec02_stage_pgdata geops_spec02_stage_security)
for volume in "${volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Test volume name already exists' >&2; exit 1; fi
done
if docker network inspect "$network" >/dev/null 2>&1; then echo 'Test network name already exists' >&2; exit 1; fi
if getent group "$group" >/dev/null; then echo 'Test group name already exists' >&2; exit 1; fi

env_file=$(mktemp "$RUNNER_TEMP/geops-staging-check.XXXXXXXX")
secret_dir="$root/infrastructure/compose/.local/staging/secrets"
dirty_file="$root/scripts/staging/.dirty-preflight-probe"
created_network=no
created_volumes=()
cleanup() {
  rm -f -- "$dirty_file" "$env_file"
  for name in db_password admin_session_key admin_csrf_key invitation_hmac_key mdm_grant_key gps_quarantine_key; do
    rm -f -- "$secret_dir/$name"
  done
  rmdir -- "$secret_dir" "$root/infrastructure/compose/.local/staging" "$root/infrastructure/compose/.local" 2>/dev/null || true
  for volume in "${created_volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  if [[ $created_network == yes ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

sudo groupadd --gid "$gid" "$group"
sudo usermod -aG "$group" "$operator"
mkdir -m 700 -p "$secret_dir"
for name in db_password admin_session_key admin_csrf_key invitation_hmac_key mdm_grant_key gps_quarantine_key; do
  printf 'synthetic-ci-only-%s\n' "$name" > "$secret_dir/$name"
  chmod 600 "$secret_dir/$name"
done
sha=$(git rev-parse HEAD)
printf 'GEOPS_STAGE_IMAGE_TAG=%s\nGEOPS_STAGE_ORIGIN=https://geops-staging.duckdns.org\nGEOPS_STAGE_SECRET_GID=%s\n' \
  "$sha" "$gid" > "$env_file"
as_operator=(sudo -u "$operator" -g "$group" --)

if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0015.sh check \
  0000000000000000000000000000000000000000 "$env_file" > /dev/null 2>&1; then
  echo 'Wrong SHA was accepted' >&2; exit 1
fi
printf 'untracked-test-file\n' > "$dirty_file"
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0015.sh check "$sha" "$env_file" > /dev/null 2>&1; then
  echo 'Dirty checkout was accepted' >&2; exit 1
fi
rm -f -- "$dirty_file"

docker network create "$network" > /dev/null
created_network=yes
for name in stage_pgdata stage_security; do
  volume="geops_spec02_${name}"
  docker volume create --name "$volume" \
    --label com.docker.compose.project=geops-spec02-staging \
    --label "com.docker.compose.volume=$name" > /dev/null
  created_volumes+=("$volume")
done
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0015.sh check "$sha" "$env_file"

"${as_operator[@]}" chgrp "$gid" "$secret_dir/db_password"
chmod 640 "$secret_dir/db_password"
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0015.sh check "$sha" "$env_file" > /dev/null
for uid in 1000 999; do
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user "$uid:$uid" --group-add "$gid" \
    --mount "type=bind,src=$secret_dir/db_password,dst=/run/secrets/probe,readonly" \
    --entrypoint /bin/sh postgis/postgis:18-3.6 -ec 'cat /run/secrets/probe >/dev/null'
done
if docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 2000:2000 \
  --mount "type=bind,src=$secret_dir/db_password,dst=/run/secrets/probe,readonly" \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -ec 'cat /run/secrets/probe >/dev/null' \
  >/dev/null 2>&1; then
  echo 'Secret readable without dedicated group' >&2; exit 1
fi
echo 'Detached HEAD, exact SHA, clean tree and private secret access: PASS'
