#!/usr/bin/env bash
# CI-only destructive rehearsal, limited to newly created disposable runner resources.
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
networks=(geops_spec02_stage_edge geops_spec02_stage_db geops_spec02_stage_app)
volumes=(geops_spec02_stage_pgdata geops_spec02_stage_security geops_spec02_stage_backups)
for volume in "${volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Test volume name already exists' >&2; exit 1; fi
done
for network in "${networks[@]}"; do
  if docker network inspect "$network" >/dev/null 2>&1; then echo 'Test network name already exists' >&2; exit 1; fi
done
if getent group "$group" >/dev/null; then echo 'Test group name already exists' >&2; exit 1; fi
if [[ -n $(docker ps -a --filter label=com.docker.compose.project=geops-spec02-staging --format '{{.ID}}') ]]; then
  echo 'Test project containers already exist' >&2; exit 1
fi

env_file=$(mktemp "$RUNNER_TEMP/geops-staging-check.XXXXXXXX")
secret_dir="$root/infrastructure/compose/.local/staging/secrets"
dirty_file="$root/scripts/staging/.dirty-preflight-probe"
created_networks=()
created_volumes=()
seed_container=
foreign_container=
old_api_container=
old_api_image=
cleanup() {
  if [[ -n $seed_container ]]; then docker rm -f "$seed_container" >/dev/null 2>&1 || true; fi
  if [[ -n $foreign_container ]]; then docker rm -f "$foreign_container" >/dev/null 2>&1 || true; fi
  if [[ -n $old_api_container ]]; then docker rm -f "$old_api_container" >/dev/null 2>&1 || true; fi
  docker ps -a --filter label=com.docker.compose.project=geops-spec02-staging --format '{{.ID}}' |
    while IFS= read -r id; do [[ -z $id ]] || docker rm -f "$id" >/dev/null 2>&1 || true; done
  rm -f -- "$dirty_file" "$env_file" "$env_file.safe"
  for name in db_password admin_session_key admin_csrf_key invitation_hmac_key mdm_grant_key gps_quarantine_key; do
    rm -f -- "$secret_dir/$name"
  done
  rmdir -- "$secret_dir" "$root/infrastructure/compose/.local/staging" "$root/infrastructure/compose/.local" 2>/dev/null || true
  for volume in "${created_volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  for network in "${created_networks[@]}"; do docker network rm "$network" >/dev/null 2>&1 || true; done
  if [[ -n $old_api_image ]]; then docker image rm "$old_api_image" >/dev/null 2>&1 || true; fi
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
catalog_count=$(find "$root/apps/api/src/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)
case $catalog_count in
  21) catalog_profile=A21 ;;
  22) catalog_profile=B22-safe ;;
  23) catalog_profile=B23-safe ;;
  *) echo 'Unexpected migration catalog size' >&2; exit 1 ;;
esac
printf 'GEOPS_STAGE_IMAGE_TAG=%s\nGEOPS_STAGE_ORIGIN=https://geops-staging.duckdns.org\nGEOPS_STAGE_SECRET_GID=%s\n' \
  "$sha" "$gid" > "$env_file"
as_operator=(sudo -u "$operator" -g "$group" -- env "GEOPS_CATALOG_PROFILE=$catalog_profile")

if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check \
  0000000000000000000000000000000000000000 "$env_file" > /dev/null 2>&1; then
  echo 'Wrong SHA was accepted' >&2; exit 1
fi
printf 'untracked-test-file\n' > "$dirty_file"
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" > /dev/null 2>&1; then
  echo 'Dirty checkout was accepted' >&2; exit 1
fi
rm -f -- "$dirty_file"

docker network create geops_spec02_stage_edge > /dev/null
created_networks+=(geops_spec02_stage_edge)
for name in stage_db stage_app; do
  network="geops_spec02_${name}"
  docker network create --internal --label com.docker.compose.project=geops-spec02-staging \
    --label "com.docker.compose.network=$name" "$network" > /dev/null
  created_networks+=("$network")
