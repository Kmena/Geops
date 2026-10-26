#!/usr/bin/env python3
"""Verify Docker save contents against an image config digest and every layer."""

import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path


def sha_stream(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(block)
    return value.hexdigest()


def verify(path, tag, image_id):
    with tarfile.open(path, 'r:') as source:
        members = source.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(
                not (member.isfile() or member.isdir()) or
                member.name.startswith('/') or '..' in Path(member.name).parts
                for member in members):
            raise ValueError('Docker archive contains duplicate or non-file entries')
        indexed = {member.name: member for member in members}
        manifest = json.load(source.extractfile(indexed['manifest.json']))
        if len(manifest) != 1 or manifest[0].get('RepoTags') != [tag]:
            raise ValueError('Docker archive tag or manifest changed')
        item = manifest[0]
        config_name = item['Config']
        if config_name not in indexed or not re.fullmatch(
                r'blobs/sha256/[a-f0-9]{64}', config_name):
            raise ValueError('Docker image config missing')
        config_bytes = source.extractfile(indexed[config_name]).read()
        if 'sha256:' + hashlib.sha256(config_bytes).hexdigest() != image_id:
            raise ValueError('Archive image config differs from inspected image ID')
        config = json.loads(config_bytes)
        layers = item['Layers']
        diff_ids = config.get('rootfs', {}).get('diff_ids', [])
        if not layers or len(layers) != len(diff_ids) or config.get('architecture') != 'amd64':
            raise ValueError('Docker archive architecture or layer inventory differs')
        for layer, expected in zip(layers, diff_ids):
            if layer not in indexed or 'sha256:' + sha_stream(
                    source.extractfile(indexed[layer])) != expected:
                raise ValueError('Docker archive layer checksum differs')
        return {'result': 'IMAGE_ARCHIVE_VERIFIED', 'tag': tag, 'imageId': image_id,
                'layers': len(layers), 'architecture': config['architecture']}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify-image-archive.py IMAGE.tar TAG sha256:IMAGE_ID')
    print(json.dumps(verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3]), sort_keys=True))
