#!/usr/bin/env bash
# Install the exact signed B31 restore proof and approval; no maintenance begins here.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
umask 077
incoming=/home/abi/b31-controller-stage
inbox=/var/lib/geops-b31-staging/inbox
restore=b31restore20261027be7bd337fa61449d
approval=b31approve20261027f3e8bd7633974676
release=b31release20261027c7f33dc1a433a57d
verify() {
  [[ -f "$1" && ! -L "$1" ]] || { echo "BLOCKED missing regular file $1" >&2; exit 1; }
  [[ $(sha256sum "$1" | awk '{print $1}') == "$2" ]] || { echo "BLOCKED hash differs $1" >&2; exit 1; }
}
verify "$incoming/$restore.restore.json" 2d9db3ca09ffd6fa559b6b6623ca4479005c1513d8ac631a158c08843debe760
verify "$incoming/$restore.restore.sig" 83ac3a6aa0270cbf539ff5976499ce64e68fca8c02635e1bb6e217bc5090bbf2
verify "$incoming/$approval.approval.json" 401f8f39c5637606ccc15206ebfe33201b1a852f7b09311c3b09711c801429f1
verify "$incoming/$approval.approval.sig" d476b5e7e4963c2c70a507444b01e519735c890a48cfb41e5f45c5f2af35a6d0
verify "$inbox/$release.release.json" 36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c
verify "$inbox/$release.release.sig" d35bdf8fc1412d9a498c47ca99ddca04eff49fc980fdec014cc49cb5d54b3497
verify /root/geops-b31-restore-evidence-H6EDph/restore-evidence.json 45ffd1e232b8bdecc08c10698f726401f3d720fc763b1d6db516b716730f0bcc
backup=/var/lib/docker/volumes/geops_spec02_stage_backups/_data/geops-stage-20261027T195947Z.dump
verify "$backup" f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705
ttl=$(python3 -c 'import json; print(json.load(open("/etc/geops-deploy-v2/policy.json"))["backupMaxAgeSeconds"])')
(( $(date +%s) - $(stat -c %Y "$backup") <= ttl )) || { echo 'BLOCKED backup expired' >&2; exit 1; }
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b30-staging verify
status=$(/usr/local/sbin/geops-b31-staging status)
python3 -c 'import json,sys; x=json.loads(sys.argv[1]); assert x["gate"]=="open" and x["journal"] is None and x["ledger"]=={"count":30,"sha256":"64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6"}' "$status"
prepare=$(/usr/local/sbin/geops-b31-staging prepare "$release")
python3 -c 'import json,sys; x=json.loads(sys.argv[1]); assert x["result"]=="B31_STAGING_PREPARED" and x["sourceStateSha256"]=="297753232179b61b04b80f13ddd7e429aea782f6469949071459c57d7d7536d3" and x["releaseSha256"]=="36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c"' "$prepare"
python3 - "$incoming/$restore.restore.json" "$incoming/$approval.approval.json" <<'PY'
import datetime, json, pathlib, sys
r=json.loads(pathlib.Path(sys.argv[1]).read_bytes())
a=json.loads(pathlib.Path(sys.argv[2]).read_bytes())
now=datetime.datetime.now(datetime.timezone.utc)
for d in (r,a):
    assert datetime.datetime.fromisoformat(d['notBefore'].replace('Z','+00:00')) <= now
    assert now < datetime.datetime.fromisoformat(d['expiresAt'].replace('Z','+00:00'))
assert a['restoreProofSha256']=='2d9db3ca09ffd6fa559b6b6623ca4479005c1513d8ac631a158c08843debe760'
assert a['releaseSha256']=='36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c'
assert a['sourceStateSha256']=='297753232179b61b04b80f13ddd7e429aea782f6469949071459c57d7d7536d3'
assert a['backupSha256']==r['backupSha256']=='f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705'
assert a['policySha256']==r['policySha256']=='75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0'
assert a['gateEpoch']=='18a4d309-96b0-47e5-a5e3-6939a4e8e426'
print('B31_DOCUMENT_LINKS_AND_EXPIRY_PASS')
PY
for item in "$restore.restore" "$approval.approval"; do
  for suffix in json sig; do
    src="$incoming/$item.$suffix"
    dst="$inbox/$item.$suffix"
    if [[ -e "$dst" ]]; then
      cmp -s "$src" "$dst" || { echo "BLOCKED existing document differs $dst" >&2; exit 1; }
    else
      install -o root -g root -m 0600 "$src" "$dst"
    fi
  done
  openssl pkeyutl -verify -pubin -inkey /opt/geops-b31-staging/public.pem -rawin \
    -in "$inbox/$item.json" -sigfile "$inbox/$item.sig" >/dev/null
done
echo 'B31_SIGNED_PROMOTION_DOCUMENTS_INSTALLED'
