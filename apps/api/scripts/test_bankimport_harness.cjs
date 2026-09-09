// Harness controls only. Product-compliance diagnostics are separate JSON/MD.
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadProduction,CentDecimal}=require('./bankimport_loader.cjs');
const {Repository}=require('./bankimport_repository.cjs');

test('actual method modules load with only exact decorator removal',async()=>{
  const p=await loadProduction();
  assert.equal(typeof p.ReconciliationService.prototype.ingestFromApi,'function');
  assert.equal(typeof p.ReconciliationService.prototype.ingestFromFile,'function');
  assert.equal(typeof p.Psd2SyncService.prototype.syncOrganization,'function');
  assert.equal(p.normalizeToStockholmDay(new Date('2026-09-01T22:30:00Z')).toISOString(),'2026-09-02T00:00:00.000Z');
  assert.equal(p.sources['apps/api/src/reconciliation/reconciliation.service.ts'].edits.length,1);
  assert.equal(p.sources['apps/api/src/psd2/psd2-sync.service.ts'].edits.length,2);
  assert.deepEqual(p.forbidden,[]);
});

test('product catch cannot hide a forbidden dependency call from harness',async()=>{
  const p=await loadProduction();
  // In-memory repository only for this safety-boundary control. The 29 real
  // diagnostic cases use PostgreSQL and never this stub.
  const service={prisma:{bankTransaction:{create:async()=>({id:'guard-control'})}},
    matchTransaction:p.deny('NEGATIVE_CONTROL_MATCH_BOUNDARY')};
  const result=await p.ReconciliationService.prototype.ingestFromApi.call(service,'test-org-A','guard-id',{
    bookingDate:new Date('2026-09-01'),booked:true,currency:'SEK',amount:100,description:'synthetic'});
  assert.equal(result.outcome,'imported');
  assert.match(result.matchError.message,/FORBIDDEN_TEST_DEPENDENCY/);
  assert.deepEqual(p.forbidden,['NEGATIVE_CONTROL_MATCH_BOUNDARY']);
});

test('unsupported repository predicate is visible; no implicit file/org narrowing',()=>{
  const repo=Object.create(Repository.prototype);repo.forbidden=[];
  assert.equal(repo.whereBank({dedupKey:'x'}),"(dedup_key)='x'");
  assert.equal(repo.whereBank({externalId:{not:null}}),'(external_id) IS NOT NULL');
  assert.throws(()=>repo.whereBank({accountId:'A'}),/UNSUPPORTED_REPOSITORY/);
  assert.deepEqual(repo.forbidden,['repository:where:accountId']);
  assert.throws(()=>new Repository('not-a-container-id',[]));
});

test('test Decimal facade cannot silently accept unsupported precision',()=>{
  assert.equal(new CentDecimal('100.01').toFixed(2),'100.01');
  assert.throws(()=>new CentDecimal('100.001'));
  assert.throws(()=>new CentDecimal('NaN'));
  assert.throws(()=>new CentDecimal('1.00').toFixed(3));
});
