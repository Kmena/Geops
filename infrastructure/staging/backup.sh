#!/bin/sh
set -eu
umask 077
export PGPASSWORD=$(cat /run/secrets/db_password)
[ -n "$PGPASSWORD" ] || exit 1
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/geops-backups/geops-stage-${stamp}.dump"
pg_dump -h geops-db -U geops_stage -d geops_dev -Fc -f "$target"
sha256sum "$target" > "$target.sha256"
printf 'GEOPS staging backup and SHA-256 created: %s\n' "$stamp"
