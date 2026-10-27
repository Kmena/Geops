#!/usr/bin/env bash
# Open the maintenance gate after the B31 controller has applied schema 31.
set -Eeuo pipefail
[[ $(id -u) -eq 0 && -t 0 && -t 1 ]] || { echo 'BLOCKED interactive root console required' >&2; exit 1; }
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
api='ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c'
request_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
epoch="$(python3 - <<'PY'
import json, pathlib, sys
j=json.loads(pathlib.Path('/var/lib/geops-b31-staging/promotion.json').read_bytes())
g=json.loads(pathlib.Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json').read_bytes())
if (j.get('phase')!='awaiting-recovery' or
    j.get('policySha256')!='75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0' or
    j.get('target',{}).get('apiRef')!='ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c' or
    j.get('targetLedger')!='17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0' or
    g.get('phase')!='maintenance' or g.get('epoch')!=j.get('gateEpoch') or
    g.get('nonce')!=j.get('gateNonce')):
    sys.exit('BLOCKED B31 journal or gate differs')
print(g['epoch'])
PY
)"
status="$(/usr/local/sbin/geops-b31-staging status)"
python3 -c 'import json,sys; x=json.loads(sys.argv[1]); assert x["ledger"]=={"count":31,"sha256":"17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0"} and x["gate"]=="maintenance"' "$status"
docker image inspect "$api" --format '{{json .RepoDigests}}' | grep -F "$api" >/dev/null
docker network inspect geops_spec02_stage_db >/dev/null
entry=/etc/geops-deploy-v2/bundle/infrastructure/staging/api-entrypoint.sh
[[ -f "$entry" && ! -L "$entry" ]]
mounts=(--mount "type=bind,src=$entry,dst=/geops-stage-entrypoint.sh,readonly")
for name in db_password admin_session_key admin_csrf_key invitation_hmac_key mdm_grant_key gps_quarantine_key; do
  secret=/etc/geops-deploy-v2/runtime-secrets/$name
  [[ -f "$secret" && ! -L "$secret" ]]
  mounts+=(--mount "type=bind,src=$secret,dst=/run/secrets/$name,readonly")
done
printf 'Administrador activo (correo): '; IFS= read -r admin_email
printf 'Primer custodio activo (correo): '; IFS= read -r first_email
printf 'Segundo custodio activo (correo): '; IFS= read -r second_email
[[ -n "$admin_email" && -n "$first_email" && -n "$second_email" && "$first_email" != "$second_email" ]]
echo 'B31 recovery will request three passwords without echo.'
DOCKER_CONFIG=/etc/geops-deploy-v2/docker docker run --rm -it --pull=never \
  --network geops_spec02_stage_db --user 1000:1000 --group-add 24001 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1.0 --pids-limit 128 \
  --mount type=volume,src=geops_spec02_stage_security,dst=/geops-security \
  "${mounts[@]}" \
  -e GEOPS_DATA_MODE=synthetic \
  -e GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json \
  -e GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev \
  -e "GEOPS_CONFIRM_MAINTENANCE_EPOCH=$epoch" \
  -e GEOPS_CONFIRM_FORWARD_RECOVERY=YES \
  -e GEOPS_CONFIRM_COMPATIBLE_RELEASE=YES \
  --entrypoint /bin/sh "$api" /geops-stage-entrypoint.sh maintenance-recover \
  "$admin_email" "$first_email" "$second_email" "$request_id" \
  'B31 supervised staging promotion after exact schema verification'
unset admin_email first_email second_email
/usr/local/sbin/geops-b31-staging status
echo "B31_SUPERVISED_GATE_OPENED requestId=$request_id"
