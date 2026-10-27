#!/usr/bin/env bash
# Emergency restart of the exact B30 containers after B31 failed before maintenance.
# Leaves the B31 journal and security gate untouched for forensic review.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
status=$(/usr/local/sbin/geops-b31-staging status)
python3 -c 'import json,sys; x=json.loads(sys.argv[1]); j=x["journal"]; assert x["gate"]=="open" and x["ledger"]=={"count":30,"sha256":"64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6"} and j["phase"]=="draining" and j["sourceStateSha256"]=="297753232179b61b04b80f13ddd7e429aea782f6469949071459c57d7d7536d3" and j["source"]["apiId"]=="sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d" and j["source"]["webId"]=="sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483"' "$status"
db=geops-spec02-staging-geops-db-1
api=geops-spec02-staging-geops-api-1
web=geops-spec02-staging-geops-web-1
[[ $(docker inspect -f '{{.State.Status}}' "$db") == running ]]
[[ $(docker inspect -f '{{.State.Health.Status}}' "$db") == healthy ]]
[[ $(docker inspect -f '{{.Image}}' "$api") == sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d ]]
[[ $(docker inspect -f '{{.Image}}' "$web") == sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483 ]]
for name in "$api" "$web"; do
  state=$(docker inspect -f '{{.State.Status}}' "$name")
  if [[ "$state" == exited ]]; then
    docker start "$name" >/dev/null
  elif [[ "$state" != running ]]; then
    echo "BLOCKED unexpected container state $name=$state" >&2
    exit 1
  fi
done
for i in $(seq 1 90); do
  a=$(docker inspect -f '{{.State.Health.Status}}' "$api")
  w=$(docker inspect -f '{{.State.Health.Status}}' "$web")
  if [[ "$a" == healthy && "$w" == healthy ]]; then break; fi
  if [[ "$a" == unhealthy || "$w" == unhealthy ]]; then
    echo "BLOCKED B30 health api=$a web=$w" >&2; exit 1
  fi
  sleep 2
done
[[ "$a" == healthy && "$w" == healthy ]] || { echo "BLOCKED B30 health timeout api=$a web=$w" >&2; exit 1; }
status=$(/usr/local/sbin/geops-b31-staging status)
python3 -c 'import json,sys; x=json.loads(sys.argv[1]); assert x["gate"]=="open" and x["ledger"]=={"count":30,"sha256":"64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6"} and x["journal"]["phase"]=="draining"' "$status"
/usr/local/sbin/geops-b30-staging verify
echo 'B30_SERVICES_EMERGENCY_RESTORED_B31_JOURNAL_PRESERVED'
