"""Actual Prisma/PG study. Refuses every endpoint except the dedicated local container.
Requires psycopg2, generated old Prisma client, and built workspace dependencies.
No production URL, source rows or migration edits are accepted.
"""
import os, sys, json, time, shutil, tempfile, subprocess, threading, signal, hashlib
from pathlib import Path
import psycopg2
from psycopg2 import sql

ROOT = Path(__file__).resolve().parents[4]
BASE = 'e483daaf169fefc067c8f952c3ee0f12d4a7fdc5'
PRISMA = ROOT / 'apps/api/node_modules/prisma/build/index.js'
OLD = ROOT / 'apps/api/test-fixtures/release/old-api.test-fixtures.cjs'
URL = 'postgresql://postgres:synthetic-release-only@127.0.0.1:55483/'
MIGRATIONS = [
 ('861','46c77508c52b38439b26cb47b8815991301fec88','20260908203000_meter_reading_review','MeterReading'),
 ('864','82e4c4a0bfd022dd6855d553d6ea8b301e351c41','20260909090000_consumption_review_follow_up','Organization'),
 ('877','9f879291dd039e404ba80b7266fbd53842a0b42b','20260910160000_consumption_charge_gate','MeterReading'),
 ('878','0973272d5eb8f6f8285ec8c98f039a47f6ec568b','20260911120000_delivery_decisions','RentNotice'),
 ('879','5ae9906b152307eae0d79eec719d4303a042742c','20260911150000_delivery_execution','DeliveryEvent'),
]
TEMP = Path(tempfile.mkdtemp(prefix='api-release-prisma-'))
PREFIX = 'api_release_' + str(int(time.time())) + '_'
RESULT = {'base': BASE, 'synthetic_only': True, 'poll_seconds': 0.005, 'rounds': []}
def connect(db, name='study'):
 assert db.startswith('api_release_')
 c=psycopg2.connect(URL+db,application_name=name,connect_timeout=5)
 c.autocommit=True
 return c
admin=psycopg2.connect(URL+'postgres',connect_timeout=5);admin.autocommit=True
def database(name, template=None):
 assert name.startswith('api_release_')
 with admin.cursor() as c:
  c.execute('SELECT 1 FROM pg_database WHERE datname=%s',(name,))
  assert c.fetchone() is None, 'database exists; never reset an existing database'
  q=sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name))
  if template: q+=sql.SQL(' TEMPLATE {}').format(sql.Identifier(template))
  c.execute(q)
def env(db):
 return {**os.environ,'DATABASE_URL':URL+db,'PRISMA_HIDE_UPDATE_MESSAGE':'true'}
def bundle(count):
 target=TEMP/str(count)
 if target.exists(): return target
 target.mkdir();shutil.copytree(ROOT/'apps/api/prisma/migrations',target/'migrations')
 (target/'schema.prisma').write_bytes(subprocess.check_output(['git','show',BASE+':apps/api/prisma/schema.prisma'],cwd=ROOT))
 for _,head,name,_ in MIGRATIONS[:count]:
  p=target/'migrations'/name;p.mkdir()
  p.joinpath('migration.sql').write_bytes(subprocess.check_output(['git','show',head+':apps/api/prisma/migrations/'+name+'/migration.sql'],cwd=ROOT))
 return target
def start(db,count):
 return subprocess.Popen(['node',str(PRISMA),'migrate','deploy','--schema',str(bundle(count)/'schema.prisma')],cwd=TEMP,env=env(db),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
def finish(p):
 output=p.communicate(timeout=35)[0]
 return {'exit':p.returncode,'codes':[code for code in ['P1002','P3009','P3018','55P03','40P01','57P01'] if code in output], 'output':output[-3500:]}
def apply(db,count):
 r=finish(start(db,count));assert r['exit']==0,r
 return r
def rows(db):
 with connect(db) as c,c.cursor() as q:
  result={}
  for table in ['Organization','Meter','MeterReading','ConsumptionCharge','Invoice','RentNotice']:
   q.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table)));result[table]=q.fetchone()[0]
  return result
