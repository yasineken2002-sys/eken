// SQL boundary adapter, not PrismaClient. PostgreSQL evaluates every received
// predicate and the real org/externalId unique constraint. Never computes dedup.
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');
const {CentDecimal,SqlUniqueError}=require('./bankimport_loader.cjs');
const DB='eveno_tillgodo_test';
const literal=x=>"'"+String(x).replaceAll("'","''")+"'";
const nullableText=x=>x==null?'NULL':literal(x);
const json=x=>literal(JSON.stringify(x))+'::jsonb';
const plain=x=>JSON.parse(JSON.stringify(x));
const ownSchemas=new Set();

class Repository {
  constructor(container, forbidden) {
    assert.match(container,/^[a-f0-9]{64}$/);
    this.container=container;this.forbidden=forbidden;this.trace=[];this.counter=0;
    const inspect=spawnSync('docker',['inspect',container],{encoding:'utf8'});
    assert.equal(inspect.status,0,inspect.stderr);
    const info=JSON.parse(inspect.stdout)[0];
    assert.match(info.Name,/^\/eveno-credit-experiment-[a-f0-9]{12}$/);
    assert.equal(info.Config.Labels['eveno.experiment'],info.Name.slice(1));
    assert.equal(info.HostConfig.NetworkMode,'none');
    assert(!info.HostConfig.PortBindings||Object.keys(info.HostConfig.PortBindings).length===0);
    assert.equal(info.HostConfig.Memory,512*1024*1024);
    assert(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);
    assert.equal(info.Mounts.filter(m=>m.Type==='bind'||m.Type==='volume').length,0);
    this.schema='exp_bank_'+crypto.randomBytes(6).toString('hex');
    const identity=this.sql("SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),"
      +"'listen',current_setting('listen_addresses'),'tables',(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')));",false);
    assert.equal(identity.database,DB);assert.equal(identity.address,null);assert.equal(identity.listen,'');
    const schemas=this.sql("SELECT coalesce(jsonb_agg(DISTINCT schemaname ORDER BY schemaname),'[]') FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');",false);
    assert.deepEqual(schemas,[...ownSchemas].sort(),'Only schemas created by this process may exist');
    this.sql('CREATE SCHEMA '+this.schema+';',false);
    this.sql('CREATE TABLE bank(id text PRIMARY KEY,org text NOT NULL,external_id text,dedup_key text,'
      +'date timestamptz NOT NULL,amount numeric(12,2) NOT NULL,payload jsonb NOT NULL,UNIQUE(org,external_id));'
      +'CREATE INDEX ON bank(org,dedup_key);'
      +'CREATE TABLE consent(id text PRIMARY KEY,payload jsonb NOT NULL);'
      +'CREATE TABLE imports(id bigserial PRIMARY KEY,payload jsonb NOT NULL);');
    ownSchemas.add(this.schema);
    this.bankTransaction={findFirst:async q=>this.findBank(q),create:async q=>this.createBank(q)};
    this.bankConsent={findMany:async q=>this.findConsents(q),update:async q=>this.updateConsent(q)};
    this.bankStatementImport={create:async q=>this.createImport(q)};
  }
  fail(label) {this.forbidden.push('repository:'+label);throw Error('UNSUPPORTED_REPOSITORY:'+label);}
  sql(query,scoped=true) {
    const input='\\set VERBOSITY verbose\n'+(scoped?'SET search_path TO '+this.schema+',pg_catalog;\n':'')+query;
    const r=spawnSync('docker',['exec','-i','-e','PGAPPNAME=bankimport-offline',this.container,
      'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-U','postgres','-d',DB],
      {input,encoding:'utf8',maxBuffer:2*1024*1024,timeout:15000});
    if(r.error)throw r.error;
    if(r.status!==0) {
      if(/\b23505\b/.test(r.stderr))throw new SqlUniqueError();
      throw Error('ISOLATED_PG_ERROR:'+r.stderr.slice(0,800));
    }
    return r.stdout.trim()?JSON.parse(r.stdout.trim()):null;
  }
  record(method,query) {const entry={method,query:plain(query)};this.trace.push(entry);return entry;}
  whereBank(where) {
    const columns={organizationId:'org',externalId:'external_id',dedupKey:'dedup_key',id:'id',date:'date',amount:'amount',
      description:"payload->>'description'",rawOcr:"payload->>'rawOcr'"};
    return Object.entries(where).map(([field,value])=>{
      if(!Object.hasOwn(columns,field))return this.fail('where:'+field);
      const col='('+columns[field]+')';
      if(value===null)return col+' IS NULL';
      if(value&&typeof value==='object'&&!(value instanceof Date)&&!(value instanceof CentDecimal)) {
        if(Object.keys(value).length===1&&Object.hasOwn(value,'not')&&value.not===null)return col+' IS NOT NULL';
        return this.fail('where operator:'+field);
      }
      const str=value instanceof Date?value.toISOString():value instanceof CentDecimal?value.toFixed(2):value;
      return col+'='+literal(str)+(field==='date'?'::timestamptz':field==='amount'?'::numeric':'');
    }).join(' AND ')||'true';
  }
  findBank(query) {
    const trace=this.record('bankTransaction.findFirst',query);
    if(Object.keys(query).some(k=>!['where','select'].includes(k)))return this.fail('findBank options');
    const select=query.select;
    if(select&&JSON.stringify(select)!=='{"id":true}')return this.fail('findBank select');
    const predicate=this.whereBank(query.where);
    trace.sqlPredicate=predicate;
    const result=this.sql("SELECT coalesce((SELECT "+(select?"jsonb_build_object('id',id)":'payload')+
      ' FROM bank WHERE '+predicate+" ORDER BY id LIMIT 1),'null'::jsonb);");
    trace.result=plain(result);return result;
  }
  createBank(query) {
    const trace=this.record('bankTransaction.create',query);
    assert.deepEqual(Object.keys(query),['data']);
    const allowed=['organizationId','externalId','dedupKey','date','description','amount','balance','rawOcr','reference'];
    for(const key of Object.keys(query.data))if(!allowed.includes(key))return this.fail('create field:'+key);
    const d=plain(query.data);const id='row-'+(++this.counter);
    const payload={id,externalId:null,dedupKey:null,reference:null,rawOcr:null,balance:null,status:'UNMATCHED',...d};
    try {
      this.sql('INSERT INTO bank VALUES('+[literal(id),literal(d.organizationId),
        nullableText(d.externalId),nullableText(d.dedupKey),
        literal(d.date)+'::timestamptz',literal(d.amount)+'::numeric',json(payload)].join(',')+');');
      trace.createdId=id;return {...payload,date:new Date(d.date),amount:new CentDecimal(d.amount)};
    }catch(error) {
      trace.error=error instanceof SqlUniqueError?'SQLSTATE_23505_TO_P2002':String(error.message);
      throw error;
    }
  }
  seedConsents(orgs) {
    for(const [i,org] of orgs.entries()) {
      const p={id:'consent-'+i,organizationId:org,consentId:'synthetic-consent-'+i,
        status:'ACTIVE',accessTokenEnc:'SYNTHETIC_NO_SECRET',syncCursor:null};
      this.sql('INSERT INTO consent VALUES('+literal(p.id)+','+json(p)+');');
    }
  }
  findConsents(query) {
    const trace=this.record('bankConsent.findMany',query);
    if(Object.keys(query).join(',')!=='where')return this.fail('consent options');
    const predicates=Object.entries(query.where).map(([key,value])=>{
      if(!['organizationId','status'].includes(key)||typeof value!=='string')return this.fail('consent predicate');
      return '(payload->>'+literal(key)+')='+literal(value);
    });
    trace.sqlPredicate=predicates.join(' AND ');
    const rows=this.sql("SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') FROM consent WHERE "+trace.sqlPredicate+';');
    trace.ids=rows.map(x=>x.id);return rows;
  }
  updateConsent(query) {
    const trace=this.record('bankConsent.update',query);
    if(Object.keys(query.where).join(',')!=='id')return this.fail('consent update where');
    for(const key of Object.keys(query.data))if(!['lastSyncedAt','syncCursor','status','accessTokenEnc','refreshTokenEnc'].includes(key))return this.fail('consent update field');
    const result=this.sql('UPDATE consent SET payload=payload||'+json(query.data)+' WHERE id='+literal(query.where.id)+' RETURNING payload;');
    assert(result);trace.result=plain(result);return result;
  }
  createImport(query) {
    const trace=this.record('bankStatementImport.create',query);
    this.sql('INSERT INTO imports(payload) VALUES('+json(query.data)+');');
    trace.created=true;return query.data;
  }
  snapshot() {
    return this.sql("SELECT jsonb_build_object('rows',(SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') FROM bank),"
      +"'consents',(SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') FROM consent),"
      +"'imports',(SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') FROM imports));");
  }
}
module.exports={Repository,plain,nullableText};
