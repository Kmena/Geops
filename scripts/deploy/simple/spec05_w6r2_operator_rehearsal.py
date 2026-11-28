#!/usr/bin/env python3
"""SPEC-05 W6-R2: privileged, isolated staging backup/restore rehearsal.

Run only after operator review with sudo on geops-staging. Never calls deploy,
rollback, docker compose down, prune, or a ManageEngine endpoint.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import uuid

PROJECT = "geops-spec02-staging"
SOURCE_SHA = "809bb0678feaefdbbe8006a1ba05325ccb1ad0a8"
CURRENT_SHA = "b597c9f52f3f53da5e9d9be0fce43351f9eb4561"
API_REF = "ghcr.io/kmena/geops-api@sha256:e137e65016dc2c7b8d9130a6d81dae5d9510d422bd3b1e1e955405cefa8662b5"
WEB_REF = "ghcr.io/kmena/geops-web@sha256:583058e25cd33cc1ca58e750c7837210580ed1a482c6321a44c62b43c846133f"
CURRENT_API = "ghcr.io/kmena/geops-api@sha256:dbf7ec20aa4900a4bdf8487684dda7aeac0c95c99aaa1968770deeffe8f5125f"
CURRENT_WEB = "ghcr.io/kmena/geops-web@sha256:9098f2162c06ebf9d9eedf4d5a5eb9037a4c62129c21322f437230ea592b90a0"
PREFIX_SHA = "40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf"
TARGET_SHA = "1589cb3bf483e171b4e50aa0e33c06f71e504564b4a6e402eda4ecb4e5ac21a8"
SQL_0041 = "078a74a6151b4aaca2dd937206636a7a230d0b89d22bb1520df00c7e8dcb0b22"
SQL_0042 = "d97a207432645007f97aefd2e57811bd2a418229b68d4da6745fe14c64581c1a"
COMPOSE = Path("/opt/geops-simple/bundle/infrastructure/compose/compose.staging.yaml")
BACKUP_SCRIPT = Path("/opt/geops-simple/bundle/infrastructure/staging/backup.sh")
CONTROLLER = Path("/opt/geops-simple/staging.py")
WRAPPER = Path("/usr/local/sbin/geops-staging-simple")
BACKUP_VOLUME = "geops_spec02_stage_backups"
BACKUP_SCRIPT_SHA = "b6784af0ac4c6180e65b981a963b33ea79d2f4902ace966c2c23e99b02f6ef6f"
REPORT_DIR = Path("/var/lib/geops-spec05-w6r2-evidence")
BACKUP_RE = re.compile(r"geops-stage-[0-9]{8}T[0-9]{6}Z\.dump\Z")
SQL_RE = re.compile(r"[0-9]+_[a-z0-9_]+\.sql\Z")
GIB = 1024**3
MIN_INITIAL_DISK = 7 * GIB
MIN_AFTER_PULL = 6 * GIB
MIN_AFTER_BACKUP = 4 * GIB
MIN_MEMORY = 3 * GIB
MAX_DB_SIZE = 1 * GIB
MAX_DUMP_SIZE = 2 * GIB


class GateError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def list_hash(rows: list[dict[str, str]]) -> str:
    value = "\n".join(f"{row['version']}|{row['checksum']}" for row in rows)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def command(args: list[str], code: str, timeout: int = 120) -> str:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GateError(code) from error
    if result.returncode != 0:
        # Command output may contain private paths or database content.
        raise GateError(code)
    return result.stdout.strip()


def docker(args: list[str], code: str, timeout: int = 120) -> str:
    return command(["docker", *args], code, timeout)


def sql(container: str, database: str, query: str, code: str) -> object:
    if database == "geops_dev":
        # The existing Compose secret stays inside the existing DB container.
        args = [
            "exec", container, "sh", "-c",
            'PGPASSWORD=$(cat /run/secrets/db_password); export PGPASSWORD; exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U geops_stage -d geops_dev -c "$1"',
            "sh", query,
        ]
    else:
        args = [
            "exec", container, "psql", "-X", "-q", "-A", "-t",
            "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-c", query,
        ]
    output = docker(
        args,
        code,
        timeout=120,
    )
    try:
        return json.loads(output)
    except (ValueError, TypeError) as error:
        raise GateError(code) from error


LEDGER_SQL = (
    "SELECT coalesce(json_agg(json_build_object("
    "'version',version,'checksum',checksum,'applied_at',applied_at)"
    " ORDER BY version),'[]'::json) FROM geops_schema_migrations"
)
DB_INFO_SQL = (
    "SELECT row_to_json(x) FROM (SELECT current_database() AS database,"
    "current_setting('server_version') AS postgres,"
    "split_part(PostGIS_Version(),' ',1) AS postgis,"
    "pg_database_size(current_database()) AS bytes) x"
)
COUNTS_SQL = (
    "SELECT json_build_object("
    "'devices',(SELECT count(*) FROM geops_device),"
    "'installations',(SELECT count(*) FROM gps_device_installation),"
    "'positions',(SELECT count(*) FROM position_event),"
    "'mdm_integrations',(SELECT count(*) FROM mdm_integration),"
    "'mdm_bindings',(SELECT count(*) FROM mdm_binding),"
    "'agents',(SELECT count(*) FROM agent),"
    "'clients',(SELECT count(*) FROM client),"
    "'client_sites',(SELECT count(*) FROM client_site),"
    "'geofences',(SELECT count(*) FROM client_geofence_revision),"
    "'routes',(SELECT count(*) FROM route_template),"
    "'route_revisions',(SELECT count(*) FROM route_revision))"
)
IDENTITY_SQL = (
    "SELECT json_build_object("
    "'devices',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id::text),'')) FROM geops_device),"
    "'installations',(SELECT md5(coalesce(string_agg(installation_id::text,',' ORDER BY installation_id::text),'')) FROM gps_device_installation),"
    "'bindings',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id::text),'')) FROM mdm_binding),"
    "'agents',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id::text),'')) FROM agent),"
    "'clients',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id::text),'')) FROM client))"
)
CONFIG_SQL = (
    "SELECT json_build_object("
    "'mdm',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) FROM mdm_integration t),"
    "'gps_policies',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) FROM gps_policy_revision t),"
    "'assignments',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) FROM gps_effective_assignment t),"
    "'geofences',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) FROM client_geofence_revision t),"
    "'routes',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) FROM route_revision t))"
)
OBJECTS_SQL = (
    "SELECT json_build_object("
    "'diagnostics',to_regclass('public.device_diagnostic_snapshot') IS NOT NULL,"
    "'requests',to_regclass('public.mdm_remediation_request') IS NOT NULL,"
    "'events',to_regclass('public.mdm_remediation_event') IS NOT NULL,"
    "'diagnostic_indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='device_diagnostic_snapshot'),"
    "'request_indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='mdm_remediation_request'),"
    "'event_indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='mdm_remediation_event'),"
    "'invalid_constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated),"
    "'immutable_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname IN ('device_diagnostic_no_change','mdm_remediation_event_no_change') AND NOT tgisinternal))"
)


def mem_available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise GateError("MEMORY_UNKNOWN")


def disk_available() -> int:
    root = Path(
        docker(["info", "--format", "{{.DockerRootDir}}"], "DOCKER_ROOT_UNREADABLE")
    )
    if not root.is_absolute() or not root.is_dir():
        raise GateError("DOCKER_ROOT_UNSAFE")
    return min(shutil.disk_usage(root).free, shutil.disk_usage("/var/lib").free)


def require_resources(min_disk: int, code: str) -> dict[str, int]:
    disk = disk_available()
    memory = mem_available()
    if disk < min_disk or memory < MIN_MEMORY:
        raise GateError(code)
    return {"disk_free_bytes": disk, "memory_available_bytes": memory}


def containers_by_service() -> dict[str, dict]:
    ids = docker(
        ["ps", "-q", "--filter", f"label=com.docker.compose.project={PROJECT}"],
        "COMPOSE_CONTAINERS_UNREADABLE",
    ).splitlines()
    found: dict[str, dict] = {}
    for container_id in ids:
        item = json.loads(docker(["inspect", container_id], "CONTAINER_INSPECT_FAILED"))[0]
        service = item["Config"]["Labels"].get("com.docker.compose.service")
        if service in {"geops-api", "geops-web", "geops-db"}:
            if service in found:
                raise GateError("DUPLICATE_STAGING_SERVICE")
            found[service] = item
    if set(found) != {"geops-api", "geops-web", "geops-db"}:
        raise GateError("STAGING_SERVICE_SET_CHANGED")
    for item in found.values():
        if (
            item["State"]["Status"] != "running"
            or item["State"].get("Health", {}).get("Status") != "healthy"
        ):
            raise GateError("STAGING_SERVICE_UNHEALTHY")
    return found


def image_info(image_id: str) -> dict:
    return json.loads(docker(["image", "inspect", image_id], "IMAGE_INSPECT_FAILED"))[0]


def active_inventory(found: dict[str, dict]) -> dict:
    expected = {"geops-api": CURRENT_API, "geops-web": CURRENT_WEB}
    inventory: dict[str, dict] = {}
    for service, item in found.items():
        image = image_info(item["Image"])
        refs = image.get("RepoDigests") or []
        if service in expected and expected[service] not in refs and item["Config"]["Image"] != expected[service]:
            raise GateError("ACTIVE_IMAGE_DIGEST_CHANGED")
        labels = image.get("Config", {}).get("Labels") or {}
        revision = labels.get("org.opencontainers.image.revision")
        if service in expected and revision != CURRENT_SHA:
            raise GateError("ACTIVE_OCI_REVISION_MISMATCH")
        inventory[service] = {
            "image_ref": expected.get(service, item["Config"]["Image"]),
            "image_id": image["Id"],
            "revision_label": revision,
            "variant_label": labels.get(
                "org.geops.api.variant" if service == "geops-api" else "org.geops.web.variant"
            ),
            "health": item["State"]["Health"]["Status"],
            "network_mode": item["HostConfig"]["NetworkMode"],
            "mount_targets": sorted(m["Destination"] for m in item.get("Mounts", [])),
            "named_volumes": sorted(
                m["Name"] for m in item.get("Mounts", [])
                if m.get("Type") == "volume" and m.get("Name")
            ),
        }
    return inventory


def candidate_catalog() -> list[dict[str, str]]:
    js = (
        "const f=require('fs'),c=require('crypto'),p='/work/apps/api/dist/db/migrations/';"
        "const a=f.readdirSync(p).filter(x=>/^\\d+_[a-z0-9_]+\\.sql$/.test(x)).sort()"
        ".map(version=>({version,checksum:c.createHash('sha256').update(f.readFileSync(p+version)).digest('hex')}));"
        "process.stdout.write(JSON.stringify(a))"
    )
    output = docker(
        ["run", "--rm", "--network", "none", "--entrypoint", "node", API_REF, "-e", js],
        "CANDIDATE_SQL_UNREADABLE",
        timeout=90,
    )
    rows = json.loads(output)
    if (
        len(rows) != 42
        or any(not SQL_RE.fullmatch(row["version"]) for row in rows)
        or list_hash(rows[:40]) != PREFIX_SHA
        or list_hash(rows) != TARGET_SHA
        or rows[40]["checksum"] != SQL_0041
        or rows[41]["checksum"] != SQL_0042
    ):
        raise GateError("CANDIDATE_SQL_MISMATCH")
    return rows


def verify_ledger(actual: object, expected: list[dict[str, str]], count: int, code: str) -> None:
    if not isinstance(actual, list) or len(actual) != count:
        raise GateError(code)
    if any(
        row.get("version") != candidate["version"]
        or row.get("checksum") != candidate["checksum"]
        or not row.get("applied_at")
        for row, candidate in zip(actual, expected[:count], strict=True)
    ):
        raise GateError(code)
    if list_hash(actual) != (PREFIX_SHA if count == 40 else TARGET_SHA):
        raise GateError(code)


def backup_files(mount: Path) -> set[str]:
    return {
        path.name for path in mount.iterdir()
        if path.is_file() and BACKUP_RE.fullmatch(path.name)
    }


def backup_mount() -> Path:
    info = json.loads(
        docker(["volume", "inspect", BACKUP_VOLUME], "BACKUP_VOLUME_UNREADABLE")
    )[0]
    if info["Name"] != BACKUP_VOLUME:
        raise GateError("BACKUP_VOLUME_MISMATCH")
    mount = Path(info["Mountpoint"]).resolve(strict=True)
    if not mount.is_dir() or mount.is_symlink():
        raise GateError("BACKUP_MOUNT_UNSAFE")
    return mount


def compose_preflight(env_file: Path) -> dict:
    if not COMPOSE.is_file() or not BACKUP_SCRIPT.is_file():
        raise GateError("PROTECTED_BUNDLE_MISSING")
    if not env_file.is_file():
        raise GateError("COMPOSE_ENV_FILE_MISSING")
    base = [
        "compose", "--env-file", str(env_file), "-f", str(COMPOSE),
        "--project-name", PROJECT, "--profile", "maintenance",
    ]
    docker([*base, "config", "--quiet"], "COMPOSE_CONFIG_INVALID", timeout=90)
    config = json.loads(
        docker([*base, "config", "--format", "json"], "COMPOSE_CONFIG_UNREADABLE", timeout=90)
    )
    service = config.get("services", {}).get("geops-backup", {})
    if (
        config.get("name") != PROJECT
        or "maintenance" not in service.get("profiles", [])
        or service.get("image") != "postgis/postgis:18-3.6"
        or not any(
            volume.get("target") == "/geops-backups"
            and volume.get("source") in {"stage_backups", BACKUP_VOLUME}
            for volume in service.get("volumes", [])
        )
        or config.get("volumes", {}).get("stage_backups", {}).get("name") != BACKUP_VOLUME
    ):
        raise GateError("BACKUP_SERVICE_CONFIG_MISMATCH")
    text = BACKUP_SCRIPT.read_text()
    if sha256_file(BACKUP_SCRIPT) != BACKUP_SCRIPT_SHA or not all(
        value in text for value in ("umask 077", "pg_dump", "-Fc", "sha256sum", "/geops-backups/")
    ):
        raise GateError("BACKUP_SCRIPT_UNRECOGNIZED")
    return {"args": base, "bundle_backup_sha256": sha256_file(BACKUP_SCRIPT), "compose_sha256": sha256_file(COMPOSE)}


def verify_backup(mount: Path, before: set[str], db_image: str, max_bytes: int) -> dict:
    new = backup_files(mount) - before
    if len(new) != 1:
        raise GateError("NEW_BACKUP_NOT_UNIQUE")
    name = next(iter(new))
    dump = mount / name
    checksum = mount / (name + ".sha256")
    if dump.is_symlink() or checksum.is_symlink() or not checksum.is_file():
        raise GateError("BACKUP_FILE_UNSAFE")
    size = dump.stat().st_size
    if size <= 0 or size > max_bytes:
        raise GateError("BACKUP_SIZE_OUT_OF_BOUNDS")
    line = checksum.read_text().strip()
    match = re.fullmatch(r"([0-9a-f]{64})\s+/geops-backups/(" + re.escape(name) + r")", line)
    if not match:
        raise GateError("BACKUP_CHECKSUM_FORMAT")
    digest = sha256_file(dump)
    if digest != match.group(1):
        raise GateError("BACKUP_CHECKSUM_MISMATCH")
    docker(
        [
            "run", "--rm", "--network", "none", "--memory", "512m",
            "-v", f"{BACKUP_VOLUME}:/geops-backups:ro", "--entrypoint", "pg_restore",
            db_image, "--list", f"/geops-backups/{name}",
        ],
        "BACKUP_CATALOG_INVALID",
        timeout=120,
    )
    return {
        "name": name,
        "size_bytes": size,
        "sha256": digest,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dump.stat().st_mtime)),
        "catalog": "PASS",
    }


def wait_db(container: str) -> None:
    for _ in range(90):
        try:
            docker(["exec", container, "pg_isready", "-U", "postgres"], "LAB_DB_NOT_READY", timeout=5)
            return
        except GateError:
            time.sleep(1)
    raise GateError("LAB_DB_NOT_READY")


def check_counts(before: dict, after: dict, restored: dict) -> dict:
    outcome = {}
    for key, value in restored.items():
        lower = min(int(before[key]), int(after[key]))
        upper = max(int(before[key]), int(after[key]))
        outcome[key] = {
            "before": int(before[key]),
            "after": int(after[key]),
            "restored": int(value),
            "within_observed_window": lower <= int(value) <= upper,
        }
    if not all(item["within_observed_window"] for item in outcome.values()):
        raise GateError("RESTORE_COUNTS_OUTSIDE_WINDOW")
    return outcome


def check_identity(before: dict, after: dict, restored: dict) -> dict[str, bool]:
    result = {
        key: restored[key] in {before[key], after[key]}
        for key in restored
    }
    if not all(result.values()):
        raise GateError("RESTORE_IDENTITY_MISMATCH")
    return result


def controller_static_check() -> dict:
    if not CONTROLLER.is_file() or not WRAPPER.is_file():
        raise GateError("CONTROLLER_SOURCE_UNREADABLE")
    source = CONTROLLER.read_text()
    ast.parse(source)
    tokens = {
        "backup": "backup" in source,
        "migrations": "migrat" in source.lower(),
        "gate": "gate" in source.lower(),
        "rollback": "rollback" in source.lower(),
        "digest": "sha256" in source.lower(),
        "health": "health" in source.lower(),
        "schema_42_mentioned": "42" in source,
    }
    return {
        "controller_sha256": sha256_file(CONTROLLER),
        "wrapper_sha256": sha256_file(WRAPPER),
        "static_capabilities": tokens,
        "static_compatible": all(value for key, value in tokens.items() if key != "schema_42_mentioned"),
        "isolated_controller_rehearsal": "NOT_RUN",
        "reason": "No controller invocation is safe until its isolated target interface is verified.",
    }


def controller_status() -> dict:
    try:
        value = json.loads(command([str(WRAPPER), "status"], "CONTROLLER_STATUS_FAILED", timeout=90))
    except ValueError as error:
        raise GateError("CONTROLLER_STATUS_INVALID") from error
    if (
        value.get("project") != PROJECT
        or value.get("gate") != "open"
        or value.get("migrations", {}).get("count") != 40
        or value.get("migrations", {}).get("sha256") != PREFIX_SHA
        or value.get("lastDeployment", {}).get("commit") != CURRENT_SHA
        or value.get("services", {}).get("api", {}).get("ref") != CURRENT_API
        or value.get("services", {}).get("web", {}).get("ref") != CURRENT_WEB
        or any(
            value.get("services", {}).get(name, {}).get("health") != "healthy"
            for name in ("api", "web", "db")
        )
    ):
        raise GateError("STAGING_CONTROLLER_STATE_CHANGED")
    return value


def remove_created_container(name: str, run_id: str) -> None:
    listed = docker(
        ["ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"],
        "TEMP_CONTAINER_LIST_FAILED",
    ).splitlines()
    if not listed:
        return
    if listed != [name]:
        raise GateError("TEMP_CONTAINER_NAME_MISMATCH")
    item = json.loads(docker(["inspect", name], "TEMP_CONTAINER_INSPECT_FAILED"))[0]
    if (
        item.get("Name") != f"/{name}"
        or item.get("Config", {}).get("Labels", {}).get("org.geops.spec05.run") != run_id
    ):
        raise GateError("TEMP_CONTAINER_OWNERSHIP_MISMATCH")
    docker(["rm", "-f", name], "TEMP_CONTAINER_CLEANUP_FAILED", timeout=60)


def remove_created_volume(name: str, run_id: str) -> None:
    listed = docker(
        ["volume", "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}"],
        "TEMP_VOLUME_LIST_FAILED",
    ).splitlines()
    if not listed:
        return
    if listed != [name]:
        raise GateError("TEMP_VOLUME_NAME_MISMATCH")
    item = json.loads(docker(["volume", "inspect", name], "TEMP_VOLUME_INSPECT_FAILED"))[0]
    if (
        item.get("Name") != name
        or item.get("Labels", {}).get("org.geops.spec05.run") != run_id
    ):
        raise GateError("TEMP_VOLUME_OWNERSHIP_MISMATCH")
    docker(["volume", "rm", name], "TEMP_VOLUME_CLEANUP_FAILED", timeout=60)


def report_file(directory: Path, run_id: str, value: dict) -> Path:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise GateError("REPORT_DIRECTORY_PERMISSIONS")
    path = directory / f"spec05-w6r2-{run_id}.json"
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(encoded)
        file.flush()
        os.fsync(file.fileno())
    return path


def self_test() -> None:
    rows = [
        {"version": "0001_a.sql", "checksum": "a" * 64},
        {"version": "0002_b.sql", "checksum": "b" * 64},
    ]
    assert list_hash(rows) == hashlib.sha256(
        ("0001_a.sql|" + "a" * 64 + "\n0002_b.sql|" + "b" * 64).encode()
    ).hexdigest()
    assert BACKUP_RE.fullmatch("geops-stage-20261128T120000Z.dump")
    assert not BACKUP_RE.fullmatch("../../geops-stage-20261128T120000Z.dump")
    assert not BACKUP_RE.fullmatch("geops-stage-20261128T120000Z.dump.old")
    assert API_REF.startswith("ghcr.io/kmena/geops-api@sha256:")
    assert WEB_REF.startswith("ghcr.io/kmena/geops-web@sha256:")
    assert len(SOURCE_SHA) == 40
    assert check_counts({"devices": 2}, {"devices": 3}, {"devices": 2})["devices"]["within_observed_window"]
    assert check_identity({"devices": "a"}, {"devices": "b"}, {"devices": "a"})["devices"]
    try:
        check_counts({"devices": 2}, {"devices": 3}, {"devices": 4})
    except GateError as error:
        assert error.code == "RESTORE_COUNTS_OUTSIDE_WINDOW"
    else:
        raise AssertionError("Out-of-window restore accepted")
    print("SPEC-05 W6-R2 operator script self-test PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-env-file", type=Path, help="Existing protected Compose env-file path")
    parser.add_argument(
        "--authorize-isolated-gate-open", action="store_true",
        help="Operator authorizes opening only the quarantined, network-none restore gate",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if os.geteuid() != 0 or args.compose_env_file is None or not args.compose_env_file.is_absolute():
        parser.error("Run with sudo and --compose-env-file ABSOLUTE_EXISTING_PATH")
    os.umask(0o077)
    REPORT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if REPORT_DIR.is_symlink() or REPORT_DIR.stat().st_mode & 0o077:
        parser.error("Protected report directory must be private (0700)")

    started = time.monotonic()
    run_id = time.strftime("%Y%m%d%H%M%S", time.gmtime()) + uuid.uuid4().hex[:8]
    lab_name = f"geops-spec05-r2-{run_id}-db"
    api_name = f"geops-spec05-r2-{run_id}-api"
    web_name = f"geops-spec05-r2-{run_id}-web"
    volume_name = f"geops_spec05_r2_{run_id}_pgdata"
    db_name = "geops_verify_" + re.sub(r"\D", "", run_id[:14]) + "_restore"
    report: dict = {
        "schema_version": 1,
        "run_id": run_id,
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_sha": SOURCE_SHA,
        "ci_run": 46164447870,
        "candidate_api": API_REF,
        "candidate_web": WEB_REF,
        "staging_project": PROJECT,
        "staging_promoted": False,
        "steps": {},
        "timings_seconds": {},
        "gates": {
            "STAGING_REAL_LEDGER_VERIFIED": "BLOCKED",
            "STAGING_ACTIVE_OCI_LABELS_VERIFIED": "BLOCKED",
            "STAGING_BACKUP_PASS": "BLOCKED",
            "STAGING_REAL_RESTORE_PASS": "BLOCKED",
            "STAGING_RESTORED_MIGRATION_0042_PASS": "BLOCKED",
            "STAGING_OPERATOR_REHEARSAL_PASS": "BLOCKED",
            "STAGING_PROMOTION_READY": "BLOCKED",
            "STAGING_PROMOTION_AUTHORIZED": "NOT_RUN",
            "STAGING_DEPLOYED": "NOT_RUN",
        },
    }
    created_containers: list[str] = []
    created_volumes: list[str] = []
    created_dirs: list[Path] = []
    stage = "PREFLIGHT"
    failure: str | None = None
    def terminate(_signum: int, _frame: object) -> None:
        raise GateError("OPERATOR_INTERRUPTED")
    signal.signal(signal.SIGTERM, terminate)
    try:
        report["resources_before"] = require_resources(MIN_INITIAL_DISK, "INITIAL_CAPACITY_INSUFFICIENT")
        compose = compose_preflight(args.compose_env_file)
        controller_status()
        report["controller_read_only_check_before"] = "PASS"
        report["bundle"] = {
            "compose_sha256": compose["compose_sha256"],
            "backup_script_sha256": compose["bundle_backup_sha256"],
            "effective_backup_config": "PASS",
        }
        stage = "ACTIVE_INVENTORY"
        active = containers_by_service()
        report["active"] = active_inventory(active)
        if "geops_spec02_stage_pgdata" not in report["active"]["geops-db"]["named_volumes"]:
            raise GateError("ACTIVE_DATABASE_VOLUME_CHANGED")
        report["infrastructure"] = {
            "volumes": sorted(
                name for name in docker(
                    ["volume", "ls", "--format", "{{.Name}}"], "VOLUME_LIST_FAILED"
                ).splitlines() if name.startswith("geops_")
            ),
            "networks": sorted(
                name for name in docker(
                    ["network", "ls", "--format", "{{.Name}}"], "NETWORK_LIST_FAILED"
                ).splitlines() if name.startswith("geops_")
            ),
        }
        report["gates"]["STAGING_ACTIVE_OCI_LABELS_VERIFIED"] = "PASS"
        db_container = active["geops-db"]["Id"]
        db_image = active["geops-db"]["Image"]
        info = sql(db_container, "geops_dev", DB_INFO_SQL, "ACTIVE_DB_INFO_FAILED")
        if (
            info["database"] != "geops_dev"
            or not info["postgres"].startswith("18.6")
            or not info["postgis"].startswith("3.6")
            or int(info["bytes"]) > MAX_DB_SIZE
        ):
            raise GateError("ACTIVE_DB_VERSION_OR_SIZE_CHANGED")
        report["active_db"] = info
        report["counts_before"] = sql(db_container, "geops_dev", COUNTS_SQL, "ACTIVE_COUNTS_FAILED")
        if (
            report["counts_before"]["devices"] != 2
            or report["counts_before"]["installations"] != 2
            or report["counts_before"]["mdm_integrations"] != 1
            or report["counts_before"]["positions"] < 1327
        ):
            raise GateError("ACTIVE_BASELINE_COUNTS_CHANGED")
        identity_before = sql(db_container, "geops_dev", IDENTITY_SQL, "ACTIVE_IDENTITIES_FAILED")
        config_before = sql(db_container, "geops_dev", CONFIG_SQL, "ACTIVE_CONFIG_FAILED")

        stage = "CANDIDATE_IMAGES_AND_LEDGER"
        step_started = time.monotonic()
        docker(["pull", API_REF], "CANDIDATE_API_PULL_FAILED", timeout=600)
        docker(["pull", WEB_REF], "CANDIDATE_WEB_PULL_FAILED", timeout=600)
        report["timings_seconds"]["candidate_pull"] = round(time.monotonic() - step_started, 1)
        report["resources_after_pull"] = require_resources(MIN_AFTER_PULL, "CAPACITY_AFTER_PULL_INSUFFICIENT")
        for ref, variant in ((API_REF, "api"), (WEB_REF, "web")):
            image = image_info(ref)
            labels = image.get("Config", {}).get("Labels") or {}
            if (
                image["Os"] != "linux"
                or image["Architecture"] != "amd64"
                or labels.get("org.opencontainers.image.revision") != SOURCE_SHA
                or labels.get("org.geops.schema.target") != "42"
                or labels.get(f"org.geops.{variant}.variant") != "SPEC05-W6-R2"
                or (variant == "web" and labels.get("org.geops.web.mdm_enabled") != "true")
            ):
                raise GateError("CANDIDATE_OCI_LABELS_MISMATCH")
        catalog = candidate_catalog()
        ledger = sql(db_container, "geops_dev", LEDGER_SQL, "ACTIVE_LEDGER_UNREADABLE")
        verify_ledger(ledger, catalog, 40, "ACTIVE_LEDGER_DIVERGENCE")
        report["ledger"] = {
            "current_count": 40, "current_list_sha256": PREFIX_SHA,
            "target_count": 42, "target_list_sha256": TARGET_SHA,
            "0041_sha256": SQL_0041, "0042_sha256": SQL_0042,
            "row_by_row_checksum_match": True,
        }
        report["gates"]["STAGING_REAL_LEDGER_VERIFIED"] = "PASS"
        report["steps"]["candidate_images"] = "PASS"

        stage = "PROTECTED_BACKUP"
        mount = backup_mount()
        before_files = backup_files(mount)
        step_started = time.monotonic()
        docker(
            [*compose["args"], "run", "--rm", "--no-deps", "geops-backup"],
            "PROTECTED_BACKUP_FAILED",
            timeout=1200,
        )
        backup = verify_backup(mount, before_files, db_image, min(MAX_DUMP_SIZE, 2 * int(info["bytes"])))
        report["timings_seconds"]["backup_and_verification"] = round(time.monotonic() - step_started, 1)
        report["backup"] = backup
        report["gates"]["STAGING_BACKUP_PASS"] = "PASS"
        report["resources_after_backup"] = require_resources(MIN_AFTER_BACKUP, "CAPACITY_AFTER_BACKUP_INSUFFICIENT")
        counts_after = sql(db_container, "geops_dev", COUNTS_SQL, "ACTIVE_COUNTS_AFTER_FAILED")
        identity_after = sql(db_container, "geops_dev", IDENTITY_SQL, "ACTIVE_IDENTITIES_AFTER_FAILED")
        config_after = sql(db_container, "geops_dev", CONFIG_SQL, "ACTIVE_CONFIG_AFTER_FAILED")

        stage = "ISOLATED_RESTORE"
        step_started = time.monotonic()
        created_volumes.append(volume_name)
        docker(
            ["volume", "create", "--label", f"org.geops.spec05.run={run_id}", volume_name],
            "LAB_VOLUME_CREATE_FAILED",
        )
        created_containers.append(lab_name)
        docker(
            [
                "run", "-d", "--name", lab_name,
                "--label", f"org.geops.spec05.run={run_id}", "--network", "none",
                "--memory", "2g", "--cpus", "1", "--pids-limit", "128",
                "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                "-v", f"{volume_name}:/var/lib/postgresql",
                "-v", f"{BACKUP_VOLUME}:/geops-backups:ro",
                db_image,
            ],
            "LAB_DB_START_FAILED",
            timeout=120,
        )
        observed = json.loads(docker(["inspect", lab_name], "LAB_ISOLATION_INSPECT_FAILED"))[0]
        ports = observed["NetworkSettings"].get("Ports") or {}
        if observed["HostConfig"]["NetworkMode"] != "none" or any(ports.values()):
            raise GateError("LAB_NETWORK_ISOLATION_FAILED")
        if any(
            mount_item["Name"] == "geops_spec02_stage_pgdata"
            for mount_item in observed.get("Mounts", [])
        ):
            raise GateError("LAB_ACTIVE_VOLUME_ATTACHED")
        wait_db(lab_name)
        docker(["exec", lab_name, "createdb", "-U", "postgres", db_name], "LAB_DB_CREATE_FAILED")
        docker(
            [
                "exec", lab_name, "pg_restore", "--exit-on-error", "--single-transaction",
                "--no-owner", "--no-acl", "-U", "postgres", "-d", db_name,
                f"/geops-backups/{backup['name']}",
            ],
            "REAL_DUMP_RESTORE_FAILED",
            timeout=1200,
        )
        restored_ledger = sql(lab_name, db_name, LEDGER_SQL, "RESTORED_LEDGER_UNREADABLE")
        verify_ledger(restored_ledger, catalog, 40, "RESTORED_LEDGER_MISMATCH")
        restored_info = sql(lab_name, db_name, DB_INFO_SQL, "RESTORED_DB_INFO_FAILED")
        if not restored_info["postgres"].startswith("18.") or not restored_info["postgis"].startswith("3.6"):
            raise GateError("RESTORED_POSTGIS_MISMATCH")
        restored_counts = sql(lab_name, db_name, COUNTS_SQL, "RESTORED_COUNTS_FAILED")
        restored_identity = sql(lab_name, db_name, IDENTITY_SQL, "RESTORED_IDENTITIES_FAILED")
        restored_config = sql(lab_name, db_name, CONFIG_SQL, "RESTORED_CONFIG_FAILED")
        report["restore"] = {
            "database": db_name, "network": "none",
            "data_volume": volume_name, "source_backup_sha256": backup["sha256"],
            "postgres": restored_info["postgres"], "postgis": restored_info["postgis"],
            "counts": check_counts(report["counts_before"], counts_after, restored_counts),
            "identity_matches": check_identity(identity_before, identity_after, restored_identity),
            "configuration_matches": check_identity(config_before, config_after, restored_config),
            "ledger_0040": "PASS",
        }
        report["timings_seconds"]["isolated_restore_and_comparison"] = round(time.monotonic() - step_started, 1)
        report["gates"]["STAGING_REAL_RESTORE_PASS"] = "PASS"

        stage = "RESTORED_MIGRATION"
        step_started = time.monotonic()
        database_url = f"postgres://postgres@127.0.0.1:5432/{db_name}"
        docker(
            [
                "run", "--rm", "--network", f"container:{lab_name}",
                "--memory", "512m", "--cpus", "1",
                "-e", "GEOPS_DATA_MODE=synthetic",
                "-e", f"DATABASE_URL={database_url}",
                "-e", f"GEOPS_MIGRATION_TARGET={db_name}",
                "-e", f"GEOPS_CONFIRM_MIGRATION_TARGET={db_name}",
                "--entrypoint", "node", API_REF, "apps/api/dist/db/migrate.js",
            ],
            "RESTORED_MIGRATION_FAILED",
            timeout=600,
        )
        final_ledger = sql(lab_name, db_name, LEDGER_SQL, "FINAL_LEDGER_UNREADABLE")
        verify_ledger(final_ledger, catalog, 42, "FINAL_LEDGER_MISMATCH")
        objects = sql(lab_name, db_name, OBJECTS_SQL, "NEW_OBJECTS_UNREADABLE")
        if not (
            objects["diagnostics"] and objects["requests"] and objects["events"]
            and objects["diagnostic_indexes"] >= 3
            and objects["request_indexes"] >= 3
            and objects["event_indexes"] >= 2
            and objects["invalid_constraints"] == 0
            and objects["immutable_triggers"] == 2
        ):
            raise GateError("NEW_SCHEMA_OBJECTS_MISMATCH")
        report["restore"]["ledger_0042"] = "PASS"
        report["restore"]["schema_objects"] = objects
        report["timings_seconds"]["migration_0041_0042"] = round(time.monotonic() - step_started, 1)
        report["gates"]["STAGING_RESTORED_MIGRATION_0042_PASS"] = "PASS"
        report["resources_after_restore"] = require_resources(2 * GIB, "CAPACITY_AFTER_RESTORE_INSUFFICIENT")

        stage = "QUARANTINE_AND_IMAGE_CHECKS"
        gate_dir = REPORT_DIR / f"gate-{run_id}"
        gate_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
        created_dirs.append(gate_dir)
        os.chown(gate_dir, 1000, 1000)
        gate_path = gate_dir / "security-gate.json"
        gate_epoch = str(uuid.uuid4())
        gate_path.write_text(json.dumps({"version": 1, "phase": "closed", "epoch": gate_epoch}))
        os.chown(gate_path, 1000, 1000)
        gate_path.chmod(0o600)
        docker(
            [
                "run", "--rm", "--network", f"container:{lab_name}", "--memory", "512m",
                "-v", f"{gate_dir}:/geops-security:rw",
                "-e", "GEOPS_DATA_MODE=synthetic",
                "-e", f"DATABASE_URL={database_url}",
                "-e", f"GEOPS_TEST_DB={db_name}",
                "-e", "GEOPS_CONFIRM_RESTORE_QUARANTINE=YES",
                "-e", "GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json",
                "--entrypoint", "node", API_REF,
                "apps/api/dist/db/quarantine-restored-db.js",
            ],
            "RESTORED_CREDENTIAL_QUARANTINE_FAILED",
            timeout=180,
        )
        report["restore"]["credentials_quarantined"] = True
        reopen_js = (
            "import {Pool} from 'pg';"
            "import {verifyForReopen} from './apps/api/dist/db/restore-gate.js';"
            "const p=new Pool({connectionString:process.env.DATABASE_URL});"
            "try {if(!(await verifyForReopen(p,process.env.GEOPS_SECURITY_GATE_PATH))) process.exitCode=1;}"
            " finally {await p.end();}"
        )
        docker(
            [
                "run", "--rm", "--network", f"container:{lab_name}", "--memory", "512m",
                "-v", f"{gate_dir}:/geops-security:ro",
                "-e", f"DATABASE_URL={database_url}",
                "-e", "GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json",
                "--entrypoint", "node", API_REF, "--input-type=module", "-e", reopen_js,
            ],
            "ISOLATED_REOPEN_SAFETY_FAILED",
            timeout=90,
        )
        readiness_js = (
            "import {Pool} from 'pg';"
            "import {checkReadiness} from './apps/api/dist/db/migration-manager.js';"
            "const p=new Pool({connectionString:process.env.DATABASE_URL});"
            "try {if(!(await checkReadiness(p))) process.exitCode=1;} finally {await p.end();}"
        )
        docker(
            [
                "run", "--rm", "--network", f"container:{lab_name}", "--memory", "512m",
                "-e", f"DATABASE_URL={database_url}", "--entrypoint", "node", API_REF,
                "--input-type=module", "-e", readiness_js,
            ],
            "CANDIDATE_API_SCHEMA_READINESS_FAILED",
            timeout=90,
        )
        if not args.authorize_isolated_gate_open:
            raise GateError("ISOLATED_GATE_OPEN_AUTHORIZATION_REQUIRED")
        open_js = (
            "import {Pool} from 'pg';"
            "import {openGateAfterQuarantine} from './apps/api/dist/db/restore-gate.js';"
            "const p=new Pool({connectionString:process.env.DATABASE_URL});"
            "try {await openGateAfterQuarantine(p,process.env.GEOPS_SECURITY_GATE_PATH,"
            "{databaseName:process.env.GEOPS_TEST_DB,epoch:process.env.GEOPS_ISOLATED_GATE_EPOCH});}"
            " finally {await p.end();}"
        )
        docker(
            [
                "run", "--rm", "--network", f"container:{lab_name}", "--memory", "512m",
                "-v", f"{gate_dir}:/geops-security:rw",
                "-e", f"DATABASE_URL={database_url}",
                "-e", f"GEOPS_TEST_DB={db_name}",
                "-e", f"GEOPS_ISOLATED_GATE_EPOCH={gate_epoch}",
                "-e", "GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json",
                "--entrypoint", "node", API_REF, "--input-type=module", "-e", open_js,
            ],
            "ISOLATED_GATE_OPEN_FAILED",
            timeout=90,
        )
        synthetic_keys = {
            name: secrets.token_urlsafe(32)
            for name in (
                "GEOPS_ADMIN_SESSION_KEY", "GEOPS_ADMIN_CSRF_KEY",
                "GEOPS_INVITATION_HMAC_KEY", "GEOPS_MDM_GRANT_KEY",
                "GEOPS_GPS_QUARANTINE_KEY",
            )
        }
        api_env = [
            "GEOPS_DATA_MODE=synthetic", f"DATABASE_URL={database_url}",
            "GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json",
            "GEOPS_INSECURE_LOCAL_COOKIE=1",
            "GEOPS_ALLOWED_ORIGINS=http://127.0.0.1:3501",
            "HOST=127.0.0.1", "PORT=3500", "LOG_LEVEL=silent",
            "MDM_ENABLED=false", "GEOPS_GEOCODING_DISABLED=YES",
        ]
        for key, value in synthetic_keys.items():
            api_env.append(f"{key}={value}")
        api_args = [
            "run", "-d", "--name", api_name,
            "--label", f"org.geops.spec05.run={run_id}",
            "--network", f"container:{lab_name}",
            "--memory", "512m", "--cpus", "1",
            "-v", f"{gate_dir}:/geops-security:ro",
        ]
        for item in api_env:
            api_args.extend(["-e", item])
        created_containers.append(api_name)
        docker([*api_args, API_REF], "CANDIDATE_API_START_FAILED", timeout=90)
        api_inspect = json.loads(
            docker(["inspect", api_name], "CANDIDATE_API_INSPECT_FAILED")
        )[0]
        if (
            api_inspect["HostConfig"]["NetworkMode"] != f"container:{lab_name}"
            or api_inspect["HostConfig"].get("PortBindings")
        ):
            raise GateError("CANDIDATE_API_ISOLATION_FAILED")
        api_health_js = (
            "const h=await fetch('http://127.0.0.1:3500/health/ready');"
            "const j=await h.json();"
            "if(h.status!==200||j.status!=='ok')process.exitCode=1;"
        )
        api_ready = False
        for _ in range(60):
            try:
                docker(
                    ["exec", api_name, "node", "--input-type=module", "-e", api_health_js],
                    "CANDIDATE_API_HEALTH_FAILED", timeout=5,
                )
                api_ready = True
                break
            except GateError:
                time.sleep(1)
        if not api_ready:
            raise GateError("CANDIDATE_API_HEALTH_FAILED")
        routes_js = (
            "for(const [u,m] of [['/v1/device/diagnostics/self','GET'],"
            "['/v1/admin/mdm/workspace/summary','GET'],"
            "['/v2/device/gps/batches','POST']]){"
            "const r=await fetch('http://127.0.0.1:3500'+u,{method:m,"
            "headers:{'content-type':'application/json'},body:m==='POST'?'{}':undefined});"
            "if(r.status!==401)process.exitCode=1;}"
        )
        docker(
            ["exec", api_name, "node", "--input-type=module", "-e", routes_js],
            "CANDIDATE_API_CONTRACT_ROUTE_FAILED", timeout=30,
        )
        created_containers.append(web_name)
        docker(
            [
                "run", "-d", "--name", web_name,
                "--label", f"org.geops.spec05.run={run_id}",
                "--network", "none", "--memory", "128m",
                WEB_REF,
            ],
            "CANDIDATE_WEB_START_FAILED",
            timeout=90,
        )
        docker(
            ["exec", web_name, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"],
            "CANDIDATE_WEB_HEALTH_FAILED",
            timeout=30,
        )
        report["candidate_image_checks"] = {
            "api_schema_readiness": "PASS", "api_http_ready": "PASS",
            "api_route_presence_unauthenticated": "PASS",
            "web_http_health": "PASS",
            "mdm_external_access": "DISABLED_BY_NETWORK_NONE",
            "real_device_commands": "NOT_RUN",
        }

        stage = "CONTROLLER_COMPATIBILITY"
        report["controller"] = controller_static_check()
        report["gates"]["STAGING_OPERATOR_REHEARSAL_PASS"] = "BLOCKED"
        report["gates"]["STAGING_PROMOTION_READY"] = "BLOCKED"
        report["steps"]["controller_static_check"] = (
            "PASS" if report["controller"]["static_compatible"] else "PARTIAL"
        )
        report["next_action"] = (
            "Review the protected controller's isolated-target interface and rehearse "
            "its gate/backup/migration/recovery sequence against this restore only; "
            "do not invoke the production deploy command."
        )
    except (GateError, ValueError, KeyError, OSError, SyntaxError) as error:
        failure = error.code if isinstance(error, GateError) else "UNEXPECTED_REHEARSAL_ERROR"
        report["failure"] = {"stage": stage, "code": failure}
    except KeyboardInterrupt:
        failure = "OPERATOR_INTERRUPTED"
        report["failure"] = {"stage": stage, "code": failure}
    finally:
        cleanup_errors = []
        for name in reversed(created_containers):
            try:
                remove_created_container(name, run_id)
            except GateError:
                cleanup_errors.append(name)
        for name in reversed(created_volumes):
            try:
                remove_created_volume(name, run_id)
            except GateError:
                cleanup_errors.append(name)
        for path in reversed(created_dirs):
            try:
                if path.parent != REPORT_DIR or not path.name.startswith(f"gate-{run_id}"):
                    raise GateError("TEMP_DIRECTORY_PATH_UNSAFE")
                shutil.rmtree(path)
            except (GateError, OSError):
                cleanup_errors.append(path.name)
        try:
            controller_status()
            report["controller_read_only_check_after"] = "PASS"
        except GateError as error:
            report["controller_read_only_check_after"] = error.code
            if failure is None:
                failure = error.code
                report["failure"] = {"stage": "FINAL_STAGING_STATUS", "code": failure}
        report["temporary_cleanup"] = "PASS" if not cleanup_errors else "FAIL"
        if cleanup_errors:
            report["temporary_resources_remaining"] = cleanup_errors
        report["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        report["duration_seconds"] = int(time.monotonic() - started)
        report_write_failed = False
        try:
            path = report_file(REPORT_DIR, run_id, report)
            print(f"Sanitized report: {path}")
            print(f"Report SHA-256: {sha256_file(path)}")
            print(f"Promotion ready: {report['gates']['STAGING_PROMOTION_READY']}")
            if failure:
                print(f"Blocked at {stage}: {failure}", file=sys.stderr)
        except (GateError, OSError):
            print("Could not write protected sanitized report", file=sys.stderr)
            report_write_failed = True
    if report_write_failed:
        return 2
    return 1 if failure or report["temporary_cleanup"] != "PASS" else 0


if __name__ == "__main__":
    raise SystemExit(main())
