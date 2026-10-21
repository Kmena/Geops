#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  printf '%s\n' 'Uso: ubuntu-rehearsal.sh --dump /ruta/privada/staging.dump --sha256 HASH --evidence-dir /ruta/privada/evidencia --confirm ISOLATED_0015_REHEARSAL' >&2
  exit 2
}

[[ $# -eq 8 && ${1:-} == --dump && ${3:-} == --sha256 && ${5:-} == --evidence-dir && ${7:-} == --confirm ]] || usage
dump_input=$2
expected_hash=$4
evidence_input=$6
[[ $8 == ISOLATED_0015_REHEARSAL && $expected_hash =~ ^[a-f0-9]{64}$ ]] || usage

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ $(git -C "$root" branch --show-current) == codex/spec-02-wave-1 ]] || { echo 'Rama GEOPS incorrecta' >&2; exit 1; }
[[ -f $dump_input && ! -L $dump_input && -d $evidence_input && ! -L $evidence_input ]] || { echo 'Dump o directorio de evidencia inválido' >&2; exit 1; }
dump=$(realpath -e -- "$dump_input")
evidence=$(realpath -e -- "$evidence_input")
case "$dump" in "$root"/*) echo 'El dump debe quedar fuera del repositorio' >&2; exit 1 ;; esac
case "$evidence" in "$root"/*) echo 'La evidencia debe quedar fuera del repositorio' >&2; exit 1 ;; esac
[[ $(stat -c %u -- "$dump") == "$(id -u)" && $(stat -c %u -- "$evidence") == "$(id -u)" ]] || { echo 'El operador debe ser propietario del dump y la evidencia' >&2; exit 1; }
dump_mode=$(stat -c %a -- "$dump")
evidence_mode=$(stat -c %a -- "$evidence")
(( (8#$dump_mode & 077) == 0 && (8#$evidence_mode & 077) == 0 )) || { echo 'Dump y evidencia requieren permisos privados' >&2; exit 1; }
actual_hash=$(sha256sum -- "$dump" | cut -d' ' -f1)
[[ $actual_hash == "$expected_hash" ]] || { echo 'Checksum del dump no coincide' >&2; exit 1; }
[[ -z ${DOCKER_HOST:-} || ${DOCKER_HOST:-} == unix:///var/run/docker.sock ]] || { echo 'Docker remoto prohibido' >&2; exit 1; }
[[ -z ${DOCKER_CONTEXT:-} && -z ${BUILDX_BUILDER:-} && -z ${BUILDKIT_HOST:-} ]] || { echo 'Overrides remotos de Docker/BuildKit prohibidos' >&2; exit 1; }
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix://* ]] || { echo 'Se requiere Docker local por socket Unix' >&2; exit 1; }

stamp=$(date -u +%Y%m%d%H%M%S)
suffix="${stamp}$$"
network="geops-0015-rehearsal-${suffix}"
database_container="geops-0015-db-${suffix}"
image="geops-0015-rehearsal:${suffix}"
replica="geops_verify_${suffix}_restore"
fixture_migration="geops_verify_${suffix}1"
fixture_recovery="geops_verify_${suffix}2"
fixture_admin="geops_verify_${suffix}3"
scratch=$(mktemp -d '/tmp/geops-0015-rehearsal.XXXXXXXX')
[[ $scratch == /tmp/geops-0015-rehearsal.* && -d $scratch && ! -L $scratch ]] || { echo 'Directorio temporal inválido' >&2; exit 1; }
chmod 700 "$scratch"
mkdir -m 700 "$scratch/gate"
openssl rand -hex 32 > "$scratch/db_password"
chmod 600 "$scratch/db_password"
stage=preflight
completed=no
created_container=
created_network=
built_image=
cleanup() {
  code=$?
  if [[ $completed != yes ]]; then
    printf '{"result":"BLOCKED","stage":"%s"}\n' "$stage" > "$evidence/result.json"
  fi
  if [[ -n $created_container ]]; then
    docker rm -f "$created_container" >/dev/null 2>&1 || true
  fi
  if [[ -n $created_network ]]; then
    docker network rm "$created_network" >/dev/null 2>&1 || true
  fi
  if [[ -n $built_image && $(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true) == "$built_image" ]]; then
    docker image rm "$image" >/dev/null 2>&1 || true
  fi
  if [[ $scratch == /tmp/geops-0015-rehearsal.* && -d $scratch && ! -L $scratch ]]; then
    rm -rf -- "$scratch"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

stage=build
if docker container inspect "$database_container" >/dev/null 2>&1 ||
  docker network inspect "$network" >/dev/null 2>&1 ||
  docker image inspect "$image" >/dev/null 2>&1; then
  echo 'El nombre de un recurso temporal ya existe; ensayo cancelado sin tocarlo' >&2
  exit 1
fi
built_image=$(docker build -q -f "$root/infrastructure/docker/api-release-rehearsal.Dockerfile" -t "$image" "$root")
api_image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ $api_image_id == "$built_image" ]] || { echo 'La imagen de ensayo cambió inesperadamente' >&2; exit 1; }
postgis_image_id=$(docker image inspect postgis/postgis:18-3.6 --format '{{.Id}}')
git_sha=$(git -C "$root" rev-parse HEAD)
dirty=no
[[ -z $(git -C "$root" status --porcelain) ]] || dirty=yes
printf '{"result":"IN_PROGRESS","git_sha":"%s","working_tree_dirty":"%s","dump_sha256":"%s","api_image_id":"%s","postgis_image_id":"%s","public_ports":0}\n' \
  "$git_sha" "$dirty" "$actual_hash" "$api_image_id" "$postgis_image_id" > "$evidence/source.json"

stage=isolation
created_network=$(docker network create --internal "$network")
[[ $(docker network inspect "$created_network" --format '{{.Internal}}') == true ]] || { echo 'Red no aislada' >&2; exit 1; }
created_container=$(docker run -d --name "$database_container" --network "$created_network" \
  --tmpfs /var/lib/postgresql:rw,size=1073741824 \
  --memory 1536m --cpus 1 --pids-limit 256 --security-opt no-new-privileges \
  -e POSTGRES_DB="$replica" -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --mount "type=bind,src=$scratch/db_password,dst=/run/secrets/db_password,readonly" \
  postgis/postgis:18-3.6)
[[ -z $(docker port "$created_container") ]] || { echo 'PostGIS tiene un puerto publicado' >&2; exit 1; }
ready=no
for _ in $(seq 1 40); do
  if docker exec "$created_container" pg_isready -h 127.0.0.1 -U postgres -d "$replica" >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[[ $ready == yes ]] || { echo 'PostGIS desechable no inició' >&2; exit 1; }

run_app() {
  local db_name=$1
  shift
  docker run --rm --network "container:$created_container" \
    --user "$(id -u):$(id -g)" --memory 768m --cpus 1 --pids-limit 192 \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=67108864 \
    --security-opt no-new-privileges \
    --mount "type=bind,src=$scratch,dst=/run/rehearsal" \
    -e REHEARSAL_DB_NAME="$db_name" -e GEOPS_DATA_MODE=synthetic \
    -e GEOPS_TEST_DB="$db_name" -e GEOPS_MIGRATION_TARGET="$db_name" \
    -e GEOPS_CONFIRM_MIGRATION_TARGET="$db_name" \
    -e GEOPS_SECURITY_GATE_PATH=/run/rehearsal/gate/security-gate.json \
    -e GEOPS_CONFIRM_LOST_GATE=YES -e GEOPS_CONFIRM_RESTORE_QUARANTINE=YES \
    "$built_image" sh -ec '
      password=$(cat /run/rehearsal/db_password)
      export DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:5432/${REHEARSAL_DB_NAME}"
      exec "$@"
    ' sh "$@"
}

stage=restore
docker exec -i "$created_container" pg_restore --list < "$dump" >/dev/null
docker exec -i "$created_container" pg_restore --exit-on-error --no-owner --no-acl \
  -U postgres -d "$replica" < "$dump" >/dev/null
run_app "$replica" node scripts/release-0015/replica-check.mjs pre > "$scratch/pre.json"

stage=migration
run_app "$replica" node apps/api/dist/db/migrate.js >/dev/null
run_app "$replica" node scripts/release-0015/replica-check.mjs post > "$scratch/post.json"
run_app "$replica" node scripts/release-0015/replica-check.mjs compare \
  /run/rehearsal/pre.json /run/rehearsal/post.json > "$scratch/integrity.json"

stage=quarantine
run_app "$replica" node apps/api/dist/db/security-gate-cli.js recover-missing >/dev/null
run_app "$replica" node scripts/release-0015/replica-check.mjs gate-before-quarantine > "$scratch/gate-before.json"
run_app "$replica" node apps/api/dist/db/quarantine-restored-db.js >/dev/null
run_app "$replica" node scripts/release-0015/replica-check.mjs gate-after-quarantine > "$scratch/gate-after.json"

stage=fault-tests
docker exec "$created_container" createdb -U postgres "$fixture_migration"
run_app "$fixture_migration" node --import tsx apps/api/test/migration-0015-upgrade.integration.mjs > "$scratch/migration-test.log"
docker exec "$created_container" createdb -U postgres "$fixture_recovery"
run_app "$fixture_recovery" node --import tsx apps/api/test/migration-0015-upgrade.integration.mjs prepare-14 > "$scratch/fixture-test.log"
run_app "$fixture_recovery" node --import tsx apps/api/test/maintenance-recovery.integration.mjs > "$scratch/recovery-test.log"
docker exec "$created_container" createdb -U postgres "$fixture_admin"
run_app "$fixture_admin" node apps/api/dist/db/migrate.js > "$scratch/admin-migrate.log"
run_app "$fixture_admin" node --import tsx apps/api/test/gps-capability-bootstrap.integration.mjs > "$scratch/capability-test.log"
run_app "$fixture_admin" node --import tsx apps/api/test/admin-tenant-bootstrap.integration.mjs > "$scratch/tenant-test.log"
run_app "$fixture_admin" node --import tsx apps/api/test/single-tenant-users.integration.mjs > "$scratch/users-test.log"

for name in pre post integrity gate-before gate-after; do
  cp -- "$scratch/$name.json" "$evidence/$name.json"
done
grep -E '^(Migrations 0015-0018 upgrade|Supervised forward recovery|GPS capability bootstrap|Administrative tenant bootstrap|Single-tenant user administration).*PASS$' \
  "$scratch/migration-test.log" "$scratch/recovery-test.log" "$scratch/capability-test.log" \
  "$scratch/tenant-test.log" "$scratch/users-test.log" | sed 's@.*/@@' > "$evidence/synthetic-results.txt"
[[ $(wc -l < "$evidence/synthetic-results.txt") -eq 5 ]] || { echo 'Resumen de pruebas incompleto' >&2; exit 1; }
printf '{"result":"PASS","scope":"isolated_replica_and_synthetic_faults","gate":"closed","public_ports":0,"source_dirty":"%s"}\n' "$dirty" > "$evidence/result.json"
completed=yes
printf '%s\n' 'GEOPS schema 14-18 rehearsal PASS. Replica gate remained closed; evidence contains aggregates only.'
