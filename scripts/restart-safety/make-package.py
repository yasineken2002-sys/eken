#!/usr/bin/env python3
"""Freeze a package from an explicitly reviewed, extracted image. Never run at boot.

image-root contains apps/api/... (the extracted /app). No Docker, network or
deployment mutations. The operator must verify the image/revision binding.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex

HERE = Path(__file__).resolve().parent
DECLARED = (
    'dist/app.module.js', 'dist/common/health/health.controller.js',
    'dist/common/ops/automation-pause.js', 'dist/common/ops/queue-inventory.js',
    'dist/deposits/deposits.service.js', 'dist/main.js',
    'dist/scripts/queue-ops.js', 'prisma/schema.prisma',
    'scripts/migrate-and-start.sh',
)


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def build(root, revision, image, paused, out):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('full Git revision required')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('immutable image digest required')
    api = root / 'apps/api'
    migrations = api / 'prisma/migrations'
    declared_migrations = {
        p.name: sha((p / 'migration.sql').read_bytes())
        for p in sorted(migrations.iterdir()) if p.is_dir()
    }
    if not declared_migrations:
        raise ValueError('empty migration inventory')
    manifest = {
        'manifest_version': 1,
        'expected_revision': revision,
        'derived_from_image': image,
        'derivation_note': 'Frozen offline from reviewed image; never derive at startup.',
        'declared_files': {
            '/app/apps/api/' + p: sha((api / p).read_bytes()) for p in DECLARED
        },
        'declared_migrations': declared_migrations,
        'declared_migration_count': len(declared_migrations),
        'forbidden_env_names': [
            'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN',
            'RAILWAY_ACCOUNT_TOKEN',
        ],
        'required_app_env': {'OPS_AUTOMATION_PAUSED': paused},
    }
    man = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    gate = (HERE / 'gate.js').read_bytes()
    template = (HERE / 'bootstrap.template.sh').read_text()
    if template.count('@TOOL_SHA@') != 1 or template.count('@MAN_SHA@') != 1:
        raise ValueError('bootstrap hash placeholders changed')
    boot = template.replace('@TOOL_SHA@', sha(gate)).replace('@MAN_SHA@', sha(man))
    files = {
        'manifest.json': man, 'gate.js': gate, 'bootstrap.sh': boot.encode(),
        'GATE_TOOL_B64.txt': base64.b64encode(gate),
        'GATE_MANIFEST_B64.txt': base64.b64encode(man),
    }
    for mode in ('app', 'migrator'):
        files[f'start-command-{mode}.txt'] = (
            '/bin/sh -ec ' + shlex.quote(boot) + ' -- ' + mode
        ).encode()
    # A deployment that only verifies the package lets the operator inspect
    # Railway's applied NEVER policy before issuing the one-shot migrator.
    target = 'cd /app/apps/api\ncase "$MODE" in\n'
    if boot.count(target) != 1:
        raise ValueError('bootstrap target boundary changed')
    precheck = boot.split(target)[0] + 'echo PRECHECK_OK\nexit 0\n'
    files['start-command-precheck.txt'] = (
        '/bin/sh -ec ' + shlex.quote(precheck) + ' -- migrator'
    ).encode()
    # Refuse to overwrite a previously reviewed package.
    out.mkdir(parents=True, exist_ok=False)
    for name, blob in files.items():
        (out / name).write_bytes(blob)
    (out / 'bootstrap.sh').chmod(0o755)
    (out / 'package.json').write_text(json.dumps({
        'expected_revision': revision,
        'derived_from_image': image,
        'required_app_env': manifest['required_app_env'],
        'files': {n: {'sha256': sha(b), 'bytes': len(b)} for n, b in files.items()},
    }, indent=2) + '\n')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image-root', type=Path, required=True)
    p.add_argument('--revision', required=True)
    p.add_argument('--image-digest', required=True)
    p.add_argument('--paused', choices=('true', 'false'), required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    build(a.image_root, a.revision, a.image_digest, a.paused, a.output)
