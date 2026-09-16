#!/usr/bin/env python3
"""Real shell/gate/exec in small network-isolated containers; synthetic targets.

No dependencies, DB, secrets or builds. --mutant changes executable behavior,
then runs the SAME assertions. Mutant runs MUST exit nonzero.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
REV = '1' * 40
IMAGE = os.environ.get('START_SAFETY_IMAGE', 'node:20-slim')
DOCKER = os.environ.get('START_SAFETY_DOCKER', 'docker')
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--mutant', choices=('migration', 'hash'))
OPTIONS, TEST_ARGS = parser.parse_known_args()


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


package = module('make-package')
applied = module('verify-applied')


def docker(*args, check=True):
    return subprocess.run([DOCKER, *args], text=True, capture_output=True,
                          timeout=45, check=check)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='restart-safety-')
        self.root = Path(self.temp.name)
        self.app = self.root / 'app'
        self.api = self.app / 'apps/api'
        self.names = []
        for path in package.DECLARED:
            file = self.api / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('// synthetic declared content\n')
        shutil.copyfile(REPO / 'apps/api/scripts/migrate-and-start.sh',
                        self.api / 'scripts/migrate-and-start.sh')
        (self.api / 'scripts/migrate-and-start.sh').chmod(0o755)
        (self.api / 'dist/main.js').write_text('''
const fs = require('fs');
console.log('APP_STARTED ' + JSON.stringify({pid:process.pid,cwd:process.cwd(),
  paused:process.env.OPS_AUTOMATION_PAUSED}));
process.on('SIGTERM', () => { console.log('APP_SIGTERM'); process.exit(0); });
setInterval(() => {
  if (process.env.AUTO_CRASH === 'true' || fs.existsSync('/tmp/crash')) {
    if (fs.existsSync('/tmp/crash')) fs.unlinkSync('/tmp/crash');
    console.log('APP_CRASH'); process.exit(42);
  }
}, 100);
''')
        cli = self.api / 'node_modules/prisma/build/index.js'
        cli.parent.mkdir(parents=True)
        cli.write_text("console.log('MIGRATOR_STARTED ' + JSON.stringify(process.argv.slice(2)));\n"
                       "process.exit(Number(process.env.MIGRATION_EXIT || 0));\n")
        migrations = self.api / 'prisma/migrations/20260913090000_fixture'
        migrations.mkdir(parents=True)
        (migrations / 'migration.sql').write_text('SELECT 1;\n')
        if OPTIONS.mutant == 'migration':
            script = self.api / 'scripts/migrate-and-start.sh'
            script.write_text(script.read_text().replace(
                'exec node /app/apps/api/dist/main.js',
                'node /app/apps/api/node_modules/prisma/build/index.js migrate deploy\n'
                'exec node /app/apps/api/dist/main.js'))
        self.pkg = self.root / 'pkg'
        package.build(self.app, REV, 'sha256:' + '2' * 64, 'true', self.pkg)
        if OPTIONS.mutant == 'hash':
            # Re-pin the mutated tool, so failure must come from the behavioral
            # assertion, not the transport hash check.
            gate = (self.pkg / 'gate.js').read_text()
            needle = "if (h !== man.declared_files[p]) fail(E.FILE_HASH, 'declared_file_hash_mismatch', p);"
            self.assertIn(needle, gate)
            gate = gate.replace(needle, '/* MUTANT: disabled content comparison */')
            old = package.sha((self.pkg / 'gate.js').read_bytes())
            import base64
            (self.pkg / 'GATE_TOOL_B64.txt').write_bytes(base64.b64encode(gate.encode()))
            for mode in ('app', 'migrator'):
                path = self.pkg / f'start-command-{mode}.txt'
                path.write_text(path.read_text().replace(old, package.sha(gate.encode())))

    def tearDown(self):
        for name in self.names:
            docker('rm', '-f', name, check=False)
        self.temp.cleanup()

    def launch(self, mode='app', revision=REV, paused='true', policy='no', extra=None):
        import shlex
        name = 'restart-safety-' + uuid.uuid4().hex[:12]
        self.names.append(name)
        args = ['run', '-d', '--name', name, '--network', 'none',
                '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
                '--restart', policy, '--label', 'se.eveno.test=restart-safety',
                '-v', str(self.app) + ':/app:ro']
        env = {
            'GATE_TOOL_B64': (self.pkg / 'GATE_TOOL_B64.txt').read_text(),
            'GATE_MANIFEST_B64': (self.pkg / 'GATE_MANIFEST_B64.txt').read_text(),
            'RAILWAY_GIT_COMMIT_SHA': revision,
        }
        if paused is not None:
            env['OPS_AUTOMATION_PAUSED'] = paused
        env.update(extra or {})
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        command = shlex.split((self.pkg / f'start-command-{mode}.txt').read_text())
        docker(*args, '--entrypoint', command[0], IMAGE, *command[1:])
        return name

    def logs(self, name):
        r = docker('logs', name)
        return r.stdout + r.stderr

    def state(self, name):
        return json.loads(docker('inspect', name).stdout)[0]

    def until(self, predicate):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.15)
        self.fail('timed out waiting for container behavior')

    def stopped(self, name):
        self.until(lambda: self.state(name)['State']['Status'] == 'exited')
        return self.state(name)

    def assert_rejected(self, name, code):
        info = self.stopped(name)
        self.assertEqual(info['State']['ExitCode'], code, self.logs(name))
        self.assertNotIn('APP_STARTED', self.logs(name))
        self.assertNotIn('MIGRATOR_STARTED', self.logs(name))

    def test_app_start_and_signal(self):
        name = self.launch(extra={'MIGRATION_EXIT': '42'})
        self.until(lambda: 'APP_STARTED' in self.logs(name))
        logs = self.logs(name)
        self.assertIn('GATE_OK mode=app', logs)
        self.assertIn('"pid":1,"cwd":"/app/apps/api","paused":"true"', logs)
        self.assertNotIn('MIGRATOR_STARTED', logs, 'app start must never migrate')
        docker('stop', '-t', '5', name)
        self.assertIn('APP_SIGTERM', self.logs(name))
        self.assertEqual(self.state(name)['State']['ExitCode'], 0)

    def test_crash_restarts_through_gate_without_migration(self):
        name = self.launch(policy='on-failure:3')
        self.until(lambda: 'APP_STARTED' in self.logs(name))
        docker('exec', name, 'touch', '/tmp/crash')
        self.until(lambda: self.logs(name).count('APP_STARTED') == 2)
        logs = self.logs(name)
        self.assertEqual(logs.count('GATE_OK mode=app'), 2)
        self.assertEqual(logs.count('"paused":"true"'), 2)
        self.assertNotIn('MIGRATOR_STARTED', logs)
        self.assertEqual(self.state(name)['RestartCount'], 1)
        self.assertEqual(self.state(name)['HostConfig']['RestartPolicy'],
                         {'Name': 'on-failure', 'MaximumRetryCount': 3})
        docker('stop', '-t', '5', name)
        time.sleep(0.3)
        self.assertEqual(self.state(name)['State']['Status'], 'exited')
        self.assertEqual(self.state(name)['RestartCount'], 1)

    def test_retry_budget_exhausted(self):
        name = self.launch(policy='on-failure:3', extra={'AUTO_CRASH': 'true'})
        self.until(lambda: self.state(name)['RestartCount'] == 3)
        info = self.stopped(name)
        self.assertEqual(info['State']['ExitCode'], 42)
        self.assertEqual(self.logs(name).count('APP_STARTED'), 4)
        self.assertEqual(self.logs(name).count('GATE_OK mode=app'), 4)
        self.assertNotIn('MIGRATOR_STARTED', self.logs(name))

    def test_wrong_revision(self):
        self.assert_rejected(self.launch(revision='0' * 40), 11)

    def test_missing_revision(self):
        self.assert_rejected(self.launch(revision=''), 11)

    def test_declared_content(self):
        for relative in package.DECLARED:
            with self.subTest(path=relative):
                file = self.api / relative
                original = file.read_bytes()
                file.write_bytes(original + b'\n// changed\n')
                try:
                    name = self.launch()
                    # Avoid waiting for a mutant's running app to stop. The
                    # same assertion sees a real target start and fails.
                    self.until(lambda: 'GATE_FAIL' in self.logs(name) or 'APP_STARTED' in self.logs(name))
                    self.assertNotIn('APP_STARTED', self.logs(name), 'changed declared content started app')
                    self.assert_rejected(name, 12)
                finally:
                    docker('rm', '-f', name, check=False)
                    self.names.remove(name)
                    file.write_bytes(original)

    def test_restart_rechecks_changed_content(self):
        name = self.launch(policy='on-failure:3')
        self.until(lambda: 'APP_STARTED' in self.logs(name))
        with (self.api / 'dist/app.module.js').open('a') as f:
            f.write('// tampered after first start\n')
        docker('exec', name, 'touch', '/tmp/crash')
        self.until(lambda: self.state(name)['RestartCount'] == 3)
        self.assertEqual(self.stopped(name)['State']['ExitCode'], 12)
        self.assertEqual(self.logs(name).count('APP_STARTED'), 1)
        self.assertEqual(self.logs(name).count('GATE_FAIL'), 3)
        self.assertNotIn('MIGRATOR_STARTED', self.logs(name))

    def test_pause_required_and_bound(self):
        for value in (None, 'false'):
            self.assert_rejected(self.launch(paused=value), 15)

    def test_unpaused_package_preserves_false(self):
        self.pkg = self.root / 'reopen'
        package.build(self.app, REV, 'sha256:' + '2' * 64, 'false', self.pkg)
        name = self.launch(paused='false')
        self.until(lambda: 'APP_STARTED' in self.logs(name))
        self.assertIn('"paused":"false"', self.logs(name))
        self.assertNotIn('MIGRATOR_STARTED', self.logs(name))

    def test_transport_and_admin_variable(self):
        self.assert_rejected(self.launch(extra={'GATE_MANIFEST_B64': 'e30='}), 35)
        self.assert_rejected(self.launch(extra={'GATE_TOOL_B64': 'e30='}), 34)
        self.assert_rejected(self.launch(extra={'GH_TOKEN': 'synthetic-only'}), 14)

    def test_migrations_changed(self):
        path = self.api / 'prisma/migrations/20260913090000_fixture/migration.sql'
        path.write_text('SELECT 2;\n')
        self.assert_rejected(self.launch(mode='migrator'), 13)

    def test_precheck_has_no_target(self):
        name = self.launch(mode='precheck', paused=None)
        self.assertEqual(self.stopped(name)['State']['ExitCode'], 0)
        self.assertIn('PRECHECK_OK', self.logs(name))
        self.assertIn('GATE_OK mode=migrator', self.logs(name))
        self.assertNotIn('MIGRATOR_STARTED', self.logs(name))
        self.assertNotIn('APP_STARTED', self.logs(name))

    def test_migrator_success_and_failure_are_one_shot(self):
        for code in (0, 42):
            with self.subTest(exit=code):
                name = self.launch(mode='migrator', paused=None,
                                   extra={'MIGRATION_EXIT': str(code)})
                info = self.stopped(name)
                self.assertEqual(info['State']['ExitCode'], code)
                self.assertEqual(info['RestartCount'], 0)
                self.assertEqual(info['HostConfig']['RestartPolicy']['Name'], 'no')
                self.assertEqual(self.logs(name).count('MIGRATOR_STARTED'), 1)
                self.assertIn('["migrate","deploy"]', self.logs(name))
                self.assertNotIn('APP_STARTED', self.logs(name))


class AppliedTests(unittest.TestCase):
    def setUp(self):
        self.response = {'data': {'deployment': {
            'id': 'd', 'status': 'SUCCESS', 'deploymentStopped': False,
            'instances': [{'id': 'i', 'status': 'RUNNING'}],
            'meta': {'commitHash': REV, 'configFile': '/railway.json',
                     'serviceManifest': {'build': {'builder': 'DOCKERFILE'}, 'deploy': {
                         'startCommand': 'reviewed', 'preDeployCommand': None,
                         'numReplicas': 1, 'cronSchedule': None, 'sleepApplication': False,
                         'restartPolicyType': 'ON_FAILURE', 'restartPolicyMaxRetries': 3,
                         'healthcheckPath': '/v1/health',
                     }}},
        }}}

    def test_applied_policy_required_even_if_stored_policy_matches(self):
        applied.verify(self.response, 'd', REV, 'reviewed', 'app')
        self.response['data']['serviceInstance'] = {
            'restartPolicyType': 'ON_FAILURE', 'restartPolicyMaxRetries': 3}
        self.response['data']['deployment']['meta']['serviceManifest']['deploy']['restartPolicyType'] = 'NEVER'
        with self.assertRaises(ValueError):
            applied.verify(self.response, 'd', REV, 'reviewed', 'app')

    def test_missing_or_wrong_applied_fields_rejected(self):
        config = self.response['data']['deployment']['meta']['serviceManifest']['deploy']
        for key in tuple(config):
            bad = copy.deepcopy(self.response)
            del bad['data']['deployment']['meta']['serviceManifest']['deploy'][key]
            with self.subTest(missing=key), self.assertRaises(KeyError):
                applied.verify(bad, 'd', REV, 'reviewed', 'app')
        for key, value in [('startCommand', 'node dist/main'), ('preDeployCommand', 'migrate'),
                           ('numReplicas', 2), ('restartPolicyMaxRetries', 10)]:
            bad = copy.deepcopy(self.response)
            bad['data']['deployment']['meta']['serviceManifest']['deploy'][key] = value
            with self.subTest(wrong=key), self.assertRaises(ValueError):
                applied.verify(bad, 'd', REV, 'reviewed', 'app')

    def test_migrator_never(self):
        config = self.response['data']['deployment']['meta']['serviceManifest']['deploy']
        config.update(restartPolicyType='NEVER', restartPolicyMaxRetries=None, healthcheckPath=None)
        applied.verify(self.response, 'd', REV, 'reviewed', 'migrator')
        config['restartPolicyType'] = 'ON_FAILURE'
        with self.assertRaises(ValueError):
            applied.verify(self.response, 'd', REV, 'reviewed', 'migrator')


if __name__ == '__main__':
    unittest.main(argv=[__file__, *TEST_ARGS], verbosity=2)
