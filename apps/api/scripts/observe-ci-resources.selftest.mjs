import assert from 'node:assert/strict'
import {
  parseProcStat,
  parseRssKiB,
  parseCounters,
  parsePressure,
  resolveCgroupV2,
  counterDelta,
} from './observe-ci-resources.mjs'

let assertions = 0
function check(name, fn) {
  fn()
  assertions++
  console.log('PASS ' + name)
}
function stat(pid, ppid, start = 100, state = 'S', user = 7, system = 3) {
  const fields = Array(50).fill('0')
  fields[0] = state
  fields[1] = String(ppid)
  fields[11] = String(user)
  fields[12] = String(system)
  fields[19] = String(start)
  return pid + ' (synthetic ) private name) ' + fields.join(' ')
}

check('stat uses final closing parenthesis and numeric identity', () => {
  const s = parseProcStat(stat(31, 30))
  assert.equal(s.pid, 31)
  assert.equal(s.ppid, 30)
  assert.equal(s.startTimeTicks, 100n)
  assert.equal(s.cpuTicks, 10n)
  assert.equal(s.state, 'S')
  assert.equal(
    JSON.stringify({
      ...s,
      startTimeTicks: String(s.startTimeTicks),
      cpuTicks: String(s.cpuTicks),
    }).includes('private name'),
    false,
  )
})
check('malformed stat is unavailable', () => {
  assert.equal(parseProcStat('private marker'), null)
  assert.equal(parseProcStat('31 (x) S'), null)
})
check('PID reuse is a different identity; zombie state remains visible', () => {
  assert.notEqual(
    parseProcStat(stat(31, 30, 100)).startTimeTicks,
    parseProcStat(stat(31, 30, 101)).startTimeTicks,
  )
  assert.equal(parseProcStat(stat(10, 1, 100, 'Z')).state, 'Z')
})
check('RSS is KiB, missing is not zero', () => {
  assert.equal(parseRssKiB('Name: private marker\nVmRSS:\t4096 kB\n'), 4096)
  assert.equal(parseRssKiB('VmSize: 4096 kB\n'), null)
  assert.equal(parseRssKiB('VmRSS: garbage kB\n'), null)
  assert.equal(parseRssKiB('VmRSS: 0 kB\n'), 0)
})
check('counter delta is exact only for present monotone safe counters', () => {
  assert.equal(counterDelta(1000002n, 1000000n), 2)
  assert.equal(counterDelta(0n, 0n), 0)
  assert.equal(counterDelta(1n, 2n), null)
  assert.equal(counterDelta(null, 2n), null)
  assert.equal(counterDelta(2n, null), null)
  assert.equal(counterDelta(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n), null)
})
check('cgroup counters preserve large values without precision loss', () => {
  const c = parseCounters('usage_usec 9007199254740995\nnr_throttled 2\n')
  assert.equal(c.get('usage_usec'), 9007199254740995n)
  assert.equal(c.get('nr_throttled'), 2n)
  assert.equal(c.has('oom_kill'), false)
})
check('PSI reports fixed numeric values, not arbitrary input', () => {
  const p = parsePressure(
    'some avg10=1.25 avg60=2 avg300=3 total=1234\nfull avg10=0.50 avg60=0 avg300=0 total=25\n',
  )
  assert.equal(p.someAvg10, 1.25)
  assert.equal(p.fullAvg10, 0.5)
  assert.equal(p.someTotalUs, 1234n)
  assert.equal(p.fullTotalUs, 25n)
  assert.equal(parsePressure('private marker'), null)
})
check('unified cgroup resolves under the actual mount', () => {
  assert.equal(
    resolveCgroupV2('29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n', '0::/runner/test\n'),
    '/sys/fs/cgroup/runner/test',
  )
  assert.equal(
    resolveCgroupV2(
      '29 23 0:26 /runner /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
      '0::/runner/test\n',
    ),
    '/sys/fs/cgroup/test',
  )
})
check('missing cgroup v2 cannot be presented as zero use', () => {
  assert.equal(resolveCgroupV2('', '0::/runner\n'), null)
  assert.equal(
    resolveCgroupV2('29 23 0:26 / /sys/fs/cgroup rw - cgroup cgroup rw\n', '1:cpu:/runner\n'),
    null,
  )
})
console.log('Parser checks passed: ' + assertions)

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const moduleUrl = new URL('./observe-ci-resources.mjs', import.meta.url).href
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fakeObserver = (mode) =>
  [
    'import { runObserver } from ' + JSON.stringify(moduleUrl),
    'import { writeFile } from "node:fs/promises"',
    'const mode = ' + JSON.stringify(mode),
    'const parentPid = Number(process.argv[1]) || process.ppid',
    'let parentStart = 100',
    'function stat(pid,ppid,start=100,state="S") {',
    ' const f=Array(50).fill("0"); f[0]=state; f[1]=String(ppid); f[19]=String(start)',
    ' return pid+" (PRIVATE_STAT_MARKER) "+f.join(" ")',
    '}',
    'const readText = async (path) => {',
    ' if(mode==="signal") { console.log("INITIAL_READ_ENTERED"); return new Promise(()=>{}) }',
    ' if(path==="/proc/"+parentPid+"/stat") {',
    '  if(mode==="shell") { try { process.kill(parentPid,0) } catch { throw Object.assign(new Error("PRIVATE_ERROR_MARKER"),{code:"ESRCH"}) } }',
    '  return stat(parentPid,1,parentStart)',
    ' }',
    ' if(path==="/proc/"+process.pid+"/stat") return stat(process.pid,parentPid)',
    ' throw new Error("PRIVATE_ERROR_MARKER")',
    '}',
    'const listPids=async()=>{if(mode==="shell") await writeFile(process.argv[2],"snapshot_entered"); console.log("SNAPSHOT_ENTERED"); return new Promise(()=>{})}',
    'runObserver({parentPid,platform:"linux",readText,listPids,sampleIntervalMs:25,livenessIntervalMs:10})',
    'if(mode==="reuse") setTimeout(()=>{parentStart=101},80)',
    'if(mode==="signal") setInterval(()=>{},1000)',
    'console.log("OBSERVER_READY")',
  ].join('\n')

