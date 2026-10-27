#!/usr/bin/env bash
# Install signed B31 controller from complete B30 without stopping application services.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
incoming=/home/abi/b31-controller-stage
root_dir=/root/geops-b31-controller-install-20261027-v3
api=ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c
web=ghcr.io/kmena/geops-web@sha256:6467721d823c142257205927d2ab6d31d916ac941c15645815db692a2f524ff8
bundle_sha=b510ecb71b6b79cbc46fb1e2f1dd5a2985cf0edc1c04899042dd754f79deba03
signature_sha=324523ddaf8f76febccb350c8d2c33b040a3d8e75e5e540f93a4f5c333e2813f
public_sha=d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27
installer_sha=02c2c2d9fa7f8c3cec1e432d0ef76baac69240d69f9fc2d1eb2b61c34c678e39
verify_file() {
  local path=$1 expected=$2 actual
  [[ -f "$path" && ! -L "$path" ]]
  actual=$(sha256sum "$path" | awk '{print $1}')
  [[ "$actual" == "$expected" ]] || { echo "BLOCKED hash differs: $(basename "$path")" >&2; exit 1; }
}
/usr/local/sbin/geops-b30-staging doctor
/usr/local/sbin/geops-b30-staging verify
status=$(/usr/local/sbin/geops-b30-staging status)
printf '%s' "$status" | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["gate"]=="open" and x["ledger"]=={"count":30,"sha256":"64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6"} and x["journal"]["phase"]=="complete"'
verify_file "$incoming/controller-b31-staging-ready-v3.tar.gz" "$bundle_sha"
verify_file "$incoming/controller-b31-staging-ready-v3.sig" "$signature_sha"
verify_file "$incoming/approved-public.pem" "$public_sha"
verify_file "$incoming/install.py" "$installer_sha"
echo 'B31_INSTALL_INPUTS_VERIFIED'
DOCKER_CONFIG=/etc/geops-deploy-v2/docker docker pull "$api"
DOCKER_CONFIG=/etc/geops-deploy-v2/docker docker pull "$web"
[[ $(docker image inspect "$api" --format '{{.Architecture}}') == amd64 ]]
[[ $(docker image inspect "$web" --format '{{.Architecture}}') == amd64 ]]
[[ $(docker image inspect "$api" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == eba9b3ba3cf1927dcbf032070322fa32dbfe4db3 ]]
[[ $(docker image inspect "$web" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == eba9b3ba3cf1927dcbf032070322fa32dbfe4db3 ]]
[[ $(docker image inspect "$api" --format '{{index .Config.Labels "org.geops.api.variant"}}') == B31-integrated ]]
[[ $(docker image inspect "$web" --format '{{index .Config.Labels "org.geops.web.variant"}}') == B31-integrated ]]
[[ $(docker image inspect "$api" --format '{{index .Config.Labels "org.geops.maintenance.recovery.max_schema"}}') == 31 ]]
[[ $(docker image inspect "$web" --format '{{index .Config.Labels "org.geops.web.mdm_enabled"}}') == true ]]
docker image inspect "$api" --format '{{json .RepoDigests}}' | grep -F "$api" >/dev/null
docker image inspect "$web" --format '{{json .RepoDigests}}' | grep -F "$web" >/dev/null
echo 'B31_IMAGES_CACHED_AND_VERIFIED'
install -d -o root -g root -m 0700 "$root_dir"
install -o root -g root -m 0600 "$incoming/controller-b31-staging-ready-v3.tar.gz" "$root_dir/bundle.tar.gz"
install -o root -g root -m 0600 "$incoming/controller-b31-staging-ready-v3.sig" "$root_dir/bundle.sig"
install -o root -g root -m 0600 "$incoming/approved-public.pem" "$root_dir/public.pem"
install -o root -g root -m 0500 "$incoming/install.py" "$root_dir/install.py"
verify_file "$root_dir/bundle.tar.gz" "$bundle_sha"
verify_file "$root_dir/bundle.sig" "$signature_sha"
verify_file "$root_dir/public.pem" "$public_sha"
verify_file "$root_dir/install.py" "$installer_sha"
/usr/bin/python3 -I "$root_dir/install.py" "$root_dir/bundle.tar.gz" "$root_dir/bundle.sig" "$root_dir/public.pem" "$bundle_sha"
/usr/sbin/visudo -c
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b31-staging status
/usr/local/sbin/geops-b30-staging verify
echo 'B31_CONTROLLER_INSTALLED_B30_UNCHANGED'