def catalog(db):
 with connect(db) as c,c.cursor() as q:
  queries={
   'relations':"SELECT relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace AND relname NOT LIKE '_prisma%' ORDER BY 1",
   'columns':"SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname<>'_prisma_migrations' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2",
   'indexes':"SELECT c.relname,indisvalid,indisready,pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND c.relname NOT LIKE '_prisma%' ORDER BY 1",
   'constraints':"SELECT conname,convalidated,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname NOT LIKE '_prisma%' ORDER BY 1,3",
   'triggers':"SELECT tgname,tgenabled,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY 1,3",
   'functions':"SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname,prosrc",
  }
  result={}
  for k,statement in queries.items(): q.execute(statement);result[k]=q.fetchall()
  q.execute('SELECT migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NOT NULL,applied_steps_count FROM "_prisma_migrations" WHERE migration_name >= %s ORDER BY migration_name,started_at',('20260908203000',))
  return {'digest':hashlib.sha256(json.dumps(result,default=str).encode()).hexdigest(),'counts':{k:len(v) for k,v in result.items()},'invalidIndexes':[r for r in result['indexes'] if not r[1] or not r[2]],'unvalidated':[r for r in result['constraints'] if not r[1]],'migrations':q.fetchall()}
def blocker(db,table):
 c=connect(db,'old-api-blocker');c.autocommit=False;q=c.cursor()
 if table in ['Organization','DeliveryEvent']: q.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table)))
 else: q.execute(sql.SQL('UPDATE {} SET id=id WHERE false').format(sql.Identifier(table)))
 return c
