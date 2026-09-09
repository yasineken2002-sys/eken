"""Own isolated PostgreSQL + sanitized Node process; no env files/DSN/installs."""
import argparse
import hashlib
import gzip
import json
import os
import subprocess
from pathlib import Path

from tillgodo_pg import Postgres, ROOT

BASE='c6457aa00f027baa685d7e9b6ec28e8aa264c8e4'
SOURCE=['apps/api/src/reconciliation/reconciliation.service.ts',
        'apps/api/src/reconciliation/ocr-proveniens.ts','apps/api/src/psd2/psd2-sync.service.ts',
        'apps/api/src/psd2/psd2.types.ts','apps/api/src/psd2/providers/mock-bank-data.provider.ts',
        'apps/api/src/psd2/psd2-provider.factory.ts','packages/shared/src/utils/index.ts',
        'apps/api/prisma/schema.prisma','apps/api/prisma/migrations/20260707100000_psd2_p1_external_id_dedup/migration.sql']
sha=lambda value:hashlib.sha256(value).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    out=args.out.resolve()
    assert out.is_relative_to(Path('/tmp')) or out.is_relative_to(ROOT/'docs/eval/bankimport-identitet')
    assert not out.exists() or (out.is_dir() and not any(out.iterdir())), 'Use a new empty output directory'
    out.mkdir(parents=True,exist_ok=True)
    for file in ('indata.json','facit.json'):
        p='docs/eval/bankimport-identitet/'+file
        assert (ROOT/p).read_bytes()==subprocess.check_output(['git','show','9cd60f8d:'+p],cwd=ROOT),p
    for file in ('tillagg-indata.json','tillagg-facit.json'):
        p='docs/eval/bankimport-identitet/'+file
        assert (ROOT/p).read_bytes()==subprocess.check_output(['git','show','004407e4:'+p],cwd=ROOT),p
    # Exact immutable source baseline before invoking a production method.
    for path in SOURCE:
        assert (ROOT/path).read_bytes()==subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT),path
    paths=subprocess.check_output(['git','ls-tree','-r','--name-only',BASE,'--','docs/eval'],cwd=ROOT,text=True).splitlines()
    historic={}
    for path in paths:
        before=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
        assert (ROOT/path).read_bytes()==before,path
        historic[path]=sha(before)
    pg=Postgres()
    try:
        pg.start() # asserts empty DB, own label, network none, Unix socket, tmpfs
        config={'container':pg.container,'output':str(out/'observationer.json')}
        result=subprocess.run(['node','--max-old-space-size=384','--experimental-vm-modules',
                str(ROOT/'apps/api/scripts/eval_bankimport.cjs')],
            input=json.dumps(config),text=True,cwd=ROOT,capture_output=True,
            env={'PATH':os.environ['PATH'],'LANG':'C.UTF-8','TZ':'UTC'})
        (out/'korning.txt').write_text(result.stdout+result.stderr)
        print(result.stdout,end='');print(result.stderr,end='')
        assert result.returncode==0,'Harness execution failed; see korning.txt, not a product verdict'
        compact=json.dumps(json.loads((out/'observationer.json').read_text()),ensure_ascii=False,separators=(',',':')).encode()
        (out/'observationer.json.gz').write_bytes(gzip.compress(compact,mtime=0))
        (out/'observationer.json').unlink() # Only this invocation's own intermediate file.
        scripts=list((ROOT/'apps/api/scripts').glob('*bankimport*'))
        scripts += [ROOT/'apps/api/scripts/tillgodo_pg.py']
        fixtures=list((ROOT/'docs/eval/bankimport-identitet').glob('*.json'))
        manifest={'base':BASE,'headAtRun':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'database':pg.identity,'sourceHashes':{p:sha((ROOT/p).read_bytes()) for p in SOURCE},
            'harnessHashes':{p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in scripts+fixtures if p.is_file()},
            'historicalHashes':historic,'observationsUncompressedSha256':sha(compact),
            'observationsGzipSha256':sha((out/'observationer.json.gz').read_bytes())}
        (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    finally:pg.close()


if __name__=='__main__':main()
