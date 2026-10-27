#!/usr/bin/env bash
# Verify two Ed25519 signatures and install only the B31 controller nonce repair.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo 'BLOCKED root required' >&2; exit 1; }
umask 077
incoming=/home/abi/b31-controller-repair
root=/root/geops-b31-controller-repair-20261027
install -d -o root -g root -m 0700 "$root"
check() {
  [[ -f "$1" && ! -L "$1" && $(sha256sum "$1" | awk '{print $1}') == "$2" ]] ||
    { echo "BLOCKED repair input differs: $1" >&2; exit 1; }
}
for name in controller-b31-staging-recovery-v4.tar.gz controller-b31-staging-recovery-v4.sig \
            approved-public.pem repair.py b31-repair-installer.sig; do
  check "$incoming/$name" "$(case "$name" in
    controller-b31-staging-recovery-v4.tar.gz) echo 6129476fc396978e1429b36011f98a964ae3702034cfd31391c1bc796b611853 ;;
    controller-b31-staging-recovery-v4.sig) echo 84171a765719e578312ac65c36bb8998b5bb34881af351262f8eafe7b07648dc ;;
    approved-public.pem) echo d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27 ;;
    repair.py) echo e1a5f58c8b984593f3656df30496841c66ecb88c2fe4d92b0e4873cde2f21b43 ;;
    b31-repair-installer.sig) echo 5940ec6b614179ab31fdeda4f1e9297f6db0357e814359ef7871c5069cafd212 ;;
  esac)"
  install -o root -g root -m 0600 "$incoming/$name" "$root/$name"
done
check "$root/controller-b31-staging-recovery-v4.tar.gz" 6129476fc396978e1429b36011f98a964ae3702034cfd31391c1bc796b611853
check "$root/controller-b31-staging-recovery-v4.sig" 84171a765719e578312ac65c36bb8998b5bb34881af351262f8eafe7b07648dc
check "$root/approved-public.pem" d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27
check "$root/repair.py" e1a5f58c8b984593f3656df30496841c66ecb88c2fe4d92b0e4873cde2f21b43
check "$root/b31-repair-installer.sig" 5940ec6b614179ab31fdeda4f1e9297f6db0357e814359ef7871c5069cafd212
printf 'GEOPS-B31-REPAIR-INSTALLER-SHA256\ne1a5f58c8b984593f3656df30496841c66ecb88c2fe4d92b0e4873cde2f21b43\n' > "$root/installer-message"
openssl pkeyutl -verify -pubin -inkey "$root/approved-public.pem" -rawin \
  -in "$root/installer-message" -sigfile "$root/b31-repair-installer.sig" >/dev/null
printf 'GEOPS-B31-STAGING-PACKAGE-SHA256\n6129476fc396978e1429b36011f98a964ae3702034cfd31391c1bc796b611853\n' > "$root/package-message"
openssl pkeyutl -verify -pubin -inkey "$root/approved-public.pem" -rawin \
  -in "$root/package-message" -sigfile "$root/controller-b31-staging-recovery-v4.sig" >/dev/null
echo 'B31_NONCE_REPAIR_SIGNATURES_VERIFIED'
PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/python3 -I "$root/repair.py" \
  "$root/controller-b31-staging-recovery-v4.tar.gz" \
  "$root/controller-b31-staging-recovery-v4.sig" "$root/approved-public.pem"
/usr/local/sbin/geops-b31-staging doctor
/usr/local/sbin/geops-b31-staging status
/usr/local/sbin/geops-b30-staging verify
visudo -c >/dev/null
echo 'B31_NONCE_REPAIR_DIAGNOSTICS_PASS_B30_UNCHANGED'
