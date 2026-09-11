"""Own deliberate visible mutation, actual captures, red golden, exact restoration, fresh green."""
from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parent
repository = root.parents[2]
api = repository / 'apps/api'
source = api / 'src/invoices/pdf.service.ts'
original = source.read_bytes()
needle = b'    const html = generateInvoiceHtml(data)\n'
mutation = b"    const html = generateInvoiceHtml(data).replace('Att betala', 'Att betalX')\n"
assert original.count(needle) == 1
mutated = original.replace(needle, mutation)
env = dict(os.environ, TZ='UTC', NODE_ENV='test', FONTCONFIG_FILE=str(root/'font-environment/fonts.conf'),
           FONTCONFIG_PATH=str(root/'font-environment'))
results = []

def resource_check():
    subprocess.run(['df', '-h', '/workspaces'], check=True)
    running = subprocess.run(['pgrep', '-af', '[j]est|[t]sc'], capture_output=True, text=True)
    assert running.returncode == 1, 'Other heavy process: ' + running.stdout

def capture_and_test(label, pattern):
    directory = root / label
    directory.mkdir(exist_ok=False)
    for index in [1, 2]:
        resource_check()
        with (directory/f'capture-{index}.log').open('w') as log:
            subprocess.run(['node', '-r', 'ts-node/register/transpile-only', str(root/'capture-after.cjs'),
                            str(directory/f'process-{index}'), '1'], cwd=api, env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True)
    resource_check()
    test_env = dict(env, RENDERING_CAPTURED_BEFORE_JEST='1', RENDERING_EVIDENCE_DIR=str(directory))
    report = directory / 'jest.json'
    with (directory/'jest.log').open('w') as log:
        outcome = subprocess.run(['node', '--expose-gc', 'node_modules/jest/bin/jest.js', '--runInBand',
             '--runTestsByPath', 'src/invoices/rendering.real.spec.ts',
             '--globals={"ts-jest":{"isolatedModules":true}}', '--testNamePattern='+pattern,
             '--json', '--outputFile='+str(report)], cwd=api, env=test_env, stdout=log, stderr=subprocess.STDOUT)
    data = json.loads(report.read_text())
    tests = [t for s in data['testResults'] for t in s['assertionResults'] if t['status'] != 'pending']
    results.append({'label': label, 'exitCode': outcome.returncode,
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'tests': [{k: t[k] for k in ['title', 'status', 'numPassingAsserts', 'failureMessages']} for t in tests]})
    return outcome.returncode, tests

resource_check()
source.write_bytes(mutated)
try:
    code, tests = capture_and_test('behavior-red', 'r21-03 ')
    assert code != 0 and len(tests) == 1 and tests[0]['status'] == 'failed'
    assert 'Undeclared PDF byte difference' in '\n'.join(tests[0]['failureMessages'])
finally:
    assert source.read_bytes() == mutated, 'Concurrent change: preserve it; do not overwrite'
    source.write_bytes(original)
assert source.read_bytes() == original
code, tests = capture_and_test('behavior-restored', 'r21-0[34] ')
assert code == 0 and len(tests) == 2 and all(t['status']=='passed' and t['numPassingAsserts']>0 for t in tests)
(root/'behavior-mutation-results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False)+'\n')
print('Visible mutation red, exact restoration green; original source SHA256', hashlib.sha256(original).hexdigest())
