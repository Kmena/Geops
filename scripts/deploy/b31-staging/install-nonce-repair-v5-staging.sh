#!/usr/bin/env bash
# Verify two Ed25519 signatures and install only the B31 controller nonce repair.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
umask 077
incoming=/home/abi/b31-controller-repair-v5
root=/root/geops-b31-controller-repair-v5-20261027
install -d -o root -g root -m 0700 "$root"
check() {
  [[ -f "$1" && ! -L "$1" && $(sha256sum "$1" | awk '{print $1}') == "$2" ]] ||
    { echo "BLOCKED repair input differs: $1" >&2; exit 1; }
}
for name in controller-b31-staging-recovery-v5.tar.gz controller-b31-staging-recovery-v5.sig \
            approved-public.pem repair-v5.py b31-repair-installer-v5.sig; do
  check "$incoming/$name" "$(case "$name" in
    controller-b31-staging-recovery-v5.tar.gz) echo a062af6ca121471b307ae9272eea2f715b3d4891f5db6f7a71ae8fdca167af7d ;;
    controller-b31-staging-recovery-v5.sig) echo 9368b6c9e0900679f4c1f84e5bcf5eefe2f301ad5cb9d05380c342a1e641fada ;;
    approved-public.pem) echo d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27 ;;
    repair-v5.py) echo 003ea80faea0fbe37acf3a2b197cdbffa63662f141c1a683403c8fb736be5a83 ;;
    b31-repair-installer-v5.sig) echo 9285c0cd771d4fbd3a8aeb5d912490d2ccb1ad37ebc01be092ec22012651d6a0 ;;
  esac)"
  install -o root -g root -m 0600 "$incoming/$name" "$root/$name"
done
check "$root/controller-b31-staging-recovery-v5.tar.gz" a062af6ca121471b307ae9272eea2f715b3d4891f5db6f7a71ae8fdca167af7d
check "$root/controller-b31-staging-recovery-v5.sig" 9368b6c9e0900679f4c1f84e5bcf5eefe2f301ad5cb9d05380c342a1e641fada
check "$root/approved-public.pem" d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27
check "$root/repair-v5.py" 003ea80faea0fbe37acf3a2b197cdbffa63662f141c1a683403c8fb736be5a83
check "$root/b31-repair-installer-v5.sig" 9285c0cd771d4fbd3a8aeb5d912490d2ccb1ad37ebc01be092ec22012651d6a0
printf 'GEOPS-B31-REPAIR-INSTALLER-SHA256\n003ea80faea0fbe37acf3a2b197cdbffa63662f141c1a683403c8fb736be5a83\n' > "$root/installer-message"
openssl pkeyutl -verify -pubin -inkey "$root/approved-public.pem" -rawin \
  -in "$root/installer-message" -sigfile "$root/b31-repair-installer-v5.sig" >/dev/null
printf 'GEOPS-B31-STAGING-PACKAGE-SHA256\na062af6ca121471b307ae9272eea2f715b3d4891f5db6f7a71ae8fdca167af7d\n' > "$root/package-message"
openssl pkeyutl -verify -pubin -inkey "$root/approved-public.pem" -rawin \
  -in "$root/package-message" -sigfile "$root/controller-b31-staging-recovery-v5.sig" >/dev/null
echo 'B31_NONCE_REPAIR_SIGNATURES_VERIFIED'
PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/python3 -I "$root/repair-v5.py" \
  "$root/controller-b31-staging-recovery-v5.tar.gz" \
  "$root/controller-b31-staging-recovery-v5.sig" "$root/approved-public.pem"
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b31-staging status
/usr/local/sbin/geops-b30-staging verify
visudo -c >/dev/null
echo 'B31_NONCE_REPAIR_DIAGNOSTICS_PASS_B30_UNCHANGED'
