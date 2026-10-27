#!/usr/bin/env bash
# Install exact signed B31 release and run read-only prepare; no maintenance.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
id=b31release20261027c7f33dc1a433a57d
incoming=/home/abi/b31-controller-stage
inbox=/var/lib/geops-b31-staging/inbox
document_sha=36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c
signature_sha=d35bdf8fc1412d9a498c47ca99ddca04eff49fc980fdec014cc49cb5d54b3497
verify() {
  local actual
  [[ -f "$1" && ! -L "$1" ]]
  actual=$(sha256sum "$1" | awk '{print $1}')
  [[ "$actual" == "$2" ]] || { echo 'BLOCKED B31 release hash differs' >&2; exit 1; }
}
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b30-staging verify
verify "$incoming/$id.release.json" "$document_sha"
verify "$incoming/$id.release.sig" "$signature_sha"
install -d -o root -g root -m 0700 "$inbox"
for suffix in json sig; do
  source="$incoming/$id.release.$suffix"
  target="$inbox/$id.release.$suffix"
  if [[ -e "$target" ]]; then
    cmp -s "$source" "$target" || { echo 'BLOCKED existing release differs' >&2; exit 1; }
  else
    install -o root -g root -m 0600 "$source" "$target"
  fi
done
verify "$inbox/$id.release.json" "$document_sha"
verify "$inbox/$id.release.sig" "$signature_sha"
/usr/bin/openssl pkeyutl -verify -pubin -inkey /opt/geops-b31-staging/public.pem \
  -rawin -in "$inbox/$id.release.json" -sigfile "$inbox/$id.release.sig" >/dev/null
echo 'B31_RELEASE_SIGNATURE_VERIFIED'
/usr/local/sbin/geops-b31-staging prepare "$id"
echo 'B31_PREPARE_READ_ONLY_PASS'