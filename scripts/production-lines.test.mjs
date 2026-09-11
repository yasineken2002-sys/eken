import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { category, imports, measure, numstat } from './production-lines.mjs'
import { kanariefåglar } from './lib/source-scan.mjs'

test('shared source scanner canaries run, not an unused import', () => {
  assert.deepEqual(kanariefåglar(), [])
})
test('suffixes are anchored; TSX, JS, Python and e2e are explicit', () => {
  for (const file of [
    'a.spec.ts',
    'a.test.tsx',
    'a.test-ports.ts',
    'a.test-helpers.ts',
    'a.test-fixtures.ts',
    'a-test.py',
    'a_test.py',
    'test_a.py',
    'apps/web/e2e/a.ts',
    'a.test.mjs',
  ])
    assert.equal(category(file), 'test', file)
  for (const file of [
    'contest.ts',
    'specimens/a.ts',
    'a.test-helpers.ts.backup',
    '.github/workflows/ci.yml',
    'apps/api/prisma/a.sql',
    'scripts/counter.mjs',
  ])
    assert.equal(category(file), 'production', file)
})
test('numstat handles whitespace filenames, deletions and binary records', () => {
  assert.deepEqual(numstat(Buffer.from('3\t4\ta b\tc.ts\0-\t-\timage.png\0')), [
    { file: 'a b\tc.ts', added: 3, deleted: 4 },
    { file: 'image.png', added: null, deleted: null },
  ])
  assert.throws(() => numstat(Buffer.from('1\t-\ta.ts\0')))
})
const graph = (entries) => imports(new Map(Object.entries(entries)))
for (const syntax of [
  "import { x } from './rig.test-ports'",
  "import './rig.test-ports'",
  "export * from './rig.test-ports'",
  "import type { X } from './rig.test-ports'",
  "import x = require('./rig.test-ports')",
  "const x = require('./rig.test-ports')",
  "const x = import('./rig.test-ports')",
  "type X = import('./rig.test-ports').X",
])
  test('production test dependency rejected: ' + syntax, () => {
    const report = graph({ 'src/app.ts': syntax, 'src/rig.test-ports.ts': 'export const x = 1' })
    assert.ok(
      report.errors.some((e) => e.includes('production imports test')),
      JSON.stringify(report),
    )
  })