const ownedGroups = []
function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (e) {
    if (e.code !== 'ESRCH') throw e
  }
}
function launch(command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d
  })
  child.stderr.on('data', (d) => {
    output += d
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
  const p = { child, done, output: () => output }
  ownedGroups.push(p)
  return p
}
async function bounded(done, label, child) {
  let timer
  try {
    return await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          killGroup(child.pid)
          reject(new Error(label + ' exceeded 5 seconds'))
        }, 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return
    await sleep(10)
  }
  throw new Error('synchronization marker missing')
}

try {
  {
    const p = launch(process.execPath, ['--input-type=module', '-e', fakeObserver('reuse')])
    const r = await bounded(p.done, 'parent reuse', p.child)
    assert.equal(r.code, 0)
    assert.equal(r.signal, null)
    assert.match(r.output, /parent_reused/)
    assert.match(r.output, /SNAPSHOT_ENTERED/)
    assert.equal(r.output.includes('PRIVATE_'), false)
    console.log('PASS parent identity change stops observer during unfinished snapshot')
  }
  {
    const p = launch(process.execPath, ['--input-type=module', '-e', fakeObserver('signal')])
    await until(() => p.output().includes('INITIAL_READ_ENTERED'))
    p.child.kill('SIGTERM')
    const r = await bounded(p.done, 'signal during initial read', p.child)
    assert.equal(r.code, 0)
    assert.equal(r.signal, null)
    assert.equal(r.output.includes('PRIVATE_'), false)
    console.log('PASS signal stops observer during unfinished initial read')
  }
  {
    const dir = await mkdtemp(join(tmpdir(), 'ci-resource-selftest-'))
    try {
      const ready = join(dir, 'ready')
      const sibling = join(dir, 'sibling-finished')
      const release = join(dir, 'release')
      const testCommand = [
        'import { access } from "node:fs/promises"',
        'import { spawn } from "node:child_process"',
        'const until = Date.now()+3000',
        'while(true) {',
        ' try {await access(process.argv[1]);break} catch {}',
        ' if(Date.now()>until) process.exit(91)',
        ' await new Promise(r=>setTimeout(r,10))',
        '}',
        'const child=spawn(process.execPath,["--input-type=module","-e",',
        '"import {access,writeFile} from \\"node:fs/promises\\"; const end=Date.now()+4000; while(true){try{await access(process.argv[2]);break}catch{} if(Date.now()>end)process.exit(93); await new Promise(r=>setTimeout(r,10))} await writeFile(process.argv[1],\\"alive\\")",',
        'process.argv[2],process.argv[3]],{stdio:"ignore"})',
        'child.unref()',
        'process.exit(7)',
      ].join('\n')
      // Same background-observer + unchanged-command shape as CI.
      // Scripts are positional arguments, never interpolated into shell code.
      const start = performance.now()
      const p = launch('/bin/bash', [
        '-e',
        '-c',
        '"$1" --input-type=module -e "$2" "$$" "$4" &\n"$1" --input-type=module -e "$3" "$4" "$5" "$6"',
        'resource-selftest',
        process.execPath,
        fakeObserver('shell'),
        testCommand,
        ready,
        sibling,
        release,
      ])
      const r = await bounded(p.done, 'bash exit and pipe closure', p.child)
      assert.equal(r.code, 7)
      assert.equal(r.signal, null)
      assert.equal(r.output.includes('PRIVATE_'), false)
      assert.match(r.output, /SNAPSHOT_ENTERED/)
      assert.match(r.output, /parent_missing/)
      await writeFile(release, 'observer_closed')
      await until(async () => {
        try {
          return (await readFile(sibling, 'utf8')) === 'alive'
        } catch {
          return false
        }
      })
      console.log(
        'PASS bash exit 7 preserved, pending snapshot observer exits, sibling untouched; pipe closed in ' +
          Math.round(performance.now() - start) +
          'ms',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
} finally {
  for (const p of ownedGroups) {
    killGroup(p.child.pid)
    await Promise.race([p.done, sleep(1000)])
  }
}

// The sampler reads synthetic proc/cgroup files; it never sees customer data.
import { readSnapshot, runObserver } from './observe-ci-resources.mjs'
function fixture(parentPid = 10, selfPid = 20) {
  const files = new Map([
    ['/proc/' + parentPid + '/stat', stat(parentPid, 1)],
    ['/proc/' + selfPid + '/stat', stat(selfPid, parentPid)],
    ['/proc/30/stat', stat(30, parentPid)],
    ['/proc/31/stat', stat(31, 30)],
    ['/proc/40/stat', stat(40, 1)],
    ['/proc/30/status', 'Name: PRIVATE_NAME\nVmRSS: 1000 kB\n'],
    ['/proc/31/status', 'Name: PRIVATE_NAME\nVmRSS: 2000 kB\n'],
    ['/proc/' + parentPid + '/mountinfo', '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'],
    ['/proc/' + parentPid + '/cgroup', '0::/synthetic\n'],
    [
      '/sys/fs/cgroup/synthetic/cpu.stat',
      'usage_usec 1000000\nthrottled_usec 200\nnr_throttled 3\n',
    ],
    ['/sys/fs/cgroup/synthetic/memory.current', '123456\n'],
    ['/sys/fs/cgroup/synthetic/memory.events', 'high 1\nmax 2\noom 3\noom_kill 4\n'],
    ...['cpu', 'memory', 'io'].map((name) => [
      '/sys/fs/cgroup/synthetic/' + name + '.pressure',
      'some avg10=1.00 avg60=1.00 avg300=1.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    ]),
  ])
  const reads = []
  const readText = async (path) => {
    reads.push(path)
    if (!files.has(path)) throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'ENOENT' })
    return files.get(path)
  }
  return {
    files,
    reads,
    readText,
    listPids: async () => [String(parentPid), String(selfPid), '30', '31', '40'],
    parentPid,
    selfPid,
    parentStartTimeTicks: 100n,
  }
}
{
  const f = fixture(),
    snap = await readSnapshot(f)
  assert.equal(snap.status, 'ok')
  assert.deepEqual([...snap.processes.keys()].sort(), [30, 31])
  assert.equal(snap.processes.get(30).rssKiB, 1000)
  assert.equal(snap.processes.get(31).rssKiB, 2000)
  assert.equal(snap.cgroup.cpuUsageUs, 1000000n)
  assert.equal(snap.cgroup.memoryBytes, 123456n)
  assert.equal(snap.cgroup.oomKill, 4n)
  assert.equal(f.reads.includes('/proc/20/status'), false)
  assert.equal(
    f.reads.some((path) => /cmdline|environ/.test(path)),
    false,
  )
  console.log(
    'PASS snapshot scopes descendants, excludes observer/foreign process, reads only metric files',
  )
}
{
  const f = fixture()
  const original = f.readText
  let childReads = 0
  f.readText = async (path) =>
    path === '/proc/30/stat' && ++childReads > 1 ? stat(30, 10, 101) : original(path)
  const snap = await readSnapshot(f)
  assert.equal(snap.status, 'partial')
  assert.equal(snap.identityChanges, 1)
  assert.equal(snap.processes.has(30), false)
  console.log('PASS PID reuse between stat and RSS is excluded, not charged to old identity')
}
{
  const f = fixture()
  f.files.delete('/proc/31/status')
  f.files.delete('/proc/10/cgroup')
  const snap = await readSnapshot(f)
  assert.equal(snap.status, 'partial')
  assert.equal(snap.rssErrors, 1)
  assert.equal(snap.cgroup.status, 'unavailable')
  assert.equal(snap.cgroup.cpuUsageUs, null)
  console.log('PASS disappeared process and missing cgroup stay partial/unavailable')
}
{
  const f = fixture()
  f.listPids = async () => ['10', '20', ...Array.from({ length: 600 }, (_, i) => String(i + 100))]
  const original = f.readText
  f.readText = async (path) => {
    const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(path)
    if (match && Number(match[1]) >= 100)
      return match[2] === 'stat' ? stat(Number(match[1]), 10) : 'VmRSS: 1 kB\n'
    return original(path)
  }
  const snap = await readSnapshot(f)
  assert.equal(snap.status, 'partial')
  assert.equal(snap.descendantLimit, true)
  assert.equal(snap.processes.size, 512)
  f.listPids = async () => Array.from({ length: 5000 }, (_, i) => String(i + 100))
  const host = await readSnapshot(f)
  assert.equal(host.hostLimit, true)
  assert.equal(host.hostPidsScanned, 4096)
  console.log('PASS both proc enumeration and descendant retention are bounded')
}
{
  const f = fixture(process.ppid, process.pid)
  const rows = []
  let exitCode
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('log cap test exceeded 3s')), 3000)
    runObserver({
      ...f,
      platform: 'linux',
      sampleIntervalMs: 1,
      livenessIntervalMs: 5,
      writeLine: (line) => rows.push(JSON.parse(line)),
      exit: (code) => {
        exitCode = code
        clearTimeout(timer)
        resolve()
      },
    })
  })
  assert.equal(exitCode, 0)
  assert.equal(rows.length, 64)
  assert.equal(rows.at(-1).status, 'row_limit')
  assert.equal(
    rows.some((row) => row.kind === 'sample'),
    true,
  )
  assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false)
  assert.equal(
    rows.filter((row) => row.kind === 'sample').every((row) => row.descendants === 2),
    true,
  )
  console.log(
    'PASS bounded 64-row logs with real sampler, no raw names/errors, no overlapping lifecycle',
  )
}

