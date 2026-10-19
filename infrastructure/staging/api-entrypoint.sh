#!/bin/sh
set -eu

read_secret() {
  value=$(cat "/run/secrets/$1")
  [ -n "$value" ] || exit 1
  printf '%s' "$value"
}

db_password=$(read_secret db_password)
case "$db_password" in
  *[!A-Za-z0-9_-]*) exit 1 ;;
esac
[ "${#db_password}" -ge 32 ] || exit 1

export DATABASE_URL="postgresql://geops_stage:${db_password}@geops-db:5432/geops_dev"
export GEOPS_ADMIN_SESSION_KEY=$(read_secret admin_session_key)
export GEOPS_ADMIN_CSRF_KEY=$(read_secret admin_csrf_key)
export GEOPS_INVITATION_HMAC_KEY=$(read_secret invitation_hmac_key)
export GEOPS_MDM_GRANT_KEY=$(read_secret mdm_grant_key)
export GEOPS_GPS_QUARANTINE_KEY=$(read_secret gps_quarantine_key)

case "${1:-}" in
  server) exec node apps/api/dist/main.js ;;
  migrate) exec node apps/api/dist/db/migrate.js ;;
  gate)
    [ "${2:-}" = init ] || exit 1
    exec node apps/api/dist/db/security-gate-cli.js init
    ;;
  bootstrap)
    [ -n "${2:-}" ] || exit 1
    exec node apps/api/dist/admin-auth/bootstrap.js "$2"
    ;;
  *) exit 1 ;;
esac