test('ordinary unchanged helper and barrel cannot hide test import', () => {
  const report = graph({
    'src/app.ts': "import { x } from './barrel'",
    'src/barrel.ts': "export { x } from './helper'",
    'src/helper.ts': "export { x } from './rig.test-helpers'",
    'src/rig.test-helpers.ts': 'export const x = 1',
  })
  assert.ok(
    report.errors.some(
      (e) =>
        e.includes('src/app.ts') &&
        e.includes('barrel.ts') &&
        e.includes('helper.ts') &&
        e.includes('rig.test-helpers.ts'),
    ),
  )
})
test('configured alias from inherited tsconfig resolves through regular helper', () => {
  const report = graph({
    'tsconfig.base.json': '{"compilerOptions":{"moduleResolution":"Node"}}',
    'apps/web/tsconfig.json':
      '{"extends":"../../tsconfig.base.json","compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    'apps/web/src/app.ts': "import { x } from '@/helper'",
    'apps/web/src/helper.ts': "export { x } from './rig.test-fixtures'",
    'apps/web/src/rig.test-fixtures.ts': 'export const x = 1',
  })
  assert.ok(
    report.errors.some(
      (e) =>
        e.includes('app.ts') && e.includes('helper.ts') && e.includes('production imports test'),
    ),
    JSON.stringify(report),
  )
})
test('workspace root and subpath exports retain source edges', () => {
  const report = graph({
    'apps/api/src/app.ts': "import { x } from '@eken/shared'; import { y } from '@eken/ui/react'",
    'packages/shared/package.json':
      '{"name":"@eken/shared","exports":{".":{"types":"./src/index.ts","default":"./dist/index.js"}}}',
    'packages/shared/src/index.ts': "export { x } from './x.test-helpers'",
    'packages/shared/src/x.test-helpers.ts': 'export const x = 1',
    'packages/ui/package.json':
      '{"name":"@eken/ui","exports":{"./react":{"types":"./src/react/index.ts","default":"./dist/react/index.js"}}}',
    'packages/ui/src/react/index.ts': "export { y } from './y.test-ports'",
    'packages/ui/src/react/y.test-ports.ts': 'export const y = 2',
  })
  assert.ok(report.errors.some((e) => e.includes('app.ts') && e.includes('x.test-helpers')))
  assert.ok(report.errors.some((e) => e.includes('app.ts') && e.includes('y.test-ports')))
})
test('comment and string examples are not dependencies; tests may import tests', () => {
  const report = graph({
    'app.ts': "// import './x.test-ports'\nconst x = \"import './x.test-ports'\"",
    'app.spec.ts': "import './x.test-ports'",
    'x.test-ports.ts': 'export const x = 1',
  })
  assert.deepEqual(report.errors, [])
})
test('cycles terminate and still find test dependency', () => {
  const report = graph({
    'a.ts': "import './b'",
    'b.ts': "import './a'; import './x.test.ts'",
    'x.test.ts': 'export const x = 1',
  })
  assert.ok(report.errors.some((e) => e.includes('production imports test')))
})
test('unresolved local alias and malformed production source are not silently external', () => {
  const report = graph({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    'src/app.ts': "import '@/missing'",
    'src/broken.ts': 'export const =',
  })
  assert.ok(report.errors.some((e) => e.includes('unresolved internal import')))
  assert.ok(report.errors.some((e) => e.includes('parse failed')))
})
test('production reachability promotes executable documentation and checks its dependencies', () => {
  const report = graph({
    'src/app.ts': "import '../docs/helper'",
    'docs/helper.ts': "import './x.test-ports'",
    'docs/x.test-ports.ts': 'export const x = 1',
  })
  assert.ok(report.promoted.has('docs/helper.ts'))
  assert.ok(report.errors.some((e) => e.includes('production imports test')))
})
test('dynamic imports and process/filesystem boundaries are explicit diagnostics', () => {
  const report = graph({
    'app.ts':
      "const x = import(moduleName); require(name); readFileSync(file); spawn('python3', args)",
  })
  assert.equal(report.limitations.length, 4)
  assert.deepEqual(report.errors, [])
})
test('Python static imports use Python AST; dynamic importlib is disclosed', () => {
  const report = graph({
    'app.py': 'import helper\nimport importlib\nimportlib.import_module(name)\n',
    'helper.py': 'import helper_test\n',
    'helper_test.py': 'x = 1\n',
  })
  assert.ok(report.errors.some((e) => e.includes('app.py') && e.includes('helper_test.py')))
  assert.ok(report.limitations.some((e) => e.includes('Python loading/process boundary')))
})
function repository(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'eken-production-lines-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Counter test',
        '-c',
        'user.email=counter@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim()
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  git('init', '-q')
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'Synthetic counter fixture')
    return git('rev-parse', 'HEAD')
  }
  return { root, git, put, commit }
}
test('working measure includes staged, unstaged, untracked, deleted and binary files', (t) => {
  const r = repository(t)
  r.put('a.ts', 'export const x = 1\n')
  r.put('deleted.ts', 'export const deleted = true\n')
  const base = r.commit()
  r.put('a.ts', 'export const x = 2\n')
  r.git('add', 'a.ts')
  r.put('a.ts', 'export const x = 3\nexport const y = 4\n')
  rmSync(path.join(r.root, 'deleted.ts'))
  r.put('new.ts', 'export const z = 1\n')
  r.put('rig.test-helpers.ts', 'export const fixture = 1\n')
  r.put('empty.txt', '')
  r.put('image.png', Buffer.from([0, 1, 2]))
  const report = measure(r.root, base)
  assert.equal(report.totals.production, 5)
  assert.equal(report.totals.test, 1)
  assert.equal(report.totals.binaryFiles, 1)
  assert.deepEqual(report.errors, [])
})
test('historical snapshots are read from Git, not contaminated by current files', (t) => {
  const r = repository(t)
  r.put('a.ts', 'export const x = 1\n')
  const base = r.commit()
  r.put('a.ts', 'export const x = 2\n')
  r.put('helper.ts', 'export const helper = true\n')
  const head = r.commit()
  r.put('a.ts', "import './rig.test-ports'\n")
  r.put('rig.test-ports.ts', 'export const fixture = 1\n')
  const historical = measure(r.root, base, head)
  assert.equal(historical.totals.production, 3)
  assert.deepEqual(historical.errors, [])
  assert.ok(measure(r.root, base).errors.some((e) => e.includes('production imports test')))
})
test('rename into test suffix is delete plus test addition and cannot bypass import guard', (t) => {
  const r = repository(t)
  r.put('app.ts', "import './helper'\n")
  r.put('helper.ts', 'export const x = 1\n')
  const base = r.commit()
  renameSync(path.join(r.root, 'helper.ts'), path.join(r.root, 'helper.test-ports.ts'))
  r.put('app.ts', "import './helper.test-ports'\n")
  const report = measure(r.root, base)
  assert.equal(report.totals.production, 3)
  assert.equal(report.totals.test, 1)
  assert.ok(report.errors.some((e) => e.includes('production imports test')))
})

