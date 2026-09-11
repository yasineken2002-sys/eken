/**
 * Late supplementary source replay for invoice-reminder, never replacement golden.
 * before: exact 5ae Git blobs for MailRenderer and every imported mail template.
 * after: current real MailRenderer. Both use recorded, actually installed engines.
 * Run each mode/TZ in a separate process; no Chrome, DB, queue or provider is used.
 */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, relative, resolve, sep } = require('node:path')

const BASE_SHA = '5ae9906b152307eae0d79eec719d4303a042742c'
const evidenceRoot = __dirname
const repository = resolve(evidenceRoot, '../../..')
const apiRoot = join(repository, 'apps/api')
const api = createRequire(join(apiRoot, 'package.json'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const git = args => execFileSync('git', args, { cwd: repository, maxBuffer: 16 * 1024 * 1024 })
const fixture = {
  template: 'invoice-reminder',
  props: {
    tenantName: 'Testa Åberg',
    invoiceNumber: 'F-SYN-EXTRA-REMINDER-001',
    total: 1100,
    dueDate: '2026-09-11T23:30:00.000Z',
    organizationName: 'Syntetiska Fastigheter AB',
  },
}

function sourcesAtBase() {
  const tree = git([
    'ls-tree', '-r', '-z', BASE_SHA, '--',
    'apps/api/src/mail/mail.renderer.ts', 'apps/api/src/mail/templates',
  ]).toString('utf8')
  return tree.split('\0').filter(Boolean).map(line => {
    const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(line)
    assert.ok(match, 'Unexpected Git tree entry')
    const [, blob, path] = match
    const bytes = git(['show', `${BASE_SHA}:${path}`])
    assert.equal(gitBlob(bytes), blob, path + ': exact frozen blob')
    return { path, blob, bytes }
  })
}

function packageEvidence(name) {
  const entry = api.resolve(name)
  let directory = dirname(entry)
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    assert.notEqual(parent, directory, 'Missing package manifest: ' + name)
    directory = parent
  }
  const packageBytes = readFileSync(join(directory, 'package.json'))
  const metadata = JSON.parse(packageBytes.toString('utf8'))
  return {
    name, entry, entrySha256: digest(readFileSync(entry)),
    packageName: metadata.name, version: metadata.version,
    packageJsonSha256: digest(packageBytes),
  }
}

async function capture(mode, directory) {
  assert.ok(['before', 'after'].includes(mode), 'Mode must be before or after')
  assert.ok(['UTC', 'Europe/Stockholm'].includes(process.env.TZ), 'Set explicit supported TZ')
  const output = resolve(directory)
  const insideEvidence = relative(evidenceRoot, output).split(sep)
  assert.ok(!insideEvidence.some(part => /^before-final(?:-|$)/.test(part)), 'Authoritative evidence is immutable')
  assert.ok(!existsSync(output), 'Capture requires a new directory; never overwrite evidence')
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output)
  const save = (name, bytes) => {
    mkdirSync(dirname(join(output, name)), { recursive: true })
    writeFileSync(join(output, name), bytes, { flag: 'wx' })
    return { file: name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }
  }
  const frozen = sourcesAtBase()
  const selected = frozen.map(source => ({
    ...source,
    bytes: mode === 'before' ? source.bytes : readFileSync(join(repository, source.path)),
  }))
  const sourceMap = new Map(selected.map(source => [join(repository, source.path), source]))
  const loadedFrozenSources = new Set()
  const ts = api('typescript')
  const tsNode = api('ts-node').register({ transpileOnly: true, project: join(apiRoot, 'tsconfig.json') })
  const extensions = { '.ts': require.extensions['.ts'], '.tsx': require.extensions['.tsx'] }
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  }
  if (mode === 'before') {
    for (const extension of ['.ts', '.tsx']) {
      require.extensions[extension] = (module, filename) => {
        if (!filename.startsWith(join(apiRoot, 'src/mail') + sep)) {
          assert.ok(extensions[extension], 'Missing original TypeScript loader')
          return extensions[extension](module, filename)
        }
        const source = sourceMap.get(filename)
        assert.ok(source, 'No live mail source fallback in before mode: ' + filename)
        loadedFrozenSources.add(source.path)
        const compiled = ts.transpileModule(source.bytes.toString('utf8'), {
          fileName: filename, compilerOptions: options, reportDiagnostics: true,
        })
        assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
        module._compile(compiled.outputText, filename)
      }
    }
  }
  try {
    const { MailRenderer } = api('./src/mail/mail.renderer.ts')
    const renders = []
    for (let instance = 1; instance <= 2; instance++) {
      const result = await new MailRenderer().render(fixture.template, structuredClone(fixture.props))
      assert.equal(typeof result.html, 'string')
      assert.equal(typeof result.text, 'string')
      renders.push({
        instance,
        html: save(`mail-invoice-reminder-${instance}.html`, result.html),
        text: save(`mail-invoice-reminder-${instance}.txt`, result.text),
        ...(result.identity ? { renderingIdentity: result.identity } : {}),
      })
    }
    if (mode === 'before') {
      for (const path of [
        'apps/api/src/mail/mail.renderer.ts',
        'apps/api/src/mail/templates/invoices/InvoiceReminder.tsx',
        'apps/api/src/mail/templates/shared/format.ts',
      ]) assert.ok(loadedFrozenSources.has(path), 'Frozen real rendering path not executed: ' + path)
    }
    const shared = api.resolve('@eken/shared')
    const manifest = {
      series: 'late-invoice-reminder-source-replay',
      note: 'Sent kompletterat föreunderlag från fryst källa; ersätter inte before-final-1/2.',
      mode, baseSha: BASE_SHA,
      applicationSourceSha: mode === 'before' ? BASE_SHA : git(['rev-parse', 'HEAD']).toString().trim(),
      worktreeHead: git(['rev-parse', 'HEAD']).toString().trim(),
      worktreeStatus: git(['status', '--porcelain']).toString(),
      capturedAt: new Date().toISOString(), pid: process.pid,
      driverSha256: digest(readFileSync(__filename)),
      fixture: save('fixture.json', JSON.stringify(fixture, null, 2) + '\n'),
      fixtureSha256: digest(JSON.stringify(fixture)),
      sourceBlobs: selected.map(source => ({
        path: source.path, baseGitBlob: source.blob,
        actualGitBlob: gitBlob(source.bytes),
        source: save('sources/' + source.path, source.bytes),
        loadedFromFrozenBlob: loadedFrozenSources.has(source.path),
      })),
      environment: {
        node: process.version, versions: process.versions,
        nodeExecutableSha256: digest(readFileSync(process.execPath)),
        platform: process.platform, arch: process.arch,
        requestedTimezone: process.env.TZ,
        intl: Intl.DateTimeFormat().resolvedOptions(),
        nodeEnv: process.env.NODE_ENV ?? null,
        osRelease: readFileSync('/etc/os-release', 'utf8'),
        pnpmLockSha256: digest(readFileSync(join(repository, 'pnpm-lock.yaml'))),
        packages: ['typescript', 'react', 'react-dom/server', '@react-email/render',
          '@react-email/components', '@nestjs/common', '@eken/shared'].map(packageEvidence),
        sharedBrandingSha256: digest(readFileSync(join(dirname(shared), 'constants/branding.js'))),
      },
      renders,
    }
    save('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
    assert.deepEqual(readFileSync(join(output, renders[0].html.file)), readFileSync(join(output, renders[1].html.file)))
    assert.deepEqual(readFileSync(join(output, renders[0].text.file)), readFileSync(join(output, renders[1].text.file)))
    console.log(JSON.stringify({ mode, output, timezone: process.env.TZ, fixtureSha256: manifest.fixtureSha256 }))
  } finally {
    for (const extension of ['.ts', '.tsx']) {
      if (extensions[extension]) require.extensions[extension] = extensions[extension]
      else delete require.extensions[extension]
    }
    tsNode.enabled(false)
  }
}

