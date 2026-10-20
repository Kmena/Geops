#!/usr/bin/env bash
# Destructive only after an approved change window. Never run from Codex.
set -Eeuo pipefail
umask 077

usage() {
  echo 'Uso: clean-reinstall-0015.sh check|reset SHA40 /ruta/privada/staging.env [DISCARD_ONLY_GEOPS_SPEC02_STAGING]' >&2
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
[[ $(git -C "$root" branch --show-current) == codex/spec-02-wave-1 ]] || { echo 'Rama incorrecta' >&2; exit 1; }
[[ $(git -C "$root" rev-parse HEAD) == "$approved_sha" ]] || { echo 'SHA no aprobado' >&2; exit 1; }
[[ -z $(git -C "$root" status --porcelain) ]] || { echo 'Checkout con cambios locales' >&2; exit 1; }
[[ -f $env_input && ! -L $env_input ]] || { echo 'Env privado inválido' >&2; exit 1; }
env_file=$(realpath -e -- "$env_input")
[[ $(stat -c %u -- "$env_file") == "$(id -u)" ]] || { echo 'Env no pertenece al operador' >&2; exit 1; }
env_mode=$(stat -c %a -- "$env_file")
(( (8#$env_mode & 077) == 0 )) || { echo 'Env debe ser privado' >&2; exit 1; }
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
assert c["volumes"]["stage_pgdata"]["name"] == "geops_spec02_stage_pgdata"
assert c["volumes"]["stage_security"]["name"] == "geops_spec02_stage_security"
assert c["volumes"]["stage_backups"]["name"] == "geops_spec02_stage_backups"
' "$approved_sha"
docker network inspect geops_spec02_stage_edge >/dev/null

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
  (( (8#$secret_mode & 077) == 0 )) || { echo 'Secreto Staging no es privado' >&2; exit 1; }
done

services=(geops-web geops-api geops-backup geops-migrate geops-gate-init geops-db)
project_services=$(docker ps -a --filter label=com.docker.compose.project=geops-spec02-staging --format '{{.Label "com.docker.compose.service"}}')
while IFS= read -r service; do
  [[ -z $service ]] && continue
  allowed=no
  for expected in "${services[@]}"; do [[ $service == "$expected" ]] && allowed=yes; done
  [[ $allowed == yes ]] || { echo 'Servicio inesperado en proyecto Staging' >&2; exit 1; }
done <<< "$project_services"

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

if [[ $mode == check ]]; then
  printf 'Preflight PASS: SHA=%s proyecto=geops-spec02-staging\n' "$approved_sha"
  printf 'Servicios exclusivos: %s\n' "${services[*]}"
  printf 'Volúmenes a descartar: %s\n' "${volumes[*]}"
  echo 'Sin modificaciones de Docker.'
  exit 0
fi

# No down -v, prune, borrado de redes, ni operaciones sobre Caddy/otros proyectos.
"${compose[@]}" stop "${services[@]}"
"${compose[@]}" rm --force "${services[@]}"
for volume in "${volumes[@]}"; do
  remaining=$(docker ps -a --filter "volume=$volume" --format '{{.ID}}')
  [[ -z $remaining ]] || { echo 'Volumen aún montado; detención segura' >&2; exit 1; }
  docker volume rm "$volume"
done

# Reemplazar solo los seis secretos exclusivos de Staging, sin mostrarlos.
secret_tmp=
cleanup_secret_tmp() { [[ -z $secret_tmp ]] || rm -f -- "$secret_tmp"; }
trap cleanup_secret_tmp EXIT
for name in "${secret_names[@]}"; do
  secret_tmp=$(mktemp "$secret_dir/.${name}.XXXXXXXX")
  if [[ $name == db_password ]]; then
    openssl rand -hex 32 > "$secret_tmp"
    [[ $(wc -c < "$secret_tmp") -eq 65 ]] || exit 1
  else
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$secret_tmp"
    [[ $(wc -c < "$secret_tmp") -eq 43 ]] || exit 1
  fi
  chmod 600 "$secret_tmp"
  mv -T -- "$secret_tmp" "$secret_dir/$name"
  secret_tmp=
done

"${compose[@]}" build geops-api geops-web
"${compose[@]}" up -d --wait geops-db
"${compose[@]}" run --rm --no-deps geops-migrate
migrations=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc 'SELECT count(*) FROM geops_schema_migrations')
[[ $migrations == 15 ]] || { echo 'Migraciones incompletas; API/Web permanecen detenidas' >&2; exit 1; }
identities=$("${compose[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc 'SELECT (SELECT count(*) FROM admin_user)+(SELECT count(*) FROM geops_device)+(SELECT count(*) FROM security_epoch)')
[[ $identities == 0 ]] || { echo 'Base no está vacía; gate no inicializado' >&2; exit 1; }
"${compose[@]}" run --rm --no-deps geops-gate-init
echo 'Base limpia con 15 migraciones y gate nuevo. API/Web detenidas; continuar con bootstrap interactivo del runbook.'