LOCK_SQL="""SELECT a.pid,l.locktype,COALESCE(c.relname,''),l.mode,l.granted,pg_blocking_pids(a.pid)
FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid LEFT JOIN pg_class c ON c.oid=l.relation
WHERE a.datname=current_database() AND a.application_name NOT LIKE '%%study%%' AND a.application_name<>'old-api-blocker'
AND (l.locktype='advisory' OR (c.relnamespace='public'::regnamespace AND c.relname<>'_prisma_migrations'))"""
def scenario(db,count,kind):
 table=MIGRATIONS[count-1][3];before=catalog(db)
 old_process=None
 if kind=='normal':
  old_process=subprocess.Popen(['node',str(OLD),'concurrent'],cwd=ROOT,env=env(db),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  assert old_process.stdout.readline().strip()=='READY','old API did not reach concurrent probe'
 if kind=='timeout':
  with admin.cursor() as q:q.execute(sql.SQL("ALTER DATABASE {} SET lock_timeout='400ms'").format(sql.Identifier(db)))
 hold=blocker(db,table);observer=connect(db,'study-observer');q=observer.cursor()
 t0=time.monotonic();p=start(db,count);samples=[];first_wait=None;action_at=None;released=False
 worker_results=[];workers=[]
 def traffic(statement,label):
  c=connect(db,'study-traffic');t=time.monotonic()
  try:
   with c.cursor() as cursor:cursor.execute("SET statement_timeout='5000ms'");cursor.execute(statement)
   worker_results.append({'operation':label,'ms':round((time.monotonic()-t)*1000,3),'success':True})
  except psycopg2.Error as e:worker_results.append({'operation':label,'ms':round((time.monotonic()-t)*1000,3),'success':False,'code':e.pgcode})
  finally:c.close()
 while p.poll() is None:
  q.execute(LOCK_SQL); locks=q.fetchall();now=time.monotonic();samples.append((now-t0,locks))
  waiting=[r for r in locks if not r[4] and r[2]==table]
  if waiting and first_wait is None:
   first_wait=now
   if kind=='normal':
    old_process.stdin.write('GO\n');old_process.stdin.flush()
    for statement,label in [(f'SELECT count(*) FROM "{table}"','read'),(f'UPDATE "{table}" SET id=id WHERE false','write')]:
     thread=threading.Thread(target=traffic,args=(statement,label));thread.start();workers.append(thread)
   if kind=='terminate':q.execute('SELECT pg_terminate_backend(%s)',(waiting[0][0],));action_at=now
   if kind=='interrupt':os.killpg(p.pid,signal.SIGTERM);action_at=now
  if first_wait and not released and ((kind=='normal' and now-first_wait>0.3) or (kind!='normal' and now-first_wait>0.6)):
   hold.rollback();hold.close();released=True;action_at=now
  assert now-t0<30,'scenario stalled'
  time.sleep(0.005)
 end=time.monotonic()
 if not released:hold.rollback();hold.close()
 result=finish(p)
 old_result=None
 if old_process:
  old_stdout,old_stderr=old_process.communicate(timeout=15)
  assert old_process.returncode==0,old_stderr
  old_result=json.loads(old_stdout.strip())
 for thread in workers:thread.join()
 # Processens exit räcker inte: vänta tills just DB:ns Prisma-lås är borta.
 for _ in range(200):
  q.execute(LOCK_SQL);remaining=q.fetchall()
  if not remaining:break
  time.sleep(0.01)
 q.close();observer.close()
 assert first_wait is not None,'no observed lock wait'
 after=catalog(db);retry=finish(start(db,count));after_retry=catalog(db)
 wait_samples=[t for t,rs in samples if any(not r[4] and r[2]==table for r in rs)]
 grant_samples=[t for t,rs in samples if any(r[4] and r[2]==table and r[3] not in ['AccessShareLock','RowExclusiveLock'] for r in rs)]
 lock_modes=sorted(set((r[1],r[2],r[3],r[4],bool(r[5])) for _,rs in samples for r in rs))
 entry={'kind':kind,'database':db,'pr':MIGRATIONS[count-1][0],'total_ms':round((end-t0)*1000,3),'observed_wait_ms':round((max(wait_samples)-min(wait_samples))*1000,3),'observed_grant_span_ms':round((max(grant_samples)-min(grant_samples))*1000,3) if grant_samples else None,'grant_upper_bound_ms':round((end-(action_at or end))*1000,3) if kind=='normal' else None,'lock_modes':lock_modes,'traffic':worker_results,'exit':result['exit'],'codes':result['codes'],'catalog_before':before,'catalog_after':after,'retry_exit':retry['exit'],'retry_codes':retry['codes'],'catalog_after_retry':after_retry,'rows':rows(db)}
 if kind=='normal':
  assert result['exit']==retry['exit']==0 and before['digest']!=after['digest'] and after['digest']==after_retry['digest']
  entry['concurrent_old_api']=old_result
 else:
  assert result['exit']!=0,entry
  if kind in ['timeout','terminate']:assert before['digest']==after['digest'],entry
  entry['sql_rolled_back'] = before['digest']==after['digest']
 return entry
def competition(db):
 hold=blocker(db,'MeterReading');observer=connect(db,'study-observer');q=observer.cursor();p1=start(db,5);p2=start(db,5);seen=[];t=time.monotonic()
 while time.monotonic()-t<4:
  q.execute(LOCK_SQL);rs=q.fetchall();seen+=rs
  if any(r[1]=='advisory' and not r[4] and r[5] for r in rs) and any(r[2]=='MeterReading' and not r[4] for r in rs):break
  time.sleep(0.01)
 assert any(r[1]=='advisory' and not r[4] for r in seen),'no Prisma advisory contention observed'
 hold.rollback();hold.close();r1=finish(p1);r2=finish(p2);q.close();observer.close()
 assert r1['exit']==r2['exit']==0,(r1,r2)
 return {'database':db,'exits':[r1['exit'],r2['exit']],'advisory_wait_proven':True,'catalog':catalog(db),'rows':rows(db)}
def run():
 for round_name in ['a','b']:
  base=PREFIX+round_name;database(base);apply(base,0)
  subprocess.run(['node',str(OLD),'seed'],cwd=ROOT,env=env(base),check=True,capture_output=True)
  original=rows(base);assert original=={'Organization':2,'Meter':1,'MeterReading':0,'ConsumptionCharge':0,'Invoice':0,'RentNotice':2}
  report={'clean_database':base,'before':original,'files':[],'scenarios':[]}
  RESULT['rounds'].append(report)
  for i,(_,head,name,_) in enumerate(MIGRATIONS,1):
   # Varje felprov börjar i ett orört prefix av de faktiska migrationerna.
   for kind in ['normal','timeout','terminate','interrupt']:
    db=f'{PREFIX}{round_name}_{i}_{kind}';database(db,base)
    report['scenarios'].append(scenario(db,i,kind))
    print(round_name,i,kind,report['scenarios'][-1]['exit'],flush=True)
   apply(base,i)
   data=(bundle(i)/'migrations'/name/'migration.sql').read_bytes()
   report['files'].append({'migration':name,'pr_head':head,'sha256':hashlib.sha256(data).hexdigest(),'after':catalog(base)})
  report['after_migrations']=rows(base);assert report['after_migrations']==original
  report['old_api']=subprocess.run(['node',str(OLD),'probe'],cwd=ROOT,env=env(base),check=True,capture_output=True,text=True).stdout
  report['after_old_api']=rows(base)
  db=f'{PREFIX}{round_name}_competition';database(db);apply(db,0)
  subprocess.run(['node',str(OLD),'seed'],cwd=ROOT,env=env(db),check=True,capture_output=True)
  report['competition']=competition(db)
  Path('/tmp/api-release-migration-results.json').write_text(json.dumps(RESULT,default=str,indent=2))
 run_end=time.time();RESULT['completed_unix']=run_end
 Path('/tmp/api-release-migration-results.json').write_text(json.dumps(RESULT,default=str,indent=2))
 print('Two clean rounds completed',flush=True)
try:run()
except Exception:
 Path('/tmp/api-release-migration-partial.json').write_text(json.dumps(RESULT,default=str,indent=2));raise