function readExtraMailCapture(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.series, 'late-invoice-reminder-source-replay')
  assert.equal(manifest.baseSha, BASE_SHA)
  if (manifest.mode === 'before') assert.equal(manifest.applicationSourceSha, BASE_SHA)
  const artifact = metadata => {
    assert.ok(!metadata.file.split(/[\\/]/).includes('..'), 'Artifact must remain in its capture')
    const bytes = readFileSync(join(directory, metadata.file))
    assert.equal(bytes.length, metadata.bytes)
    assert.equal(digest(bytes), metadata.sha256)
    return bytes
  }
  assert.deepEqual(JSON.parse(artifact(manifest.fixture).toString()), fixture)
  assert.equal(manifest.fixtureSha256, digest(JSON.stringify(fixture)))
  const frozen = sourcesAtBase()
  assert.deepEqual(manifest.sourceBlobs.map(source => [source.path, source.baseGitBlob]),
    frozen.map(source => [source.path, source.blob]))
  for (const source of manifest.sourceBlobs) {
    assert.equal(gitBlob(artifact(source.source)), source.actualGitBlob)
    if (manifest.mode === 'before') assert.equal(source.actualGitBlob, source.baseGitBlob)
    else assert.equal(source.actualGitBlob, gitBlob(readFileSync(join(repository, source.path))))
  }
  assert.equal(manifest.renders.length, 2)
  const first = { html: artifact(manifest.renders[0].html), text: artifact(manifest.renders[0].text) }
  for (const kind of ['html', 'text']) assert.deepEqual(first[kind], artifact(manifest.renders[1][kind]))
  return { manifest, ...first }
}

