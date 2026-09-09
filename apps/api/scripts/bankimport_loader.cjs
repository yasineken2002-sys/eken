// Executes repository TypeScript, never a rewritten dedup/sync algorithm.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {stripTypeScriptTypes} = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../../..');
const RECON = 'apps/api/src/reconciliation/reconciliation.service.ts';
const SYNC = 'apps/api/src/psd2/psd2-sync.service.ts';
const OCR = 'apps/api/src/reconciliation/ocr-proveniens.ts';
const SHARED = 'packages/shared/src/utils/index.ts';
const MOCK = 'apps/api/src/psd2/providers/mock-bank-data.provider.ts';
const TYPES = 'apps/api/src/psd2/psd2.types.ts';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Narrow boundary replacement: target methods only call constructor/toFixed(2).
// Not Prisma Decimal; no floating-point/rounding certification is claimed.
class CentDecimal {
  constructor(value) {
    const s=String(value);
    assert.match(s,/^-?\d+(\.\d{1,2})?$/,'Only finite two-decimal fixture values');
    const sign=s.startsWith('-')?-1n:1n;
    const [whole,frac='']=s.replace('-','').split('.');
    this.ore=sign*(BigInt(whole)*100n+BigInt(frac.padEnd(2,'0')));
  }
  toFixed(digits) {
    assert.equal(digits,2);
    const n=this.ore<0?-this.ore:this.ore;
    return (this.ore<0?'-':'')+(n/100n).toString()+'.'+(n%100n).toString().padStart(2,'0');
  }
  toJSON() {return this.toFixed(2);}
}
class SqlUniqueError extends Error {
  constructor() {super('ISOLATED_SQL_UNIQUE_23505');this.code='P2002';}
}

async function loadProduction() {
  const forbidden=[],logs=[],sources={},cache=new Map();
  const deny=label=>(..._args)=>{forbidden.push(label);throw Error('FORBIDDEN_TEST_DEPENDENCY:'+label);};
  const context=vm.createContext({Buffer,Date,console:{log:deny('console.log')},
    fetch:deny('fetch'),process:undefined}, {codeGeneration:{strings:false,wasm:false}});
  const pure=new Set([RECON,SYNC,OCR,SHARED,MOCK,TYPES]);
  function synthetic(key,values) {
    if(cache.has(key))return cache.get(key);
    const module=new vm.SyntheticModule(Object.keys(values),function(){
      for(const [name,value] of Object.entries(values))this.setExport(name,value);
    },{context,identifier:key});cache.set(key,module);return module;
  }
  function stubs(spec,names) {
    const values=Object.fromEntries(names.map(n=>[n,deny(spec+':'+n)]));
    return synthetic('blocked:'+spec,values);
  }
  const importNames=(text,spec)=>{
    const result=[];
    for(const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if(match[2]===spec)for(const n of match[1].split(','))if(n.trim())result.push(n.trim().split(/\s+as\s+/)[0]);
    }
    return result;
  };
  const nest={Injectable:deny('Nest Injectable decorator'),Inject:deny('Nest Inject decorator'),
    Logger:class {log(x){logs.push({level:'log',message:x});}warn(x){logs.push({level:'warn',message:x});}error(x){logs.push({level:'error',message:x});}},
    BadRequestException:Error,ConflictException:Error,NotFoundException:Error,ForbiddenException:Error,InternalServerErrorException:Error};
  const blockedSpecifiers=new Set([
    '../common/prisma/prisma.service','../invoices/invoices.service','../invoices/invoice-debt',
    '../invoices/invoice-payment-status','../invoices/invoice-payment-reversal','../invoices/invoice-events.service',
    '../accounting/accounting.service','../payment-freshness/payment-freshness.service',
    '../avisering/rent-debt.service','../common/utils/rent-notice-total.util','../avisering/rent-notice-events.service',
    './ocr-identity','../ai/shadow/payment/payment-shadow.queue','../ai/shadow/payment/payment-outcome.service',
    '../ai/shadow/payment/payment-shadow.types','../common/queue/enqueue-safety','./partial-match-identity',
    '../common/utils/file-validation','./bank-transaction-views','../common/prisma/transaction-limits',
    './bank-consent-crypto.service',
  ]);
  async function moduleFor(file) {
    if(cache.has(file))return cache.get(file);
    assert(pure.has(file),'Unapproved source module: '+file);
    const original=fs.readFileSync(path.join(ROOT,file),'utf8');
    let prepared=original;const edits=[];
    if(file===RECON||file===SYNC) {
      assert.equal((original.match(/^@Injectable\(\)$/gm)||[]).length,1);
      prepared=prepared.replace(/^@Injectable\(\)\r?\n/m,'');edits.push('one exact @Injectable() line');
    }
    if(file===SYNC) {
      const exact='@Inject(PSD2_PROVIDER) private readonly provider: BankDataProvider';
      assert.equal(prepared.split(exact).length,2);
      prepared=prepared.replace(exact,'private readonly provider: BankDataProvider');edits.push('one exact @Inject(PSD2_PROVIDER) parameter decorator');
    }
    const code=stripTypeScriptTypes(prepared,{mode:'transform'});
    sources[file]={sha256:hash(original),preparedSha256:hash(prepared),transformedSha256:hash(code),edits};
    const module=new vm.SourceTextModule(code,{context,identifier:file,
      importModuleDynamically:()=>{forbidden.push('dynamic import');throw Error('DYNAMIC_IMPORT_DENIED');}});
    cache.set(file,module);
    await module.link(async(spec)=>{
      if(spec==='crypto')return synthetic('crypto', {createHash:crypto.createHash});
      if(spec==='@nestjs/common')return synthetic('nest',nest);
      if(spec==='@prisma/client/runtime/library')return synthetic('decimal',{Decimal:CentDecimal});
      if(spec==='@prisma/client')return synthetic('prisma',{Prisma:{PrismaClientKnownRequestError:SqlUniqueError},RentNoticeType:{}});
      if(spec==='xlsx')return synthetic('xlsx',{read:deny('xlsx.read'),utils:{},SSF:{parse_date_code:deny('xlsx.date')}});
      if(spec==='./ocr-proveniens')return moduleFor(OCR);
      if(spec==='@eken/shared')return moduleFor(SHARED);
      if(spec==='../reconciliation/reconciliation.service')return moduleFor(RECON);
      if(spec==='./psd2.types')return moduleFor(TYPES);
      if(file===SHARED&&spec==='../constants')return synthetic('constants',{LOCALE:'sv-SE',CURRENCY:'SEK'});
      // Unused export-stars of the utils barrel are deliberately not traversed.
      if(file===SHARED&&['./swedish-org-number','./group-sent-messages'].includes(spec))return synthetic(spec,{});
      if(blockedSpecifiers.has(spec))return stubs(spec,importNames(code,spec));
      forbidden.push('import:'+spec);throw Error('IMPORT_DENIED:'+spec);
    });
    return module;
  }
  const recon=await moduleFor(RECON);await recon.evaluate();
  const sync=await moduleFor(SYNC);await sync.evaluate();
  const mock=await moduleFor(MOCK);await mock.evaluate();
  return {ReconciliationService:recon.namespace.ReconciliationService,
    computeBankDedupKey:recon.namespace.computeBankDedupKey,
    normalizeToStockholmDay:recon.namespace.normalizeToStockholmDay,
    Psd2SyncService:sync.namespace.Psd2SyncService,MockBankDataProvider:mock.namespace.MockBankDataProvider,
    forbidden,logs,sources,deny};
}

module.exports={ROOT,hash,CentDecimal,SqlUniqueError,loadProduction};
