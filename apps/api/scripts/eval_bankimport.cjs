// Explicit diagnostic entry point. Product violations are report data, not
// deliberately failing ordinary CI tests. Harness/isolation faults do fail.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {ROOT,hash,CentDecimal,loadProduction}=require('./bankimport_loader.cjs');
const {Repository,plain}=require('./bankimport_repository.cjs');

async function main() {
  const config=JSON.parse(fs.readFileSync(0,'utf8'));
  assert.deepEqual(Object.keys(config).sort(),['container','output']);
  const rawInputs=fs.readFileSync(path.join(ROOT,'docs/eval/bankimport-identitet/indata.json'));
  const inputs=JSON.parse(rawInputs);
  // This executable NEVER opens facit.json or reads expected case outcomes.
  const prod=await loadProduction();const cases=[];
  for(const scenario of inputs.cases) {
    const repo=new Repository(config.container,prod.forbidden);
    const downstream=[],queue=[],calls=[],providerCalls=[],rounds=[];
    const unused=new Proxy({}, {get:(_target,key)=>prod.deny('unused dependency:'+String(key))});
    const service=new prod.ReconciliationService(repo,unused,unused,unused,unused,unused,unused,unused);
    let fault='none';
    service.matchTransaction=async(row,organizationId)=>{
      downstream.push({organizationId,row:plain(row),injectedError:fault==='throw'});
      if(fault==='throw')throw Error('INJECTED_SYNTHETIC_MATCH_ERROR');
      return false;
    };
    service.köaSkuggförslag=async(organizationId,bankTransactionId)=>{queue.push({organizationId,bankTransactionId});};
    const realApi=prod.ReconciliationService.prototype.ingestFromApi;
    service.ingestFromApi=async(org,externalId,raw)=>{
      const call={method:'ingestFromApi',org,externalId,raw:plain(raw)};calls.push(call);
      try {const result=await realApi.call(service,org,externalId,raw);
        call.result=plain(result);if(result.matchError)call.result.matchError=result.matchError.message;
        return result;
      } catch(error) {call.error=String(error.message);throw error;}
    };
    if(scenario.kind==='ingest') {
      for(const step of scenario.steps) {
        fault=step.downstream||'none';
        if(step.kind==='api')await service.ingestFromApi(step.org,step.externalId,
          {...step.raw,bookingDate:new Date(step.raw.bookingDate)});
        else {
          assert.equal(step.kind,'file');
          const date=new Date(step.date);const amount=new CentDecimal((step.amountOre/100).toFixed(2));
          const input={dedup:{date,description:step.description,amount},
            data:{date,description:step.description,amount,reference:step.reference,rawOcr:step.rawOcr},
            crossSource:{date,amount,ocr:step.rawOcr}};
          const call={method:'ingestFromFile',org:step.org,input:plain(input)};calls.push(call);
          const result=await prod.ReconciliationService.prototype.ingestFromFile.call(service,step.org,input);
          call.result=plain(result);if(result.matchError)call.result.matchError=result.matchError.message;
        }
      }
    } else {
      assert.equal(scenario.kind,'sync');
      repo.seedConsents(scenario.organizations);
      const provider=new prod.MockBankDataProvider();
      provider.accounts=scenario.accounts.map(accountId=>({accountId,currency:'SEK'}));
      let failureRemaining=scenario.failOnce?1:0;
      // Current Mock's account/status functions run. Fetch is replaced by this
      // contract interpreter; it responds to actual since/account arguments.
      provider.fetchTransactions=async(input)=>{
        assert.equal(input.accessToken,'SYNTHETIC_NO_SECRET');
        const call={consentId:input.consentId,accountId:input.accountId,since:input.since??null};providerCalls.push(call);
        if(input.accountId===scenario.failOnce&&failureRemaining>0) {
          failureRemaining--;call.error='INJECTED_ACCOUNT_TRANSPORT_ERROR';throw Error(call.error);
        }
        const key=input.since??'START';const page=scenario.pages[input.accountId]?.[key];
        if(!page) {call.error='HYPOTHETICAL_CURSOR_SCOPE_MISMATCH';throw Error(call.error);}
        const result={transactions:page.transactions.map(tx=>({...tx,bookingDate:new Date(tx.bookingDate)})),cursor:page.cursor};
        call.result=plain(result);return result;
      };
      const crypto={decrypt:value=>{assert.equal(value,'SYNTHETIC_NO_SECRET');return 'SYNTHETIC_NO_SECRET';}};
      const sync=new prod.Psd2SyncService(repo,service,crypto,provider);
      for(let round=0;round<scenario.rounds;round++)for(const org of scenario.organizations) {
        const observation={round:round+1,org};rounds.push(observation);
        try {observation.result=plain(await sync.syncOrganization(org));}
        catch(error) {observation.error=String(error.message);}
        // Includes partial state after a thrown sync, not invented zero counters.
        observation.snapshot=repo.snapshot();
      }
    }
    assert.deepEqual(prod.forbidden,[],'Forbidden calls cannot be hidden by product catch blocks');
    cases.push({id:scenario.id,calls,providerCalls,rounds,downstream,queue,
      repositoryTrace:repo.trace,snapshot:repo.snapshot()});
    process.stderr.write('Captured '+scenario.id+' (product compliance not asserted here)\n');
  }
  const day=prod.normalizeToStockholmDay(new Date('2026-09-01T22:30:00Z'));
  const key=prod.computeBankDedupKey(day,new CentDecimal('100.00'),'00123459');
  const result={kind:'ACTUAL_PRODUCTION_METHOD_DIAGNOSTIC_WITH_REPLACED_BOUNDARIES',
    node:process.version,inputSha256:hash(rawInputs),sourceModules:prod.sources,forbidden:prod.forbidden,
    dedupProbe:{instant:'2026-09-01T22:30:00Z',stockholmDay:day.toISOString(),amount:'100.00',ocr:'00123459',key},
    layers:{actual:['TypeScript production methods','OCR helpers','Mock provider account/status methods','PostgreSQL predicates and UNIQUE'],
      replaced:['Nest decorators/DI','Prisma client repository mapping','Decimal cent facade','SQL 23505 to P2002 class facade',
        'provider fetch cursor contracts','token decryption with synthetic constant','matchTransaction observer false/error','shadow queue boundary observer'],
      notRun:['whole app','actual provider network','CSV/Excel/BgMax/PDF parser','real match/allocation/accounting','Redis','real Prisma extensions or migrations']},
    cases};
  fs.writeFileSync(config.output,JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify({harness:'CAPTURE_COMPLETE',cases:cases.length,forbidden:prod.forbidden.length,
    product:'NOT_ASSERTED_USE_INDEPENDENT_RECOUNT'})+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
