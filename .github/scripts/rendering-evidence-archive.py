"""Package frozen evidence, never renderer output or a production-line budget guard.

Build verifies the complete approved-change partition against frozen Git objects.
Verify reads only the manifest and archive: no old worktree, Git source or extraction.
It proves bytes/membership, not the semantic validity of historical experiments.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'docs/granskning/agent3-rendering-2-1-package'
SOURCE = '73d221c9b7e002b70262a3186b76fea876d6ad01'
BASE = '5ae9906b152307eae0d79eec719d4303a042742c'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def entries(manifest):
    require(manifest['source'] == SOURCE and manifest['base'] == BASE, 'Frozen revisions')
    result = {}
    for item in manifest['files']:
        path = item['path']
        require(path and path == str(PurePosixPath(path)) and not path.startswith('/')
                and '..' not in PurePosixPath(path).parts
                and not any(ord(c) < 32 for c in path), 'Unsafe path')
        require(path not in result, 'Duplicate manifest path')
        require(item['mode'] in ['100644', '100755'], 'Unsupported Git mode')
        require(isinstance(item['bytes'], int) and item['bytes'] >= 0, 'Invalid size')
        require(len(item['sha256']) == 64, 'Invalid SHA256')
        result[path] = item
    require(result, 'Empty manifest')
    return result


def verify_bytes(data, item):
    require(len(data) == item['bytes'], 'Member size: ' + item['path'])
    require(sha256(data) == item['sha256'], 'Member digest: ' + item['path'])


def check_partition(archive, retained):
    archived, kept = entries(archive), entries(retained)
    require(not archived.keys() & kept.keys(), 'Partition overlap')
    changed = set(git('diff', '--name-only', BASE, SOURCE).decode().splitlines())
    require(changed == archived.keys() | kept.keys(), 'Incomplete source partition')
    tree = {}
    for record in git('ls-tree', '-r', '-z', SOURCE).split(b'\0'):
        if record:
            meta, path = record.decode().split('\t', 1)
            mode, kind, oid = meta.split()
            tree[path] = (mode, kind, oid)
    for path, item in {**archived, **kept}.items():
        require(tree[path] == (item['mode'], 'blob', item['gitBlob']), 'Source tree entry: ' + path)
        verify_bytes(git('cat-file', 'blob', item['gitBlob']), item)
        if path in kept:
            verify_bytes((ROOT / path).read_bytes(), item)
    return archived


def build_archive(target, manifest, retained):
    selected = check_partition(manifest, retained)
    require(not target.exists(), 'Archive target already exists')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(target, 'w', format=tarfile.GNU_FORMAT) as archive:
        for path, item in sorted(selected.items()):
            data = git('cat-file', 'blob', item['gitBlob'])
            verify_bytes(data, item)
            header = tarfile.TarInfo(path)
            header.size = len(data)
            header.mode = int(item['mode'], 8) & 0o777
            header.mtime = header.uid = header.gid = 0
            header.uname = header.gname = ''
            archive.addfile(header, io.BytesIO(data))
    data = target.read_bytes()
    return {'archiveBytes': len(data), 'archiveSha256': sha256(data)}


def verify_archive(target, manifest):
    selected = entries(manifest)
    data = target.read_bytes()
    require(len(data) == manifest['archiveBytes'], 'Archive size')
    require(sha256(data) == manifest['archiveSha256'], 'Archive digest')
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            require(member.name not in seen, 'Duplicate archive path')
            require(member.name in selected, 'Unexpected archive member')
            require(member.isfile(), 'Non-regular archive member')
            item = selected[member.name]
            require(member.mode == int(item['mode'], 8) & 0o777, 'Member mode')
            require(member.mtime == member.uid == member.gid == 0
                    and member.uname == member.gname == '', 'Archive header')
            verify_bytes(archive.extractfile(member).read(), item)
            seen.add(member.name)
    require(seen == selected.keys(), 'Missing archive member')
    return {'verifiedFiles': len(seen), 'archiveSha256': sha256(data), 'archiveBytes': len(data)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['build', 'verify'])
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    manifest = json.loads((PACKAGE / 'archive-manifest.json').read_text())
    if args.operation == 'build':
        retained = json.loads((PACKAGE / 'retained-files.json').read_text())
        result = build_archive(args.archive, manifest, retained)
    else:
        result = verify_archive(args.archive, manifest)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