{
  const f = fixture(process.ppid, process.pid)
  const samples = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('counter sequence exceeded 3s')), 3000)
    runObserver({
      ...f,
      platform: 'linux',
      sampleIntervalMs: 2,
      livenessIntervalMs: 10,
      writeLine: (line) => {
        const row = JSON.parse(line)
        if (row.kind !== 'sample') return
        samples.push(row)
        if (samples.length === 1) {
          f.files.set('/proc/30/stat', stat(30, process.ppid, 100, 'S', 10, 10))
          f.files.set(
            '/sys/fs/cgroup/synthetic/cpu.stat',
            'usage_usec 1000500\nthrottled_usec 210\nnr_throttled 4\n',
          )
        } else if (samples.length === 2) {
          // Same identity but a reset counter is unknown, never a new process.
          f.files.set('/proc/30/stat', stat(30, process.ppid, 100, 'S', 2, 3))
          f.files.set(
            '/sys/fs/cgroup/synthetic/cpu.stat',
            'usage_usec 1000100\nthrottled_usec 10\nnr_throttled 1\n',
          )
        } else if (samples.length === 3) {
          f.files.set('/proc/' + process.ppid + '/cgroup', '0::/moved\n')
          for (const [path, value] of [...f.files]) {
            if (path.startsWith('/sys/fs/cgroup/synthetic/'))
              f.files.set(path.replace('/synthetic/', '/moved/'), value)
          }
        } else if (samples.length === 4) {
          process.emit('SIGTERM')
        }
      },
      exit: (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error('unexpected observer exit'))
        else resolve()
      },
    })
  })
  assert.equal(samples.length, 4)
  assert.equal(samples[1].observedCpuTickDelta, 10)
  assert.equal(samples[1].newObservedProcesses, 0)
  assert.equal(samples[1].cgroup.cpuUsageUsDelta, 500)
  assert.equal(samples[2].cpuDeltaUnavailable, 1)
  assert.equal(samples[2].newObservedProcesses, 0)
  assert.equal(samples[2].cgroup.cpuUsageUsDelta, null)
  assert.equal(samples[3].cgroup.cpuUsageUsDelta, null)
  assert.equal(JSON.stringify(samples).includes('/moved'), false)
  console.log('PASS CPU deltas, reset counters and cgroup identity changes are distinguished')
}

console.log('Resource observer self-tests passed')
