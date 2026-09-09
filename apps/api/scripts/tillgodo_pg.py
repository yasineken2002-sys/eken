"""Dedicated local Docker PostgreSQL only; never reads env/DSN or production DB."""
import json
import re
import subprocess
import time
import uuid
from pathlib import Path

DB = 'eveno_tillgodo_test'
ROOT = Path(__file__).resolve().parents[3]
TABLES = ('scope','notice','bank','credit','allocation','credit_use','voucher','operation')


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def call(payload, failpoint='', pause=0):
    return f"SELECT apply({literal(json.dumps(payload,ensure_ascii=False))}::jsonb,{literal(failpoint)},{pause});"


class Postgres:
    def __init__(self):
        self.name = 'eveno-credit-experiment-' + uuid.uuid4().hex[:12]
        self.container = None
        self.identity = None

    def start(self):
        # No pull, no ports, no external network, no mounted host directories.
        command = ['docker','run','--detach','--rm','--pull=never','--name',self.name,
            '--label','eveno.experiment='+self.name,'--network','none','--memory','512m','--cpus','1',
            '--shm-size','32m','--tmpfs','/var/lib/postgresql/data:rw,size=384m',
            '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB='+DB,
            'postgres:16-alpine','postgres','-c','listen_addresses=','-c','shared_buffers=16MB',
            '-c','max_connections=12','-c','fsync=on','-c','synchronous_commit=on']
        self.container = subprocess.check_output(command,text=True).strip()
        for _ in range(100):
            check = subprocess.run(['docker','exec',self.container,'pg_isready','-h','/var/run/postgresql','-d',DB],capture_output=True)
            pid1 = subprocess.run(['docker','exec',self.container,'cat','/proc/1/comm'],capture_output=True,text=True)
            if check.returncode == 0 and pid1.stdout.strip() == 'postgres':
                break
            time.sleep(.1)
        inspect = json.loads(subprocess.check_output(['docker','inspect',self.container],text=True))[0]
        assert inspect['Config']['Labels']['eveno.experiment'] == self.name
        assert inspect['HostConfig']['NetworkMode'] == 'none'
        assert not inspect['HostConfig']['PortBindings']
        assert inspect['HostConfig']['Memory'] == 512*1024*1024
        assert '/var/lib/postgresql/data' in inspect['HostConfig']['Tmpfs']
        data = self.sql("SELECT json_build_object('database',current_database(),'address',inet_server_addr(),"
            "'dataDirectory',current_setting('data_directory'),'listen',current_setting('listen_addresses'),"
            "'version',version(),'fsync',current_setting('fsync'),'synchronousCommit',current_setting('synchronous_commit'),"
            "'userTables',(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')));")
        self.identity = json.loads(data)
        assert self.identity['database'] == DB and self.identity['address'] is None
        assert self.identity['dataDirectory'] == '/var/lib/postgresql/data'
        assert self.identity['listen'] == '' and self.identity['userTables'] == 0
        assert self.identity['fsync'] == self.identity['synchronousCommit'] == 'on'
        self.identity.update({'network':'none','ports':[],'memoryLimitBytes':512*1024*1024,
                              'dataStorage':'isolated tmpfs; not host-crash durability proof'})
        return self

    def command(self, app='eveno-credit-test'):
        return ['docker','exec','-i','-e','PGAPPNAME='+app,self.container,
                'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-U','postgres','-d',DB]

    def sql(self, sql, schema=None, expect_error=None):
        if schema:
            assert re.fullmatch(r'exp_[a-z0-9_]+',schema)
            sql=f'SET search_path TO {schema},pg_catalog;\n'+sql
        result=subprocess.run(self.command(),input=sql,text=True,capture_output=True)
        if expect_error:
            assert result.returncode != 0 and expect_error in result.stderr,(expect_error,result.stderr)
            return result.stderr.strip()
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    def setup(self, schema, notices, controls):
        assert re.fullmatch(r'exp_[a-z0-9_]+',schema)
        self.sql(f'CREATE SCHEMA {schema};')
        self.sql((ROOT/'apps/api/scripts/tillgodo_experiment.sql').read_text(),schema)
        rows=[]
        for (org,tenant,lease),control in controls.items():
            fields=[literal(org),literal(tenant),literal(lease),str(control['active']).lower(),
                    str(control['consent']).lower(),str(control['refund']).lower()]
            rows.append('INSERT INTO scope VALUES('+','.join(fields)+');')
        rows.extend(self.notice_insert(n) for n in notices)
        self.sql('\n'.join(rows),schema)

    @staticmethod
    def notice_insert(n):
        values=[literal(n.org),literal(n.id),literal(n.tenant),literal(n.lease),str(n.year*12+n.month-1),
                literal(n.issued),str(n.debt),str(n.debt)]
        return 'INSERT INTO notice(org,id,tenant,lease,period,issue_date,gross,debt) VALUES('+','.join(values)+');'

    def execute(self,schema,operations):
        statements='\n'.join(call(p) for p in operations)
        outcomes=self.sql(statements,schema).splitlines()
        assert len(outcomes)==len(operations)
        return outcomes

    def snapshot(self,schema):
        fields=[]
        for table in TABLES:
            fields.extend([literal(table),f"(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {table} t)"])
        return json.loads(self.sql('SELECT jsonb_build_object('+','.join(fields)+');',schema))

    def close(self):
        if self.container:
            info=json.loads(subprocess.check_output(['docker','inspect',self.container],text=True))[0]
            assert info['Config']['Labels']['eveno.experiment']==self.name
            subprocess.run(['docker','stop','--time','5',self.container],check=True,capture_output=True)
            self.container=None
