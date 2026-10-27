#!/usr/bin/env bash
# Focused read-only B31 staging verification after privileged controller completes.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b31-staging verify
status=$(/usr/local/sbin/geops-b31-staging status)
printf '%s' "$status" | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["gate"]=="open" and x["ledger"]=={"count":31,"sha256":"17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0"} and x["journal"]["phase"]=="complete"; print("B31_JOURNAL_LEDGER_GATE_PASS")'
evidence=/root/geops-b31-restore-evidence-H6EDph/restore-evidence.json
[[ -f "$evidence" && ! -L "$evidence" ]]
[[ $(sha256sum "$evidence" | awk '{print $1}') == 45ffd1e232b8bdecc08c10698f726401f3d720fc763b1d6db516b716730f0bcc ]]
baseline=$(python3 -c 'import json; x=json.load(open("/root/geops-b31-restore-evidence-H6EDph/restore-evidence.json")); assert x["result"]=="PASS" and x["sqlCount"]==30 and x["backupSha256"]=="f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705"; print(str(x["mdmBindings"])+"|"+str(x["positionEvents"]))')
observed=$(docker exec geops-spec02-staging-geops-db-1 psql -X -v ON_ERROR_STOP=1 -U geops_stage -d geops_dev -Atq -c "SELECT (SELECT count(*) FROM mdm_binding)::text || '|' || (SELECT count(*) FROM position_event)::text")
python3 -c 'import sys; a,b=map(int,sys.argv[1].split("|")); c,d=map(int,sys.argv[2].split("|")); assert c>=a and d>=b; print("B31_MDM_GPS_ROWS_PRESERVED baseline="+sys.argv[1]+" current="+sys.argv[2])' "$baseline" "$observed"
objects=$(docker exec geops-spec02-staging-geops-db-1 psql -X -v ON_ERROR_STOP=1 -U geops_stage -d geops_dev -Atq -c "SELECT count(*) FROM (VALUES ('client'),('client_site'),('client_geofence_revision'),('route_template'),('agent'),('route_assignment'),('visit_evaluation'),('agent_device_link'),('agent_operational_identity'),('agent_responsibility'),('geocoding_cache')) AS x(name) WHERE to_regclass('public.'||name) IS NOT NULL")
[[ "$objects" == 11 ]] || { echo 'BLOCKED SPEC03 table inventory differs' >&2; exit 1; }
echo 'B31_SPEC03_TABLES_PASS'
docker exec geops-spec02-staging-geops-api-1 node -e 'const base="http://127.0.0.1:3500"; (async()=>{for(const p of ["/health/live","/health/ready"]){const r=await fetch(base+p);if(r.status!==200)throw Error(p+" "+r.status)}for(const p of ["/v1/admin/client-capabilities","/v1/admin/compliance","/v1/admin/gps-capabilities","/v1/admin/mdm/status"]){const r=await fetch(base+p);if(![401,403].includes(r.status))throw Error(p+" "+r.status)}console.log("B31_API_SPEC03_GPS_MDM_SMOKE_PASS")})().catch(e=>{console.error(e.message);process.exit(1)})'
docker exec geops-spec02-staging-geops-web-1 wget -q -O /dev/null http://127.0.0.1:8080/health
echo 'B31_STAGING_FOCUSED_VERIFICATION_PASS'