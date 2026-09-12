// Read-only branch canary. Usage: node branch-audit.test-helpers.cjs <worktree> <manifest.json>
// Requires that worktree's installed TypeScript. Reads frozen Git objects, never refs or network.
const fs = require('node:fs')
const cp = require('node:child_process')
const vm = require('node:vm')
const path = require('node:path')
const crypto = require('node:crypto')
const [worktreeArg, manifestArg] = process.argv.slice(2)
if (!worktreeArg || !manifestArg || process.argv.length !== 4) {
  throw new Error('Usage: node branch-audit.test-helpers.cjs <worktree> <manifest.json>')
}
const worktree = path.resolve(worktreeArg)
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestArg), 'utf8'))
if (manifest.formatVersion !== 1) throw new Error('Unsupported manifest format')
const ts = require(require.resolve('typescript', { paths: [worktree] }))
const digest = (source) => crypto.createHash('sha256').update(source).digest('hex')
function git(args) {
  return cp.execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function blob(sha, file) {
  return git(['show', sha + ':' + file])
}
function requireEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
    )
  }
}
function readModule(sha, file, cache = {}, resources = {}) {
  const key = sha + ':' + file
  if (cache[key]) return cache[key].exports
  const source = blob(sha, file)
  resources[file] = digest(source)
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  cache[key] = mod
  function localRequire(name) {
    if (!name.startsWith('.')) throw Error('Unexpected runtime external dependency ' + name)
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name))
    for (const candidate of [resolved + '.ts', resolved + '/index.ts']) {
      try {
        blob(sha, candidate)
      } catch {
        continue
      }
      return readModule(sha, candidate, cache, resources)
    }
    throw Error('Unresolved runtime dependency ' + name)
  }
  vm.runInNewContext(
    '(function(exports,require,module){' + js + '\n})',
    { console },
    { filename: file },
  )(mod.exports, localRequire, mod)
  return mod.exports
}
function defaultFactory(sha, resources) {
  const file = 'apps/web/src/features/consumption/components/ReadingForm.tsx'
  const source = blob(sha, file)
  resources[file] = digest(source)
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const statements = ast.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) =>
        ['today', 'firstOfMonth'].includes(d.name.getText(ast)),
      ),
  )
  if (statements.length !== 2) throw Error('Expected exactly two form default declarations')
  const defaults = statements.map((s) => s.getText(ast)).join('\n')
  const executableDefaults = ts.transpileModule(defaults, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  if (!source.includes('periodStart: firstOfMonth') || !source.includes('periodEnd: today'))
    throw Error('Expected form binding absent')
  return {
    defaultSource: defaults,
    create(now) {
      const fixed = Date.parse(now)
      class FixedDate extends Date {
        constructor(...args) {
          super(...(args.length ? args : [fixed]))
        }
        static now() {
          return fixed
        }
      }
      return vm.runInNewContext(
        executableDefaults + '\n;({periodStart:firstOfMonth,periodEnd:today})',
        { Date: FixedDate },
      )
    },
  }
}
const DAY = 86400000,
  date = (ms) => new Date(ms).toISOString().slice(0, 10)
function makeRows(type, kind, endDay, defaults) {
  const n = type === 'CUMULATIVE' ? 5 : 4
  const periods = Array.from({ length: n }, (_, i) => {
    if (kind === 'form-monthly')
      return defaults.create(
        '2026-' +
          String(i + 1).padStart(2, '0') +
          '-' +
          String(endDay).padStart(2, '0') +
          'T12:00:00.000Z',
      )
    if (kind === 'whole-month')
      return { periodStart: date(Date.UTC(2026, i, 1)), periodEnd: date(Date.UTC(2026, i + 1, 0)) }
    return {
      periodStart: date(Date.UTC(2026, 0, i + 1)),
      periodEnd: date(Date.UTC(2026, 0, i + 1)),
    }
  })
  let value = 100
  return periods.map((period, i) => {
    const rate = i === n - 1 ? 27 : 1
    if (type === 'PERIOD_VOLUME')
      value = ((Date.parse(period.periodEnd) - Date.parse(period.periodStart)) / DAY + 1) * rate
    else if (i > 0)
      value += ((Date.parse(period.periodEnd) - Date.parse(periods[i - 1].periodEnd)) / DAY) * rate
    return {
      id: String(i + 1),
      organizationId: 'org-synthetic',
      meterId: 'meter-synthetic',
      value,
      readingType: type,
      ...period,
    }
  })
}

