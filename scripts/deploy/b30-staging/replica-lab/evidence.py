#!/usr/bin/python3
"""Read only non-secret state from the dedicated B30 staging replica."""

import json
from pathlib import Path

import run_replica as lab

gate = json.loads(Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json').read_text())
journal = json.loads(Path('/var/lib/geops-b30-staging/promotion.json').read_text())
ledger = lab.db("SELECT version||'|'||checksum FROM geops_schema_migrations ORDER BY version")
services = {}
for name in ('db', 'api', 'web'):
    container = lab.PROJECT + '-geops-' + name + '-1'
    services[name] = {
        'imageId': lab.docker('inspect', container, '--format', '{{.Image}}').strip(),
        'health': lab.docker('inspect', container, '--format', '{{.State.Health.Status}}').strip(),
    }
print(json.dumps({
    'schema': len(ledger.splitlines()),
    'ledgerSha256': lab.sha(ledger.encode()),
    'gatePhase': gate['phase'],
    'journalPhase': journal['phase'],
    'mdmBindings': int(lab.db('SELECT count(*) FROM mdm_binding')),
    'gpsInstallations': int(lab.db('SELECT count(*) FROM gps_device_installation')),
    'services': services,
}, sort_keys=True))