test('Python from-module and relative helper imports cannot bypass classification', () => {
  const report = graph({
    'app.py': 'from test_models import Model\nfrom bridge import value\n',
    'test_models.py': 'class Model: pass\n',
    'bridge.py': 'from .helper_test import value\n',
    'helper_test.py': 'value = 1\n',
  })
  assert.ok(report.errors.some((e) => e.includes('app.py') && e.includes('test_models.py')))
  assert.ok(report.errors.some((e) => e.includes('bridge.py') && e.includes('helper_test.py')))
})
test('path aliases resolve non-code assets and broken extends is rejected', () => {
  const files = new Map([
    ['tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}'],
    ['src/app.ts', "import '@/style.css'"],
  ])
  assert.deepEqual(imports(files, new Set([...files.keys(), 'src/style.css'])).errors, [])
  files.set('tsconfig.json', '{"extends":"./missing.json"}')
  assert.throws(() => imports(files), /Invalid configuration/)
})
test('deleted imports and unsupported newline filenames are rejected', (t) => {
  const r = repository(t)
  r.put('app.ts', "import './helper'\n")
  r.put('helper.ts', 'export const x = 1\n')
  const base = r.commit()
  rmSync(path.join(r.root, 'helper.ts'))
  assert.ok(measure(r.root, base).errors.some((e) => e.includes('unresolved internal import')))
  r.put('newline\nfile.ts', 'export const x = 1\n')
  assert.throws(() => measure(r.root, base), /Newline filenames/)
})

test('Python from package follows both initialization and imported submodule', () => {
  const report = graph({
    'app.py': 'from pkg import helper_test\n',
    'pkg/__init__.py': '',
    'pkg/helper_test.py': 'value = 1\n',
  })
  assert.ok(report.errors.some((e) => e.includes('app.py') && e.includes('pkg/helper_test.py')))
})
test('runtime workspace exports cannot hide behind harmless type declaration', () => {
  const report = graph({
    'app.ts': "import '@eken/shared'",
    'packages/shared/package.json':
      '{"name":"@eken/shared","exports":{".":{"types":"./src/index.d.ts","import":"./src/runtime.test-helpers.ts"}}}',
    'packages/shared/src/index.d.ts': 'export declare const value: number',
    'packages/shared/src/runtime.test-helpers.ts': 'export const value = 1',
  })
  assert.ok(
    report.errors.some((e) => e.includes('app.ts') && e.includes('runtime.test-helpers.ts')),
  )
})
test('harmless Python package symbols and workspace runtime exports remain green', () => {
  const report = graph({
    'app.py': 'from pkg import value\n',
    'pkg/__init__.py': 'value = 1\n',
    'app.ts': "import '@eken/shared'",
    'packages/shared/package.json':
      '{"name":"@eken/shared","exports":{".":{"types":"./src/index.d.ts","import":"./src/runtime.ts"}}}',
    'packages/shared/src/index.d.ts': 'export declare const value: number',
    'packages/shared/src/runtime.ts': 'export const value = 1',
  })
  assert.deepEqual(report.errors, [])
})

test('removed executable documentation is classified using base reachability too', (t) => {
  const r = repository(t)
  r.put('app.ts', "import './docs/helper'\n")
  r.put('docs/helper.ts', 'export const x = 1\nexport const y = 2\n')
  const base = r.commit()
  r.put('app.ts', 'export {}\n')
  rmSync(path.join(r.root, 'docs/helper.ts'))
  const report = measure(r.root, base)
  assert.equal(report.totals.production, 4)
  assert.equal(report.totals.documentation, 0)
})
test('fixing a forbidden base import succeeds; base errors do not block repair', (t) => {
  const r = repository(t)
  r.put('app.ts', "import './helper.test-ports'\n")
  r.put('helper.test-ports.ts', 'export const x = 1\n')
  const base = r.commit()
  r.put('app.ts', 'export {}\n')
  assert.deepEqual(measure(r.root, base).errors, [])
})
test('source/config symlinks cannot mask test imports in worktree or historical tree', (t) => {
  const r = repository(t)
  r.put('app.ts', 'export {}\n')
  const base = r.commit()
  r.put('app.ts', "import './helper'\n")
  r.put('helper.test-ports.ts', 'export const x = 1\nexport const y = 2\n')
  symlinkSync('helper.test-ports.ts', path.join(r.root, 'helper.ts'))
  assert.throws(() => measure(r.root, base), /symlink/)
  const head = r.commit()
  assert.throws(() => measure(r.root, base, head), /Source\/config symlink/)
  assert.throws(() => measure(r.root, base), /Source\/config symlink/)
})

test('colon in a source filename cannot remove a real production diagnostic', () => {
  const report = graph({
    'src/a:b.ts': "import './helper.test-ports'",
    'src/helper.test-ports.ts': 'export const x = 1',
  })
  assert.ok(
    report.errors.some((e) => e.includes('src/a:b.ts') && e.includes('production imports test')),
  )
})

test('literal file URL cannot be mistaken for an external package', () => {
  const report = graph({
    'app.mjs': "import 'file:///__eken_counter__/rig.test-ports.mjs'",
    'rig.test-ports.mjs': 'export const x = 1',
  })
  assert.ok(report.errors.some((error) => error.includes('unresolved internal import file:')))
})
