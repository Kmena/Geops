#!/usr/bin/env bash
# B32 promotion source backup and isolated B31 restore rehearsal. No live database writes.
set -Eeuo pipefail
umask 077
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
project=geops-spec02-staging
expected_ledger=17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0
backup_dir=/var/lib/docker/volumes/geops_spec02_stage_backups/_data
bundle=/etc/geops-deploy-v2/bundle
container=
stage=preflight
cleanup() {
  result=$?
  if (( result != 0 )); then
    printf 'B32_BACKUP_RESTORE_FAILED stage=%s exit=%s\n' "$stage" "$result" >&2
  fi
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b31-staging verify
status=$(/usr/local/sbin/geops-b31-staging status)
printf '%s' "$status" | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["gate"]=="open" and x["ledger"]["count"]==31 and x["ledger"]["sha256"]=="17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0" and x["journal"]["phase"]=="complete"'
free_kb=$(df -Pk / | awk 'NR==2 {print $4}')
(( free_kb > 2097152 )) || { echo 'BLOCKED insufficient free space' >&2; exit 1; }
echo 'B32_BACKUP_PREFLIGHT_PASS'

stage=backup
export GEOPS_STAGE_SECRET_GID=$(python3 -c 'import json; print(json.load(open("/etc/geops-deploy-v2/policy.json"))["secretGid"])')
export GEOPS_STAGE_IMAGE_TAG=$(python3 -c 'import json; print(json.load(open("/etc/geops-deploy-v2/policy.json"))["imageTag"])')
export GEOPS_STAGE_ORIGIN=$(python3 -c 'import json; print(json.load(open("/etc/geops-deploy-v2/policy.json"))["origin"])')
cd "$bundle"
docker compose -f infrastructure/compose/compose.staging.yaml --profile maintenance run --rm --no-deps geops-backup
backup=$(find "$backup_dir" -maxdepth 1 -type f -name 'geops-stage-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[[ -n "$backup" && -f "$backup" && ! -L "$backup" && -f "$backup.sha256" && ! -L "$backup.sha256" ]]
expected=$(awk '{print $1}' "$backup.sha256")
actual=$(sha256sum "$backup" | awk '{print $1}')
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$expected" == "$actual" ]]
ttl=$(python3 -c 'import json; print(json.load(open("/etc/geops-deploy-v2/policy.json"))["backupMaxAgeSeconds"])')
age=$(( $(date +%s) - $(stat -c %Y "$backup") ))
(( age >= 0 && age <= ttl ))
file=$(basename "$backup")
printf 'B32_BACKUP_CREATED name=%s sha256=%s age_seconds=%s\n' "$file" "$actual" "$age"

stage=restore-container
container="geops-b32-restore-$(openssl rand -hex 6)"
docker run -d --pull=never --network none --name "$container" \
  --memory=1536m --pids-limit=128 \
  --tmpfs /var/lib/postgresql:rw,size=1024m \
  --mount "type=bind,src=$backup_dir,dst=/backups,readonly" \
  -e POSTGRES_USER=geops_stage -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=postgres postgis/postgis:18-3.6 >/dev/null
ready=0
for i in $(seq 1 90); do
  if docker logs "$container" 2>&1 | grep -F 'PostgreSQL init process complete; ready for start up.' >/dev/null \
      && docker exec "$container" pg_isready -U geops_stage -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
(( ready == 1 ))
echo 'B32_RESTORE_POSTGRES_READY'

stage=restore
database=geops_verify_b32_source_restore
docker exec -u 0 "$container" psql -X -v ON_ERROR_STOP=1 -U geops_stage -d postgres \
  -c "CREATE DATABASE $database TEMPLATE template0" >/dev/null
docker exec -u 0 "$container" pg_restore -l "/backups/$file" >/dev/null
docker exec -u 0 "$container" pg_restore --exit-on-error --no-owner --no-acl \
  -U geops_stage -d "$database" "/backups/$file"
echo 'B32_RESTORE_COMPLETED'

stage=ledger
ledger=$(docker exec -u 0 "$container" psql -X -v ON_ERROR_STOP=1 -U geops_stage -d "$database" -Atq \
  -c "SELECT version || '|' || checksum FROM geops_schema_migrations ORDER BY version")
count=$(printf '%s\n' "$ledger" | wc -l)
ledger_sha=$(printf '%s' "$ledger" | sha256sum | awk '{print $1}')
[[ "$count" == 31 && "$ledger_sha" == "$expected_ledger" ]]
echo "B32_RESTORE_LEDGER_PASS count=$count sha256=$ledger_sha"
tables=$(docker exec -u 0 "$container" psql -X -v ON_ERROR_STOP=1 -U geops_stage -d "$database" -Atq \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
positions=$(docker exec -u 0 "$container" psql -X -v ON_ERROR_STOP=1 -U geops_stage -d "$database" -Atq \
  -c 'SELECT count(*) FROM position_event')
bindings=$(docker exec -u 0 "$container" psql -X -v ON_ERROR_STOP=1 -U geops_stage -d "$database" -Atq \
  -c 'SELECT count(*) FROM mdm_binding')
(( tables > 0 ))
image_id=$(docker image inspect postgis/postgis:18-3.6 --format '{{.Id}}')
docker rm -f "$container" >/dev/null
container=
stage=evidence
evidence_dir=$(mktemp -d -p /root geops-b32-restore-evidence-XXXXXX)
evidence="$evidence_dir/restore-evidence.json"
printf '{"schemaVersion":1,"result":"PASS","environment":"%s","backupSha256":"%s","sqlCount":31,"sqlListSha256":"%s","isolatedDatabase":"%s","network":"none","publicTables":%s,"mdmBindings":%s,"positionEvents":%s,"postgisImageId":"%s","restoredAt":"%s"}\n' \
  "$project" "$actual" "$ledger_sha" "$database" "$tables" "$bindings" "$positions" "$image_id" "$(date -u +%FT%TZ)" > "$evidence"
printf 'B32_RESTORE_EVIDENCE=%s\n' "$evidence"
sha256sum "$evidence"
echo 'B32_BACKUP_RESTORE_PASS'
