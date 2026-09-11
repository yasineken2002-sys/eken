"""Rasterize actual raw before/after PDFs; preserve every page and exact PNG hashes."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent
output = root / 'visual-after-proof-4'
output.mkdir(exist_ok=False)
records = []
for before in sorted((root / 'before-final-1').glob('*.pdf')):
    pair = []
    for label, source in [('before', before), ('after', root / 'after-proof-4/process-1/run-1' / before.name)]:
        directory = output / label
        directory.mkdir(exist_ok=True)
        prefix = directory / before.stem
        subprocess.run(['pdftoppm', '-r', '95', '-png', str(source), str(prefix)], check=True)
        pages = sorted(directory.glob(before.stem + '-*.png'))
        pair.append(pages)
    assert len(pair[0]) == len(pair[1]) and pair[0]
    for a, b in zip(*pair):
        ha = hashlib.sha256(a.read_bytes()).hexdigest()
        hb = hashlib.sha256(b.read_bytes()).hexdigest()
        records.append({'document': before.stem, 'before': str(a.relative_to(root)),
                        'after': str(b.relative_to(root)), 'beforeSha256': ha,
                        'afterSha256': hb, 'identicalRaster': ha == hb})
        assert ha == hb, before.name + ': visible raster differs'
(output / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
print(json.dumps({'documents': len(set(r['document'] for r in records)),
                  'pages': len(records), 'identicalRasters': sum(r['identicalRaster'] for r in records)}))
