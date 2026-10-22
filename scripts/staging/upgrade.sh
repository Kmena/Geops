#!/usr/bin/env bash
# Forward-only update of the isolated GEOPS Staging Compose project.
set -Eeuo pipefail
set +x
umask 077

TARGET_SHA=03e582fba66c0d29eab885e109d3404e86b140a3
DATABASE=geops_dev
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
env_file=$root/infrastructure/compose/.env.staging

usage() {
  echo 'Usage: upgrade.sh check API_IMAGE_ID WEB_IMAGE_ID' >&2
  echo '       upgrade.sh apply|resume API_IMAGE_ID WEB_IMAGE_ID REQUEST_UUID ADMIN_EMAIL CUSTODIAN1_EMAIL CUSTODIAN2_EMAIL REASON CONFIRMED' >&2
  echo '       upgrade.sh reconcile|reconcile-retry API_IMAGE_ID WEB_IMAGE_ID DB_EPOCH CLOSED_EPOCH REQUEST_UUID ADMIN_EMAIL CUSTODIAN1_EMAIL CUSTODIAN2_EMAIL REASON CONFIRMED' >&2
  exit 2
}

[[ $# -ge 3 ]] || usage
mode=$1 api_id=$2 web_id=$3
[[ $mode == check || $mode == apply || $mode == resume || $mode == reconcile || $mode == reconcile-retry ]] || usage
[[ $api_id =~ ^sha256:[0-9a-f]{64}$ && $web_id =~ ^sha256:[0-9a-f]{64}$ ]] || usage
if [[ $mode == check ]]; then
  [[ $# -eq 3 ]] || usage
else
  if [[ $mode == reconcile || $mode == reconcile-retry ]]; then
    [[ $# -eq 11 && ${11} == CONFIRMED ]] || usage
    original_epoch=$4 closed_epoch=$5 request_id=$6 admin_email=$7 first_email=$8 second_email=$9 reason=${10}
    [[ $original_epoch =~ ^[0-9a-fA-F-]{36}$ && $closed_epoch =~ ^[0-9a-fA-F-]{36}$ && $original_epoch != "$closed_epoch" ]] || usage
  else
    [[ $# -eq 9 && $9 == CONFIRMED ]] || usage
    request_id=$4 admin_email=$5 first_email=$6 second_email=$7 reason=$8
  fi
  [[ $request_id =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || usage
  [[ $admin_email != "$first_email" && $admin_email != "$second_email" && $first_email != "$second_email" ]] || usage
  [[ ${#reason} -ge 8 && ${#reason} -le 240 ]] || usage
  [[ -t 0 && -t 1 ]] || { echo 'Recovery requires an interactive terminal for hidden credentials.' >&2; exit 2; }
fi

die() { echo "Stopped: $*" >&2; exit 1; }
command -v git >/dev/null && command -v docker >/dev/null && command -v python3 >/dev/null && command -v sha256sum >/dev/null && command -v flock >/dev/null || die 'Required local tool missing'
[[ $(uname -s) == Linux ]] || die 'Run on a Linux SSH host'
[[ -z ${DOCKER_HOST:-} || ${DOCKER_HOST:-} == unix:///var/run/docker.sock ]] || die 'Remote Docker host prohibited'
[[ -z ${DOCKER_CONTEXT:-} && -z ${BUILDX_BUILDER:-} && -z ${BUILDKIT_HOST:-} ]] || die 'Docker overrides prohibited'
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix://* ]] || die 'Local Unix Docker required'
[[ -f $env_file && ! -L $env_file ]] || die 'Expected private Staging environment file missing'
[[ $(stat -c %u -- "$env_file") == "$(id -u)" ]] || die 'Environment file owner mismatch'
env_mode=$(stat -c %a -- "$env_file")
(( (8#$env_mode & 077) == 0 )) || die 'Environment file must be private'
lock_file=$root/infrastructure/compose/.local/staging/upgrade.lock
[[ -d ${lock_file%/*} && ! -L $lock_file ]] || die 'Staging lock directory missing or unsafe'
exec 9>"$lock_file"
flock -n 9 || die 'Another Staging upgrade process holds the lock'

[[ $(git -C "$root" rev-parse --show-toplevel) == "$root" ]] || die 'Unexpected repository root'
git -C "$root" merge-base --is-ancestor "$TARGET_SHA" HEAD || die 'Target commit is not an ancestor'
git -C "$root" diff --quiet "$TARGET_SHA" HEAD -- apps/api apps/web packages/api-contracts infrastructure/docker infrastructure/compose/compose.staging.yaml || die 'Application or Compose source differs from target commit'
[[ -z $(git -C "$root" status --porcelain --untracked-files=all) ]] || die 'Checkout has local changes'

compose=(docker compose --env-file "$env_file" -f "$root/infrastructure/compose/compose.staging.yaml" --profile maintenance)
"${compose[@]}" config --format json | python3 -I -c '
import json,sys
c=json.load(sys.stdin); sha=sys.argv[1]
assert c["name"] == "geops-spec02-staging"
assert set(c["services"]) == {"geops-db","geops-migrate","geops-gate-init","geops-api","geops-web","geops-backup"}
assert c["services"]["geops-api"]["image"] == "geops-spec02-api:"+sha
assert c["services"]["geops-web"]["image"] == "geops-spec02-web:"+sha
assert c["services"]["geops-gate-init"]["image"] == c["services"]["geops-api"]["image"]
assert c["services"]["geops-api"]["environment"]["MDM_ENABLED"] == "false"
assert c["services"]["geops-web"]["build"]["args"]["MDM_ENABLED"] == "false"
assert all(not s.get("ports") and not s.get("network_mode") for s in c["services"].values())
assert set(c["services"]["geops-db"]["networks"]) == {"stage_db"}
assert set(c["services"]["geops-api"]["networks"]) == {"stage_app","stage_db"}
assert set(c["services"]["geops-web"]["networks"]) == {"stage_app","stage_edge"}
assert c["networks"]["stage_edge"]["external"] is True
assert c["volumes"]["stage_pgdata"]["name"] == "geops_spec02_stage_pgdata"
assert c["volumes"]["stage_security"]["name"] == "geops_spec02_stage_security"
' "$TARGET_SHA" || die 'Compose configuration differs from isolated Staging project'

actual_api_id=$(docker image inspect "geops-spec02-api:$TARGET_SHA" --format '{{.Id}}') || die 'Target API image missing'
actual_web_id=$(docker image inspect "geops-spec02-web:$TARGET_SHA" --format '{{.Id}}') || die 'Target Web image missing'
[[ $actual_api_id == "$api_id" && $actual_web_id == "$web_id" ]] || die 'Image IDs differ from operator-approved IDs'

catalog_host() {
  local sql
  for sql in "$root"/apps/api/src/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
    printf '%s|%s\n' "${sql##*/}" "$(sha256sum -- "$sql" | cut -d' ' -f1)"
  done
}
expected_catalog=$(catalog_host)
[[ $(printf '%s\n' "$expected_catalog" | wc -l) -eq 21 ]] || die 'Source migration catalog is not 21 files'
image_catalog=$("${compose[@]}" run --rm --no-deps -T --entrypoint node geops-gate-init -e '
const fs=require("fs"),crypto=require("crypto"),p="/work/apps/api/dist/db/migrations";
for(const n of fs.readdirSync(p).filter(n=>/^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort())
 console.log(n+"|"+crypto.createHash("sha256").update(fs.readFileSync(p+"/"+n)).digest("hex"));
') || die 'Cannot read migration catalog in approved API image'
[[ $image_catalog == "$expected_catalog" ]] || die 'API image migration catalog differs from source'

db_query() { "${compose[@]}" exec -T geops-db psql -X -qAt -v ON_ERROR_STOP=1 -U geops_stage -d "$DATABASE" -c "$1"; }
gate_metadata() {
  "${compose[@]}" run --rm --no-deps -T --entrypoint node geops-gate-init -e '
const fs=require("fs"),g=JSON.parse(fs.readFileSync("/geops-security/security-gate.json","utf8"));
if(g.version!==1||!["open","maintenance","closed"].includes(g.phase)||!/^[0-9a-f-]{36}$/i.test(g.epoch))process.exit(1);
console.log(g.phase+" "+g.epoch);
'
}
check_ledger() {
  local count=$1 observed expected
  observed=$(db_query 'SELECT concat(version,chr(124),checksum) FROM geops_schema_migrations ORDER BY version') || die 'Cannot read migration ledger'
  expected=$(printf '%s\n' "$expected_catalog" | head -n "$count")
  [[ $observed == "$expected" ]] || die "Ledger names/checksums differ from exact $count-migration prefix"
}
connection_count() {
  db_query "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type<>'autovacuum worker'"
}
service_container() { "${compose[@]}" ps -q "$1"; }
service_running() {
  local cid
  cid=$(service_container "$1")
  [[ -n $cid && $(docker inspect "$cid" --format '{{.State.Running}}') == true ]]
}
wait_healthy() {
  local service=$1 cid status i
  for ((i=0;i<24;i++)); do
    cid=$(service_container "$service")
    if [[ -n $cid ]]; then
      status=$(docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
      [[ $status == healthy ]] && return 0
      [[ $status == unhealthy || $status == exited ]] && return 1
    fi
    sleep 5
  done
  return 1
}

service_running geops-db || die 'PostGIS is not running'
wait_healthy geops-db || die 'PostGIS is not healthy'
read -r phase epoch < <(gate_metadata) || die 'Cannot read security gate'
db_epoch=$(db_query 'SELECT epoch::text FROM security_epoch WHERE singleton=true') || die 'Cannot read database epoch'
[[ $epoch =~ ^[0-9a-fA-F-]{36}$ && $db_epoch =~ ^[0-9a-fA-F-]{36}$ ]] || die 'Gate or database epoch invalid'
ledger_count=$(db_query 'SELECT count(*) FROM geops_schema_migrations') || die 'Cannot read ledger count'
if [[ $mode == reconcile || $mode == reconcile-retry ]]; then
  [[ $ledger_count == 18 ]] || die 'Closed-gate reconciliation requires exactly 18 migrations'
  [[ $original_epoch == "$db_epoch" || $mode == reconcile-retry ]] || die 'Database epoch differs from approved original'
  [[ $closed_epoch == "$epoch" || $mode == reconcile-retry ]] || die 'External epoch differs from approved closed epoch'
  [[ $phase == closed || ( $mode == reconcile-retry && $phase == maintenance ) ]] || die 'Reconciliation requires closed or interrupted maintenance gate'
  service_running geops-api && die 'API must be stopped before reconciliation'
  service_running geops-web && die 'Web must be stopped before reconciliation'
elif [[ $mode == resume ]]; then
  [[ $db_epoch == "$epoch" ]] || die 'Gate and database epoch differ'
  [[ $phase == maintenance && $ledger_count =~ ^(18|19|20|21)$ ]] || die 'Resume requires maintenance gate and schema 18-21'
  service_running geops-api && die 'API must be stopped before resume'
  service_running geops-web && die 'Web must be stopped before resume'
else
  [[ $db_epoch == "$epoch" ]] || die 'Gate and database epoch differ'
  [[ $phase == open && $ledger_count == 18 ]] || die 'Initial update requires open gate and exactly 18 migrations'
  service_running geops-api && service_running geops-web || die 'Expected current API/Web are not both running'
  old_api=$(service_container geops-api)
  old_web=$(service_container geops-web)
  [[ $(docker inspect "$old_api" --format '{{.Config.Image}}') == geops-spec02-api:90ab9e9f* ]] || die 'Running API is not the confirmed previous release'
  [[ $(docker inspect "$old_web" --format '{{.Config.Image}}') == geops-spec02-web:90ab9e9f* ]] || die 'Running Web is not the confirmed previous release'
  [[ $(docker inspect "$old_api" --format '{{.Image}}') != "$api_id" && $(docker inspect "$old_web" --format '{{.Image}}') != "$web_id" ]] || die 'Target images are not distinct from previous containers'
fi
check_ledger "$ledger_count"
if [[ $mode == check ]]; then
  printf 'Preflight PASS: target=%s ledger=%s gate=%s images match approved IDs; no service changed.\n' "$TARGET_SHA" "$ledger_count" "$phase"
  exit 0
fi

if [[ $mode == reconcile || $mode == reconcile-retry ]]; then
  [[ -f $root/scripts/staging/reconcile-closed.mjs && ! -L $root/scripts/staging/reconcile-closed.mjs ]] || die 'Reconciliation implementation missing'
  GEOPS_EXPECT_DB_EPOCH=$original_epoch
  GEOPS_EXPECT_CLOSED_EPOCH=$closed_epoch
  GEOPS_CONFIRM_CLOSED_RECONCILIATION=YES
  export GEOPS_EXPECT_DB_EPOCH GEOPS_EXPECT_CLOSED_EPOCH GEOPS_CONFIRM_CLOSED_RECONCILIATION
  reconcile_mode=apply
  [[ $mode == reconcile-retry ]] && reconcile_mode=retry
  "${compose[@]}" run --rm --no-deps --interactive \
    -v "$root/scripts/staging:/work/scripts/staging:ro" \
    -e GEOPS_EXPECT_DB_EPOCH -e GEOPS_EXPECT_CLOSED_EPOCH \
    -e GEOPS_CONFIRM_CLOSED_RECONCILIATION --entrypoint sh geops-gate-init \
    -c 'db_password=$(cat /run/secrets/db_password); case "$db_password" in *[!A-Za-z0-9_-]*) exit 1;; esac; [ "${#db_password}" -ge 32 ] || exit 1; export DATABASE_URL="postgresql://geops_stage:${db_password}@geops-db:5432/geops_dev"; exec node /work/scripts/staging/reconcile-closed.mjs "$@"' \
    sh "$reconcile_mode" "$request_id" "$admin_email" "$first_email" "$second_email" "$reason"
  read -r phase epoch < <(gate_metadata) || die 'Cannot read reconciled gate'
  [[ $phase == maintenance && $epoch == "$(db_query 'SELECT epoch::text FROM security_epoch WHERE singleton=true')" ]] || die 'Reconciliation incomplete; keep API/Web stopped'
  echo 'Reconciliation verified. Use resume with a NEW request UUID and full authorization ceremony.'
  exit 0
fi

GEOPS_CONFIRM_MAINTENANCE_TARGET=$DATABASE
GEOPS_CONFIRM_MAINTENANCE_EPOCH=$epoch
export GEOPS_CONFIRM_MAINTENANCE_TARGET GEOPS_CONFIRM_MAINTENANCE_EPOCH
completed=0
stopped=0
stage=preflight
on_exit() {
  local result=$?
  [[ $completed == 1 || $result == 0 ]] && return
  trap - EXIT ERR INT TERM
  set +e
  if [[ $stopped == 1 ]]; then
    "${compose[@]}" stop geops-web geops-api >/dev/null
    local current_phase current_epoch
    read -r current_phase current_epoch < <(gate_metadata)
    echo "Update stopped at stage=$stage; API/Web stopped; gate phase=${current_phase:-unknown}. Preserve DB and gate; diagnose before explicit retry." >&2
  fi
  exit "$result"
}
trap on_exit EXIT

if [[ $mode == apply ]]; then
  stopped=1
  stage=traffic_stop
  "${compose[@]}" stop geops-web geops-api
  stage=isolation
  [[ $(connection_count) == 0 ]] || die 'Other database connections remain after traffic stop'
  stage=maintenance_start
  "${compose[@]}" run --rm --no-deps -T -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH geops-gate-init gate maintenance-start
else
  stopped=1
  stage=isolation
  [[ $(connection_count) == 0 ]] || die 'Other database connections prevent recovery'
fi

stage=maintenance_verify
read -r phase observed_epoch < <(gate_metadata)
[[ $phase == maintenance && $observed_epoch == "$epoch" ]] || die 'Maintenance gate or epoch mismatch'
"${compose[@]}" run --rm --no-deps -T -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH geops-gate-init gate maintenance-verify
check_ledger "$ledger_count"

# The existing CLI reads three passwords directly from its TTY with echo disabled.
# It performs the missing SQL migrations, audits the exact identities, and opens the gate.
stage=migration_and_recovery
"${compose[@]}" run --rm --no-deps --interactive \
  -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH \
  -e GEOPS_CONFIRM_FORWARD_RECOVERY=YES -e GEOPS_CONFIRM_COMPATIBLE_RELEASE=YES \
  geops-gate-init maintenance-recover "$admin_email" "$first_email" "$second_email" "$request_id" "$reason"

check_ledger 21
read -r phase observed_epoch < <(gate_metadata)
[[ $phase == open && $observed_epoch == "$epoch" ]] || die 'Recovery did not reopen the same epoch'
[[ $(db_query "SELECT count(*) FROM geops_maintenance_marker WHERE singleton=true AND epoch='$epoch'::uuid AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())") == 1 ]] || die 'Post-recovery database marker mismatch'
[[ $(connection_count) == 0 ]] || die 'Unexpected connections before API start'

stage=api_start
"${compose[@]}" up -d --no-deps geops-api
wait_healthy geops-api || die 'New API failed readiness check'
[[ $(docker inspect "$(service_container geops-api)" --format '{{.Image}}') == "$api_id" ]] || die 'Running API image differs from approved ID'
stage=web_start
"${compose[@]}" up -d --no-deps geops-web
wait_healthy geops-web || die 'New Web failed health check'
[[ $(docker inspect "$(service_container geops-web)" --format '{{.Image}}') == "$web_id" ]] || die 'Running Web image differs from approved ID'
"${compose[@]}" exec -T geops-web wget -q -O /dev/null http://geops-api:3500/health/ready || die 'Web-to-API network readiness failed'
check_ledger 21
read -r phase observed_epoch < <(gate_metadata)
[[ $phase == open && $observed_epoch == "$epoch" ]] || die 'Final gate/epoch mismatch'
completed=1
printf 'Local checks PASS: target=%s schema=21 gate=open same epoch; API/Web healthy on approved image IDs.\n' "$TARGET_SHA"
echo 'Operator must now verify HTTPS, login, tenant GPS workflows and MDM-disabled behavior; Staging acceptance is not automatic.'
