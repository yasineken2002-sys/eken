"""Save compact reproducible synthetic A/B evidence; no whole-2,000 metrics."""
import argparse
import gzip
import json
import subprocess
from pathlib import Path

from kundklarlaggning import FIXED, POLICY, ROOT, Postgres, Service, run_scenarios, sha


def main():
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    pg=Postgres()
    try:
        pg.start();s=Service(pg,FIXED).bootstrap();run_scenarios(s)
        snapshot=s.snapshot()
        # Random invitation hashes are never needed for recount or publication.
        for invitation in snapshot['cf_invitation']:
            invitation['token_hash']='OMITTED_RANDOM_SECRET_HASH'
        paths=[POLICY.relative_to(ROOT).as_posix()]
        paths += [p.relative_to(ROOT).as_posix() for p in (ROOT/'apps/api/scripts').glob('*kundklarlaggning*') if p.is_file()]
        paths += [p.relative_to(ROOT).as_posix() for p in (ROOT/'apps/api/scripts/kundklarlaggning_demo').iterdir()]
        paths += ['apps/api/scripts/tillgodo_pg.py','apps/api/scripts/tillgodo_experiment.sql',
                  'docs/eval/overskottsprov/korning-1/public-input.json.gz',
                  'docs/eval/identitetsgranskning-20/korning-1/fall.json']
        # Every original data/gold file is compared byte-for-byte to the base.
        originals=subprocess.check_output(['git','ls-tree','-r','--name-only','e4a72d3002c195e78c01baac4704a7326973547e',
            '--','docs/eval/kundflode-2000','docs/eval/overskottsprov','docs/eval/tillgodo-livscykel',
            'docs/eval/identitetsgranskning-20'],text=True,cwd=ROOT).splitlines()
        for path in originals:
            old=subprocess.check_output(['git','show','e4a72d3002c195e78c01baac4704a7326973547e:'+path],cwd=ROOT)
            assert (ROOT/path).read_bytes()==old,path
        result={'kind':'SYNTHETIC_CUSTOMER_CLARIFICATION_NOT_PRODUCTION', 'clock':FIXED.isoformat(),
                'database':pg.identity,'snapshot':snapshot,'whole2000Replay':False,
                'originalFilesVerifiedAgainstBase':{path:sha((ROOT/path).read_bytes()) for path in originals},
                'sourceHashes':{path:sha((ROOT/path).read_bytes()) for path in sorted(set(paths))},
                'injectedNonFinancialDebtMutation':{'notice':'B-debt-changed-avi-1','deltaOre':-1,
                    'purpose':'Fault injection after invitation; not a second financial operation or reconciliation proof'},
                'separateHistoricalCredit':json.loads(POLICY.read_text())['originalMetricsRemainHistorical']}
        raw=json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
        (args.out/'resultat.json.gz').write_bytes(gzip.compress(raw,mtime=0))
        (args.out/'manifest.json').write_text(json.dumps({'uncompressedSha256':sha(raw),
            'bytesUncompressed':len(raw),'originalFilesUnchanged':len(originals),
            'sourceHashes':result['sourceHashes']},ensure_ascii=False,indent=2)+'\n')
        print('Saved isolated PostgreSQL evidence:',args.out,'bytes:',len(raw))
    finally:pg.close()


if __name__=='__main__':main()
