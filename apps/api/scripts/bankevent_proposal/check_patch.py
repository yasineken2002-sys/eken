"""Check text artifact, syntax and untouched production bytes. Never applies it."""
import hashlib
import json
import runpy
import subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
module=runpy.run_path(str(HERE/'build_patch.py'));ROOT=module['ROOT'];OUT=module['OUT'];BASE=module['BASE']
subprocess.run(['git','apply','--check',str(OUT/'kandidat.patch')],cwd=ROOT,check=True)
results=[]
for path,source in module['changes'].items():
    if module['old'][path]:
        assert (ROOT/path).read_text()==module['old'][path],('Production changed',path)
    else:assert not (ROOT/path).exists(),('Proposal applied',path)
    if not path.endswith('.ts'):continue
    # Native TS transform parses but does NOT typecheck, resolve imports, execute
    # decorators or run any proposed method. Text stays in stdin/stdout memory.
    script="import{stripTypeScriptTypes}from'node:module';let s='';for await(const c of process.stdin)s+=c;stripTypeScriptTypes(s,{mode:'transform'});"
    result=subprocess.run(['node','--disable-warning=ExperimentalWarning','--input-type=module','-e',script],input=source,text=True,capture_output=True)
    assert result.returncode==0,(path,result.stderr)
    results.append(path)
old=module['old']['apps/api/src/reconciliation/reconciliation.service.ts'];new=module['changes']['apps/api/src/reconciliation/reconciliation.service.ts']
# Existing OCR matching body and both allocation kernels unchanged except the
# explicit entry/transaction gates. No new target-selection or money algorithm.
a=old.index('    const tolerance =');b=old.index('  async getTransactions(',a)
na=new.index('    const tolerance =');nb=new.index('  async getTransactions(',na)
assert old[a:b]==new[na:nb].replace('      await lockIdentity(tx, organizationId, transactionId)\n','')
report={'kind':'UNAPPLIED_PATCH_SYNTAX_NOT_TYPES_OR_IMPORT_EXECUTION','base':BASE,
 'targetFiles':len(module['changes']),'typeSyntaxParsed':results,'gitApplyCheck':True,
 'productionTargetsUnchanged':True,'originalMatchingAndAllocationBodiesPreservedApartFromIdentityGate':True,
 'patchSha256':hashlib.sha256((OUT/'kandidat.patch').read_bytes()).hexdigest()}
(OUT/'patch-kontroll.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