const totals = {
  defectiveBranches: 0,
  absentBranches: 0,
  reproducedFormFailures: 0,
  passingControls: 0,
}
for (const ref of manifest.refs) {
  requireEqual(git(['rev-parse', ref.sha + '^{commit}']).trim(), ref.sha, ref.branch + ' commit')
  if (ref.status === 'ABSENT') {
    requireEqual(ref.analysisFile, null, ref.branch + ' absent analysisFile')
    requireEqual(Object.keys(ref.sourceHashes), [], ref.branch + ' absent sourceHashes')
    for (const file of ref.absentPaths) {
      // ls-tree exits successfully with empty output only when this exact path is absent.
      requireEqual(
        git(['ls-tree', '--name-only', ref.sha, '--', file]).trim(),
        '',
        ref.branch + ':' + file,
      )
    }
    totals.absentBranches++
    console.log(ref.branch + ' ' + ref.sha + ' ABSENT (not a passing behavior test)')
    continue
  }
  requireEqual(ref.status, 'DEFECT', ref.branch + ' status')
  const resources = {}
  const module = readModule(ref.sha, ref.analysisFile, {}, resources)
  if (typeof module.reviewReadings !== 'function')
    throw new Error(ref.branch + ': no reviewReadings export')
  const defaults = defaultFactory(ref.sha, resources)
  // Every loaded runtime source and the form itself must match the frozen manifest.
  requireEqual(
    Object.keys(resources).sort(),
    Object.keys(ref.sourceHashes).sort(),
    ref.branch + ' sources',
  )
  for (const file of Object.keys(resources))
    requireEqual(resources[file], ref.sourceHashes[file], ref.branch + ':' + file)
  let formFailures = 0
  let passingControls = 0
  for (const type of ['CUMULATIVE', 'PERIOD_VOLUME']) {
    for (const kind of ['form-monthly', 'daily', 'whole-month']) {
      for (const day of kind === 'form-monthly' ? [2, 10, 15, 28] : [null]) {
        const rows = makeRows(type, kind, day, defaults)
        const report = module.reviewReadings(rows)
        const label = ref.branch + ' ' + type + ' ' + kind + ' ' + day
        if (kind === 'form-monthly') {
          requireEqual(
            report.findings.map((f) => f.code),
            [],
            label + ' findings',
          )
          requireEqual(report.trendAssessed, 0, label + ' trendAssessed')
          formFailures++
        } else {
          requireEqual(
            report.findings.map((f) => f.code),
            ['HIGH_RATE'],
            label + ' findings',
          )
          requireEqual(report.findings[0].readingId, rows.at(-1).id, label + ' target')
          requireEqual(report.trendAssessed, 1, label + ' trendAssessed')
          passingControls++
        }
      }
    }
  }
  requireEqual([formFailures, passingControls], [8, 4], ref.branch + ' case counts')
  totals.defectiveBranches++
  totals.reproducedFormFailures += formFailures
  totals.passingControls += passingControls
  console.log(
    ref.branch + ' ' + ref.sha + ' DEFECT forms=8 controls=4 sources=' + JSON.stringify(resources),
  )
}
requireEqual(
  totals,
  {
    defectiveBranches: 19,
    absentBranches: 2,
    reproducedFormFailures: 152,
    passingControls: 76,
  },
  'frozen inventory totals',
)
console.log('TOTAL ' + JSON.stringify(totals))
