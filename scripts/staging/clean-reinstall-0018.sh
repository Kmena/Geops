#!/usr/bin/env bash
# Destructive only after an approved change window on the intended Ubuntu host.
set -Eeuo pipefail
umask 077

usage() {
  echo 'Uso: clean-reinstall-0018.sh check|reset SHA40 /ruta/privada/staging.env [DISCARD_ONLY_GEOPS_SPEC02_STAGING]' >&2
  exit 2
}

[[ $# -ge 3 && $# -le 4 ]] || usage
mode=$1
approved_sha=$2
env_input=$3
[[ $mode == check || $mode == reset ]] || usage
[[ $approved_sha =~ ^[0-9a-f]{40}$ ]] || usage
if [[ $mode == reset ]]; then
  [[ $# -eq 4 && $4 == DISCARD_ONLY_GEOPS_SPEC02_STAGING ]] || usage
else
  [[ $# -eq 3 ]] || usage
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
# A deployment checkout may intentionally be detached; the immutable commit is the authority.
[[ $(git -C "$root" rev-parse HEAD) == "$approved_sha" ]] || { echo 'SHA no aprobado' >&2; exit 1; }
[[ -z $(git -C "$root" status --porcelain) ]] || { echo 'Checkout con cambios locales' >&2; exit 1; }
[[ -f $env_input && ! -L $env_input ]] || { echo 'Env privado inválido' >&2; exit 1; }
env_file=$(realpath -e -- "$env_input")
[[ $(stat -c %u -- "$env_file") == "$(id -u)" ]] || { echo 'Env no pertenece al operador' >&2; exit 1; }
env_mode=$(stat -c %a -- "$env_file")
(( (8#$env_mode & 077) == 0 )) || { echo 'Env debe ser privado' >&2; exit 1; }

# File-backed Compose secrets are bind mounts: uid/gid/mode in secrets: cannot remap them.
# A dedicated group grants read access to both non-root application and database users.
operator=$(id -un)
group_record=$(getent group geops-stage-secrets) || { echo 'Grupo exclusivo de secretos ausente' >&2; exit 1; }
IFS=: read -r group_name _ secret_gid group_members <<< "$group_record"
[[ $group_name == geops-stage-secrets && $secret_gid =~ ^[0-9]+$ ]] || { echo 'Grupo de secretos inválido' >&2; exit 1; }
(( secret_gid >= 2000 && secret_gid <= 60000 )) || { echo 'GID de secretos fuera del rango dedicado' >&2; exit 1; }
[[ -z $group_members || $group_members == "$operator" ]] || { echo 'Grupo de secretos compartido con otra cuenta' >&2; exit 1; }
[[ " $(id -G) " == *" $secret_gid "* ]] || { echo 'Operador no pertenece al grupo de secretos' >&2; exit 1; }
passwd_records=$(getent passwd) || { echo 'No se pudo revisar el grupo primario de las cuentas' >&2; exit 1; }
while IFS=: read -r account _ _ primary_gid _; do
  [[ $primary_gid != "$secret_gid" || $account == "$operator" ]] || { echo 'Grupo de secretos usado por otra cuenta' >&2; exit 1; }
done <<< "$passwd_records"

[[ -z ${DOCKER_HOST:-} || ${DOCKER_HOST:-} == unix:///var/run/docker.sock ]] || { echo 'Docker remoto prohibido' >&2; exit 1; }
[[ -z ${DOCKER_CONTEXT:-} && -z ${BUILDX_BUILDER:-} && -z ${BUILDKIT_HOST:-} ]] || { echo 'Overrides remotos de Docker prohibidos' >&2; exit 1; }
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix://* ]] || { echo 'Se requiere Docker local Unix' >&2; exit 1; }

compose=(docker compose --env-file "$env_file" -f "$root/infrastructure/compose/compose.staging.yaml" --profile maintenance)
"${compose[@]}" config --format json | python3 -I -c '
import json,sys
c=json.load(sys.stdin)
sha=sys.argv[1]
assert c["name"] == "geops-spec02-staging"
assert set(c["services"]) == {"geops-db","geops-migrate","geops-gate-init","geops-api","geops-web","geops-backup"}
assert c["services"]["geops-api"]["image"] == "geops-spec02-api:"+sha
assert c["services"]["geops-web"]["image"] == "geops-spec02-web:"+sha
assert c["services"]["geops-api"]["environment"]["GEOPS_ALLOWED_ORIGINS"] == "https://geops-staging.duckdns.org"
assert c["services"]["geops-api"]["environment"]["MDM_ENABLED"] == "false"
assert c["services"]["geops-web"]["build"]["args"]["MDM_ENABLED"] == "false"
assert set(c["secrets"]) == {"db_password","admin_session_key","admin_csrf_key","invitation_hmac_key","mdm_grant_key","gps_quarantine_key"}
assert "stage_egress" not in c["networks"]
for service in c["services"].values():
  assert not any(k.startswith("GEOPS_MDM_") or k.startswith("MDM_CLIENT_") for k in service.get("environment",{}))
for service in ("geops-db","geops-migrate","geops-gate-init","geops-api","geops-backup"):
  assert c["services"][service]["group_add"] == [sys.argv[2]]
assert not c["services"]["geops-web"].get("group_add")
assert all(not s.get("ports") for s in c["services"].values())
assert all(not s.get("network_mode") for s in c["services"].values())
assert set(c["services"]["geops-db"]["networks"]) == {"stage_db"}
assert set(c["services"]["geops-api"]["networks"]) == {"stage_app","stage_db"}
assert set(c["services"]["geops-web"]["networks"]) == {"stage_app","stage_edge"}
assert all(
  v["type"] == "volume" and v["source"] in {"stage_pgdata","stage_security","stage_backups"}
  for s in c["services"].values() for v in s.get("volumes",[])
)
assert c["networks"]["stage_edge"]["name"] == "geops_spec02_stage_edge"
assert c["networks"]["stage_edge"]["external"] is True
assert c["networks"]["stage_db"]["internal"] is True
assert c["networks"]["stage_app"]["internal"] is True
assert c["volumes"]["stage_pgdata"]["name"] == "geops_spec02_stage_pgdata"
assert c["volumes"]["stage_security"]["name"] == "geops_spec02_stage_security"
assert c["volumes"]["stage_backups"]["name"] == "geops_spec02_stage_backups"
' "$approved_sha" "$secret_gid"
docker network inspect geops_spec02_stage_edge >/dev/null

# The published catalog is immutable for this reinstall. A21 remains the default;
# B22-safe requires an explicit profile and the reviewed A21 prefix plus 0022.
migration_files=("$root"/apps/api/src/db/migrations/*.sql)
catalog_profile=${GEOPS_CATALOG_PROFILE:-A21}
case $catalog_profile in
  A21) expected_count=21; expected_hash=cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e ;;
  B22-safe) expected_count=22; expected_hash=aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2 ;;
  *) echo 'Perfil de catálogo no permitido' >&2; exit 1 ;;
esac
[[ ${#migration_files[@]} -eq $expected_count ]] || { echo 'Cantidad de migraciones incompatible con el perfil' >&2; exit 1; }
for index in "${!migration_files[@]}"; do
  printf -v prefix '%04d_' "$((index + 1))"
  [[ $(basename -- "${migration_files[$index]}") == "$prefix"* ]] || { echo 'Catálogo de migraciones fuera de orden' >&2; exit 1; }
done
expected_migrations=$(for file in "${migration_files[@]}"; do
  printf '%s|%s\n' "$(basename -- "$file")" "$(sha256sum -- "$file" | cut -d' ' -f1)"
done)
catalog_hash=$(printf '%s' "$expected_migrations" | sha256sum | cut -d' ' -f1)
[[ $catalog_hash == "$expected_hash" ]] || { echo 'Hash del catálogo no coincide con el perfil revisado' >&2; exit 1; }
if [[ $catalog_profile == B22-safe ]]; then
  a21_migrations=$(for file in "${migration_files[@]:0:21}"; do
    printf '%s|%s\n' "$(basename -- "$file")" "$(sha256sum -- "$file" | cut -d' ' -f1)"
  done)
  a21_hash=$(printf '%s' "$a21_migrations" | sha256sum | cut -d' ' -f1)
  [[ $a21_hash == cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e ]] || { echo 'Prefijo A21 alterado' >&2; exit 1; }
fi

for pair in 'stage_db geops_spec02_stage_db' 'stage_app geops_spec02_stage_app'; do
  read -r key network <<< "$pair"
  docker network inspect "$network" | python3 -I -c '
import json,sys
n=json.load(sys.stdin)[0]
assert n["Name"] == sys.argv[1] and n["Internal"] is True
assert n["Labels"].get("com.docker.compose.project") == "geops-spec02-staging"
assert n["Labels"].get("com.docker.compose.network") == sys.argv[2]
assert all(c["Name"].startswith("geops-spec02-staging-") for c in n.get("Containers",{}).values())
' "$network" "$key" || { echo 'Red interna compartida o ajena' >&2; exit 1; }
done

secret_dir="$root/infrastructure/compose/.local/staging/secrets"
for dir in "$root/infrastructure/compose/.local" "$root/infrastructure/compose/.local/staging" "$secret_dir"; do
  [[ -d $dir && ! -L $dir && $(stat -c %u -- "$dir") == "$(id -u)" ]] || { echo 'Directorio de secretos inválido' >&2; exit 1; }
  dir_mode=$(stat -c %a -- "$dir")
  (( (8#$dir_mode & 077) == 0 )) || { echo 'Directorio de secretos no es privado' >&2; exit 1; }
done
secret_names=(db_password admin_session_key admin_csrf_key invitation_hmac_key mdm_grant_key gps_quarantine_key)
for name in "${secret_names[@]}"; do
  path="$secret_dir/$name"
  [[ -f $path && ! -L $path && $(stat -c %u -- "$path") == "$(id -u)" ]] || { echo 'Secreto Staging inválido' >&2; exit 1; }
  secret_mode=$(stat -c %a -- "$path")
  secret_file_gid=$(stat -c %g -- "$path")
  [[ $secret_mode == 600 || ( $secret_mode == 640 && $secret_file_gid == "$secret_gid" ) ]] || { echo 'Secreto Staging no es privado' >&2; exit 1; }
done

probe_tmp=
secret_tmp=
cleanup_tmp() {
  [[ -z $probe_tmp ]] || rm -f -- "$probe_tmp"
  [[ -z $secret_tmp ]] || rm -f -- "$secret_tmp"
}
trap cleanup_tmp EXIT
probe_read() {
  local uid=$1 source=$2
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user "$uid:$uid" --group-add "$secret_gid" \
    --mount "type=bind,src=$source,dst=/run/secrets/probe,readonly" \
    --entrypoint /bin/sh postgis/postgis:18-3.6 -ec 'cat /run/secrets/probe >/dev/null'
}
# Verify the same host directory, owner, mode and bind-mount mechanism before stopping anything.
probe_tmp=$(mktemp "$secret_dir/.access-probe.XXXXXXXX")
printf 'synthetic-permission-probe\n' > "$probe_tmp"
chgrp "$secret_gid" "$probe_tmp"
chmod 640 "$probe_tmp"
probe_read 1000 "$probe_tmp"
probe_read 999 "$probe_tmp"
rm -f -- "$probe_tmp"
probe_tmp=

services=(geops-web geops-api geops-backup geops-migrate geops-gate-init geops-db)
project_services=$(docker ps -a --filter label=com.docker.compose.project=geops-spec02-staging --format '{{.Label "com.docker.compose.service"}}')
while IFS= read -r service; do
  [[ -z $service ]] && continue
  allowed=no
  for expected in "${services[@]}"; do [[ $service == "$expected" ]] && allowed=yes; done
  [[ $allowed == yes ]] || { echo 'Servicio inesperado en proyecto Staging' >&2; exit 1; }
done <<< "$project_services"

# An earlier GEOPS API image may predate MDM_ENABLED. It is removed by reset;
# only the new Compose API/Web config above must declare false explicitly.
api_ids=$(docker ps -a --filter label=com.docker.compose.project=geops-spec02-staging --filter label=com.docker.compose.service=geops-api --format '{{.ID}}')
while IFS= read -r api_id; do
  [[ -z $api_id ]] && continue
  docker inspect "$api_id" | python3 -I -c '
import json,re,sys
container=json.load(sys.stdin)[0]
assert container["Id"].startswith(sys.argv[1])
labels=container["Config"].get("Labels") or {}
assert labels.get("com.docker.compose.project") == "geops-spec02-staging"
assert labels.get("com.docker.compose.service") == "geops-api"
assert re.fullmatch(r"geops-spec02-api:[0-9a-f]{7,40}",container["Config"]["Image"])
env=[item.split("=",1) for item in container["Config"]["Env"]]
mdm=[value for key,value in env if key == "MDM_ENABLED"]
assert len(mdm) <= 1 and (not mdm or mdm == ["false"])
assert not any(key.startswith(("GEOPS_MDM_","MDM_CLIENT_","MDM_REFRESH_","MDM_ACCESS_","MANAGEENGINE_","ZOHO_")) for key,_ in env)
' "$api_id" || { echo 'Configuración MDM activa en API existente' >&2; exit 1; }
done <<< "$api_ids"

volumes=(geops_spec02_stage_pgdata geops_spec02_stage_security)
volume_keys=(stage_pgdata stage_security)
for index in 0 1; do
  volume=${volumes[$index]}
  label=$(docker volume inspect "$volume" --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}')
  [[ $label == "geops-spec02-staging|${volume_keys[$index]}" ]] || { echo 'Volumen no pertenece inequívocamente a GEOPS Staging' >&2; exit 1; }
  mounts=$(docker ps -a --filter "volume=$volume" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}')
  while IFS='|' read -r container_id owner; do
    [[ -z $container_id ]] && continue
    [[ $owner == geops-spec02-staging ]] || { echo 'Volumen montado por otro proyecto' >&2; exit 1; }
  done <<< "$mounts"
done

# The existing backup is evidence and must survive reset, including its Docker volume.
backup_label=$(docker volume inspect geops_spec02_stage_backups --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}')
[[ $backup_label == 'geops-spec02-staging|stage_backups' ]] || { echo 'Volumen de respaldos ajeno o ausente' >&2; exit 1; }
backup_mounts=$(docker ps -a --filter volume=geops_spec02_stage_backups --format '{{.ID}}|{{.Label "com.docker.compose.project"}}')
while IFS='|' read -r container_id owner; do
  [[ -z $container_id ]] && continue
  [[ $owner == geops-spec02-staging ]] || { echo 'Respaldo montado por otro proyecto' >&2; exit 1; }
done <<< "$backup_mounts"
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --mount type=volume,src=geops_spec02_stage_backups,dst=/geops-backups,readonly \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -ec '
    set -- /geops-backups/geops-stage-*.dump
    [ -f "$1" ] || exit 1
    valid=0
    for dump do
      [ -f "$dump.sha256" ] || continue
      (cd /geops-backups && sha256sum -c "$(basename "$dump").sha256" >/dev/null) || continue
      pg_restore -l "$dump" >/dev/null || continue
      valid=1
    done
    [ "$valid" -eq 1 ]
  ' || { echo 'No existe respaldo Staging verificable' >&2; exit 1; }

if [[ $mode == check ]]; then
  printf 'Preflight PASS: SHA=%s proyecto=geops-spec02-staging\n' "$approved_sha"
  printf 'Servicios exclusivos: %s\n' "${services[*]}"
  printf 'Volúmenes a descartar: %s\n' "${volumes[*]}"
  echo 'Sin modificaciones persistentes de Docker; lectura verificada en contenedores temporales sin red.'
  exit 0
fi

# No down -v, prune, borrado de redes, ni operaciones sobre Caddy/otros proyectos.
"${compose[@]}" stop "${services[@]}"
"${compose[@]}" rm --force "${services[@]}"
for volume in "${volumes[@]}"; do
  remaining=$(docker ps -a --filter "volume=$volume" --format '{{.ID}}')
  [[ -z $remaining ]] || { echo 'Volumen aún montado; detención segura' >&2; exit 1; }
  label=$(docker volume inspect "$volume" --format '{{ index .Labels "com.docker.compose.project" }}')
  [[ $label == geops-spec02-staging ]] || { echo 'Identidad del volumen cambió' >&2; exit 1; }
  docker volume rm "$volume"
done

# Reemplazar solo los seis secretos exclusivos de Staging, sin mostrarlos.
for name in "${secret_names[@]}"; do
  secret_tmp=$(mktemp "$secret_dir/.${name}.XXXXXXXX")
  if [[ $name == db_password ]]; then
    openssl rand -hex 32 > "$secret_tmp"
    [[ $(wc -c < "$secret_tmp") -eq 65 ]] || exit 1
  else
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$secret_tmp"
    [[ $(wc -c < "$secret_tmp") -eq 43 ]] || exit 1
  fi
  chgrp "$secret_gid" "$secret_tmp"
  chmod 640 "$secret_tmp"
  mv -T -- "$secret_tmp" "$secret_dir/$name"
  secret_tmp=
  probe_read 1000 "$secret_dir/$name"
  if [[ $name == db_password ]]; then probe_read 999 "$secret_dir/$name"; fi
done

"${compose[@]}" build geops-api geops-web
"${compose[@]}" up -d --wait geops-db
"${compose[@]}" run --rm --no-deps geops-migrate
actual_migrations=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -F '|' -Atc 'SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
[[ $actual_migrations == "$expected_migrations" ]] || { echo 'Ledger o checksums no coinciden con el catálogo revisado' >&2; exit 1; }
structure=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc "SELECT (PostGIS_Version() IS NOT NULL AND to_regclass('gps_continuity_alert') IS NOT NULL AND to_regclass('gps_continuity_alert_page') IS NOT NULL AND to_regclass('mdm_inventory_device') IS NOT NULL AND to_regclass('mdm_sync_run') IS NOT NULL)")
[[ $structure == t ]] || { echo 'Estructura 0016–0018 incompleta' >&2; exit 1; }
if [[ $catalog_profile == B22-safe ]]; then
  oauth_table=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc "SELECT to_regclass('mdm_oauth_pending') IS NOT NULL")
  [[ $oauth_table == t ]] || { echo 'Estructura 0022 incompleta' >&2; exit 1; }
fi
identities=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc 'SELECT (SELECT count(*) FROM admin_user)+(SELECT count(*) FROM geops_device)+(SELECT count(*) FROM security_epoch)')
[[ $identities == 0 ]] || { echo 'Base no está vacía; gate no inicializado' >&2; exit 1; }
"${compose[@]}" run --rm --no-deps geops-gate-init
db_epoch=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc 'SELECT epoch FROM security_epoch WHERE singleton=true')
gate_json=$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 \
  --mount type=volume,src=geops_spec02_stage_security,dst=/geops-security,readonly \
  --entrypoint /bin/sh postgis/postgis:18-3.6 -ec 'cat /geops-security/security-gate.json')
printf '%s\n%s\n' "$db_epoch" "$gate_json" | python3 -I -c '
import json,sys,uuid
epoch=sys.stdin.readline().strip()
gate=json.loads(sys.stdin.readline())
assert str(uuid.UUID(epoch)) == epoch
assert gate == {"version":1,"phase":"open","epoch":epoch}
' || { echo 'Gate nuevo no coincide con epoch de DB' >&2; exit 1; }
[[ -z $("${compose[@]}" ps --status running --services geops-api geops-web) ]] || { echo 'API/Web se iniciaron inesperadamente' >&2; exit 1; }
printf 'Base limpia con %s migraciones (%s), checksums verificados y gate nuevo. API/Web detenidas; continuar con bootstrap interactivo del runbook.\n' "$expected_count" "$catalog_profile"