function assertExtraMailComparison({ beforeUtc, beforeStockholm, afterUtc, afterStockholm }) {
  const captures = [beforeUtc, beforeStockholm, afterUtc, afterStockholm].map(readExtraMailCapture)
  const [beforeU, beforeS, afterU, afterS] = captures
  assert.deepEqual(captures.map(item => item.manifest.mode), ['before', 'before', 'after', 'after'])
  assert.deepEqual(captures.map(item => item.manifest.environment.requestedTimezone),
    ['UTC', 'Europe/Stockholm', 'UTC', 'Europe/Stockholm'])
  // Historical and CI hosts can reuse PID numbers; prove distinct processes within each pair.
  assert.notEqual(beforeU.manifest.pid, beforeS.manifest.pid)
  assert.notEqual(afterU.manifest.pid, afterS.manifest.pid)
  const comparisons = []
  for (const kind of ['html', 'text']) {
    assert.deepEqual(afterU[kind], beforeU[kind], 'UTC must retain every raw byte: ' + kind)
    assert.deepEqual(afterS[kind], afterU[kind], 'Explicit UTC must survive host timezone: ' + kind)
    const oldDate = Buffer.from('12 september 2026')
    const newDate = Buffer.from('11 september 2026')
    const offset = beforeS[kind].indexOf(oldDate)
    assert.ok(offset >= 0, 'Old Stockholm due date must be visible: ' + kind)
    assert.equal(beforeS[kind].indexOf(oldDate, offset + oldDate.length), -1, 'Exactly one declared field')
    assert.notDeepEqual(beforeS[kind], afterS[kind], 'Declared visible change must occur')
    const declaredAfter = Buffer.concat([
      beforeS[kind].subarray(0, offset), newDate, beforeS[kind].subarray(offset + oldDate.length),
    ])
    assert.deepEqual(afterS[kind], declaredAfter, 'Any other Stockholm byte change is forbidden: ' + kind)
    comparisons.push({ kind, beforeUtc: digest(beforeU[kind]), afterUtc: digest(afterU[kind]),
      beforeStockholm: digest(beforeS[kind]), afterStockholm: digest(afterS[kind]),
      declaredField: 'body.dueDate', offset, before: oldDate.toString(), after: newDate.toString() })
  }
  return comparisons
}

module.exports = { readExtraMailCapture, assertExtraMailComparison }
if (require.main === module) {
  capture(process.argv[2], process.argv[3]).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