done
for name in stage_pgdata stage_security stage_backups; do
  volume="geops_spec02_${name}"
  docker volume create --name "$volume" \
    --label com.docker.compose.project=geops-spec02-staging \
    --label "com.docker.compose.volume=$name" > /dev/null
  created_volumes+=("$volume")
done

# A missing backup and a foreign-owned data volume both fail before reset.
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'Missing backup was accepted' >&2; exit 1
fi
docker volume rm geops_spec02_stage_pgdata >/dev/null
created_volumes=(geops_spec02_stage_security geops_spec02_stage_backups)
docker volume create --name geops_spec02_stage_pgdata --label com.docker.compose.project=foreign \
  --label com.docker.compose.volume=stage_pgdata >/dev/null
created_volumes+=(geops_spec02_stage_pgdata)
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'Foreign-owned volume was accepted' >&2; exit 1
fi
docker volume rm geops_spec02_stage_pgdata >/dev/null
docker volume create --name geops_spec02_stage_pgdata --label com.docker.compose.project=geops-spec02-staging \
  --label com.docker.compose.volume=stage_pgdata >/dev/null

foreign_container=$(docker create --label com.docker.compose.project=foreign \
  --mount type=volume,src=geops_spec02_stage_pgdata,dst=/foreign,readonly \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -c true)
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'External volume consumer was accepted' >&2; exit 1
fi
docker rm "$foreign_container" >/dev/null
foreign_container=

seed_container=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust \
  --mount type=volume,src=geops_spec02_stage_backups,dst=/geops-backups \
  postgis/postgis:18-3.6)
ready=no
for _ in {1..30}; do
  if docker exec "$seed_container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[[ $ready == yes ]] || { echo 'Disposable backup seed did not start' >&2; exit 1; }
docker exec -u 0 "$seed_container" /bin/sh -ec \
  'pg_dump -h 127.0.0.1 -U postgres -d postgres -Fc -f /geops-backups/geops-stage-ci.dump && sha256sum /geops-backups/geops-stage-ci.dump > /geops-backups/geops-stage-ci.dump.sha256'
docker stop "$seed_container" >/dev/null
seed_container=

# The origin must remain the exact HTTPS Staging host.
cp "$env_file" "$env_file.safe"
sed -i 's#https://geops-staging.duckdns.org#http://geops-staging.duckdns.org#' "$env_file"
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'Insecure origin was accepted' >&2; exit 1
fi
mv "$env_file.safe" "$env_file"

# Inspect a stopped, disposable predecessor API before the actual reset.
old_api_image="geops-spec02-api:$sha"
if docker image inspect "$old_api_image" >/dev/null 2>&1; then
  echo 'Predecessor test image tag already exists' >&2; exit 1
fi
docker image tag postgis/postgis:18-3.6 "$old_api_image"
old_api_name=geops-spec02-staging-geops-api-1
old_api_labels=(--label com.docker.compose.project=geops-spec02-staging --label com.docker.compose.service=geops-api)
for case_name in absent false true credentials; do
  case "$case_name" in
    absent) old_api_env=() ;;
    false) old_api_env=(-e MDM_ENABLED=false) ;;
    true) old_api_env=(-e MDM_ENABLED=true) ;;
    credentials) old_api_env=(-e MDM_ENABLED=false -e GEOPS_MDM_CLIENT_SECRET=synthetic-ci-only) ;;
  esac
  old_api_container=$(docker create --name "$old_api_name" "${old_api_labels[@]}" \
    "${old_api_env[@]}" --entrypoint /bin/sh "$old_api_image" -c true)
  if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
    [[ $case_name == absent || $case_name == false ]] || { echo "Old API $case_name was accepted" >&2; exit 1; }
  else
    [[ $case_name == true || $case_name == credentials ]] || { echo "Old API $case_name was rejected" >&2; exit 1; }
  fi
  docker rm "$old_api_container" >/dev/null
  old_api_container=
done
old_api_container=$(docker create --name "$old_api_name" "${old_api_labels[@]}" \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -c true)
if "${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'Foreign predecessor API image was accepted' >&2; exit 1
fi
docker rm "$old_api_container" >/dev/null
old_api_container=
docker image rm "$old_api_image" >/dev/null
old_api_image=

