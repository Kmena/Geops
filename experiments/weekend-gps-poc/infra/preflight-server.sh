#!/usr/bin/env bash
# Read-only inventory. Run manually on the authorized Ubuntu host; no deployment.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'BLOCKED: Linux host required\n' >&2
  exit 1
fi
for tool in docker ss df free nproc; do
  command -v "$tool" >/dev/null || { printf 'BLOCKED: missing inventory tool\n' >&2; exit 1; }
done

printf 'User: %s\n' "$(id -un)"
printf 'OS: '
. /etc/os-release
printf '%s\n' "$PRETTY_NAME"
printf 'Reserved directory: '
if [[ -d /opt/geops-poc ]]; then printf 'exists\n'; else printf 'absent; no files created\n'; fi
printf 'Docker: '
docker --version
printf 'Compose: '
docker compose version
printf 'CPU cores: %s\n' "$(nproc)"
free -h
df -h /opt
printf '\nListening TCP sockets (recheck 80/443 and project ports):\n'
ss -H -ltn
printf '\nContainers (names, ports, status only):\n'
docker ps --format '{{.Names}} {{.Ports}} {{.Status}}'
printf '\nNetworks (names only):\n'
docker network ls --format '{{.Name}}'
printf '\nVolumes (names only):\n'
docker volume ls --format '{{.Name}}'
printf '\nRead-only inventory complete. No service was changed.\n'