if [[ $catalog_profile == B22-safe || $catalog_profile == B23-safe ]] &&
   sudo -u "$operator" -g "$group" -- bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null 2>&1; then
  echo 'B22 catalog accepted without explicit profile' >&2; exit 1
fi
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file"
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" >/dev/null

"${as_operator[@]}" chgrp "$gid" "$secret_dir/db_password"
chmod 640 "$secret_dir/db_password"
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$env_file" > /dev/null
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

# Real reset is confined to resources created above on this disposable CI runner.
"${as_operator[@]}" bash scripts/staging/clean-reinstall-0018.sh reset "$sha" "$env_file" DISCARD_ONLY_GEOPS_SPEC02_STAGING
docker volume inspect geops_spec02_stage_backups >/dev/null
docker run --rm --pull never --network none --mount type=volume,src=geops_spec02_stage_backups,dst=/geops-backups,readonly \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -ec 'test -s /geops-backups/geops-stage-ci.dump'
printf 'Fresh 0001–%04d install (%s), new gate and preserved backup: PASS\n' "$catalog_count" "$catalog_profile"

# Exercise the actual TTY-only commands with generated, synthetic credentials.
python3 -I - "$operator" "$group" "$env_file" "$root" <<'PY'
import os, pty, secrets, select, subprocess, sys, time, uuid
operator, group, env_file, root = sys.argv[1:]
base = ['sudo', '-u', operator, '-g', group, '--', 'docker', 'compose', '--env-file', env_file,
        '-f', root + '/infrastructure/compose/compose.staging.yaml', '--profile', 'maintenance',
        'run', '--rm', '--no-deps', '-i']
admin = 'ci-admin@geops.invalid'
first = 'ci-custodian-1@geops.invalid'
second = 'ci-custodian-2@geops.invalid'
passwords = [secrets.token_urlsafe(30) for _ in range(3)]

def ceremony(args, prompts):
    master, slave = pty.openpty()
    proc = subprocess.Popen(base + args, stdin=slave, stdout=slave, stderr=slave, cwd=root)
    os.close(slave)
    buffer = ''
    index = 0
    deadline = time.monotonic() + 180
    try:
        while proc.poll() is None or index < len(prompts):
            if time.monotonic() > deadline:
                proc.kill(); raise RuntimeError('Synthetic bootstrap timed out')
            ready, _, _ = select.select([master], [], [], 1)
            if not ready:
                continue
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            if not data:
                break
            buffer += data.decode(errors='replace')
            if index < len(prompts) and prompts[index][0] in buffer:
                os.write(master, (prompts[index][1] + '\r').encode())
                index += 1
                buffer = ''
        if proc.wait(timeout=5) != 0 or index != len(prompts):
            raise RuntimeError('Synthetic bootstrap command failed')
    finally:
        os.close(master)

ceremony(['geops-api', 'bootstrap', admin],
         [('Initial password:', passwords[0]), ('Repeat password:', passwords[0])])
for email, password in ((first, passwords[1]), (second, passwords[2])):
    ceremony(['-e', 'GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES', 'geops-api', 'recovery', 'provision', email],
             [('Custodian password:', password), ('Repeat password:', password)])
for mode in ('grant-initial', 'establish-tenant'):
    ceremony(['-e', 'GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES', 'geops-api',
              'gps-capabilities', mode, admin, first, second, str(uuid.uuid4()),
              'Disposable CI bootstrap rehearsal'],
             [('Administrator password:', passwords[0]), ('First custodian password:', passwords[1]),
              ('Second custodian password:', passwords[2])])
PY

compose=(docker compose --env-file "$env_file" -f "$root/infrastructure/compose/compose.staging.yaml" --profile maintenance)
bootstrap_state=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc \
  "SELECT (SELECT count(*) FROM admin_user),(SELECT count(*) FROM recovery_custodian),(SELECT count(*) FROM admin_permission),(SELECT count(*) FROM geops_operating_tenant)")
[[ $bootstrap_state == '1|2|10|1' ]] || { echo 'Synthetic bootstrap verification failed' >&2; exit 1; }
echo 'Admin, two custodians, ten capabilities and one synthetic tenant: PASS'
