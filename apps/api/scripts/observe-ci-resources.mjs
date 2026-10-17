// Read-only Linux observer. No spawn, kill, cmdline, environ or source reads.
import { readFile, opendir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { posix } from 'node:path'

const HOST_CAP = 4096,
  DESCENDANT_CAP = 512,
  ROW_CAP = 64
const unsigned = (s) => (typeof s === 'string' && /^\d{1,30}$/.test(s) ? BigInt(s) : null)
const safeNumber = (n) =>
  n !== null && n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null
const pidNumber = (s) => (/^[1-9]\d{0,9}$/.test(s) && Number(s) <= 2147483647 ? Number(s) : null)

export function counterDelta(current, previous) {
  return typeof current === 'bigint' &&
    typeof previous === 'bigint' &&
    previous >= 0n &&
    current >= previous
    ? safeNumber(current - previous)
    : null
}
export function parseProcStat(text) {
  if (typeof text !== 'string') return null
  const head = /^([1-9]\d*) \(/.exec(text),
    end = text.lastIndexOf(') ')
  if (!head || end < head[0].length) return null
  const fields = text
      .slice(end + 2)
      .trim()
      .split(/\s+/),
    pid = pidNumber(head[1])
  const ppid = unsigned(fields[1]),
    user = unsigned(fields[11]),
    system = unsigned(fields[12]),
    start = unsigned(fields[19])
  if (
    !pid ||
    !/^[A-Za-z]$/.test(fields[0] ?? '') ||
    ppid === null ||
    ppid > 2147483647n ||
    user === null ||
    system === null ||
    start === null
  )
    return null
  return {
    pid,
    ppid: Number(ppid),
    state: fields[0],
    startTimeTicks: start,
    cpuTicks: user + system,
  }
}
export function parseRssKiB(text) {
  if (typeof text !== 'string') return null
  const lines = text.split('\n').filter((line) => line.startsWith('VmRSS:'))
  if (lines.length !== 1) return null
  const m = /^VmRSS:[ \t]+(\d+)[ \t]+kB[ \t]*$/.exec(lines[0])
  return m ? safeNumber(unsigned(m[1])) : null
}
export function parseCounters(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const result = new Map()
  for (const line of text.trim().split('\n')) {
    const m = /^([a-z_]+)[ \t]+(\d+)[ \t]*$/.exec(line),
      value = m && unsigned(m[2])
    if (!m || value === null || result.has(m[1])) return null
    result.set(m[1], value)
  }
  return result
}
export function parsePressure(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const result = { someAvg10: null, fullAvg10: null, someTotalUs: null, fullTotalUs: null },
    seen = new Set()
  for (const line of text.trim().split('\n')) {
    const m =
      /^(some|full) avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=(\d+(?:\.\d+)?) total=(\d+)$/.exec(
        line,
      )
    if (
      !m ||
      seen.has(m[1]) ||
      m.slice(2, 5).some((v) => !Number.isFinite(Number(v)) || Number(v) > 100)
    )
      return null
    const total = unsigned(m[5])
    if (total === null) return null
    seen.add(m[1])
    result[m[1] + 'Avg10'] = Number(m[2])
    result[m[1] + 'TotalUs'] = total
  }
  return seen.has('some') ? result : null
}
export function resolveCgroupV2(mountinfo, cgroup) {
  if (typeof mountinfo !== 'string' || typeof cgroup !== 'string') return null
  const memberships = cgroup.split('\n').filter((line) => line.startsWith('0::'))
  if (memberships.length !== 1) return null
  const group = memberships[0].slice(3)
  const validPath = (s) =>
    s.startsWith('/') &&
    !s.includes('\0') &&
    !s.split('/').includes('..') &&
    posix.normalize(s) === s
  if (!validPath(group)) return null
  const decode = (s) =>
    s.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)))
  const candidates = []
  for (const line of mountinfo.split('\n')) {
    const parts = line.split(' - ')
    if (parts.length !== 2 || parts[1].split(' ')[0] !== 'cgroup2') continue
    const fields = parts[0].split(' ')
    if (fields.length < 6) continue
    const root = decode(fields[3]),
      mount = decode(fields[4])
    if (
      !validPath(root) ||
      !validPath(mount) ||
      !(root === '/' || group === root || group.startsWith(root + '/'))
    )
      continue
    candidates.push({
      root,
      path: posix.join(mount, root === '/' ? group.slice(1) : group.slice(root.length)),
    })
  }
  candidates.sort((a, b) => b.root.length - a.root.length)
  if (
    !candidates.length ||
    (candidates[1]?.root.length === candidates[0].root.length &&
      candidates[1].path !== candidates[0].path)
  )
    return null
  return candidates[0].path
}
const emptyGroup = () => ({
  identity: null,
  status: 'unavailable',
  cpuUsageUs: null,
  throttledUs: null,
  throttledCount: null,
  memoryBytes: null,
  memoryHighEvents: null,
  memoryMaxEvents: null,
  oom: null,
  oomKill: null,
  cpuPressure: null,
  memoryPressure: null,
  ioPressure: null,
})
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH'
async function parentState(readText, pid, start) {
  try {
    const stat = parseProcStat(await readText(`/proc/${pid}/stat`))
    if (!stat || stat.pid !== pid) return { status: 'parent_unavailable', stat: null }
    if (start !== undefined && stat.startTimeTicks !== start)
      return { status: 'parent_reused', stat }
    return { status: stat.state === 'Z' || stat.state === 'X' ? 'parent_dead' : 'ok', stat }
  } catch (error) {
    return { status: missing(error) ? 'parent_missing' : 'parent_unavailable', stat: null }
  }
}
async function readGroup(readText, pid) {
  const result = emptyGroup()
  try {
    const [mounts, membership] = await Promise.all([
      readText(`/proc/${pid}/mountinfo`),
      readText(`/proc/${pid}/cgroup`),
    ])
    const path = resolveCgroupV2(mounts, membership)
    if (!path) return result
    result.identity = path // Internal only: never log a cgroup path; do not delta across a move.
    const names = [
      'cpu.stat',
      'memory.current',
      'memory.events',
      'cpu.pressure',
      'memory.pressure',
      'io.pressure',
    ]
    const values = await Promise.all(
      names.map((name) => readText(`${path}/${name}`).catch(() => null)),
    )
    const cpu = parseCounters(values[0]),
      mem = parseCounters(values[2])
    result.cpuUsageUs = cpu?.get('usage_usec') ?? null
    result.throttledUs = cpu?.get('throttled_usec') ?? null
    result.throttledCount = cpu?.get('nr_throttled') ?? null
    result.memoryBytes = values[1] === null ? null : unsigned(values[1].trim())
    for (const [field, key] of [
      ['memoryHighEvents', 'high'],
      ['memoryMaxEvents', 'max'],
      ['oom', 'oom'],
      ['oomKill', 'oom_kill'],
    ])
      result[field] = mem?.get(key) ?? null
    result.cpuPressure = parsePressure(values[3])
    result.memoryPressure = parsePressure(values[4])
    result.ioPressure = parsePressure(values[5])
    result.status = Object.entries(result)
      .filter(([key]) => key !== 'status')
      .every(([, value]) => value !== null)
      ? 'ok'
      : 'partial'
  } catch {
    /* Missing/malformed/unresolvable cgroup is unavailable, never numeric zero. */
  }
  return result
}
export async function readSnapshot({
  parentPid,
  parentStartTimeTicks,
  selfPid,
  readText,
  listPids,
}) {
  const result = {
    status: 'ok',
    hostPidsScanned: 0,
    descendants: 0,
    hostLimit: false,
    descendantLimit: false,
    statErrors: 0,
    rssErrors: 0,
    identityChanges: 0,
    processes: new Map(),
    cgroup: emptyGroup(),
  }
  const first = await parentState(readText, parentPid, parentStartTimeTicks)
  if (first.status !== 'ok') return { ...result, status: first.status }
  let pids
  try {
    pids = await listPids()
  } catch {
    return { ...result, status: 'proc_unavailable' }
  }
  if (!Array.isArray(pids)) return { ...result, status: 'proc_unavailable' }
  result.hostLimit = pids.length > HOST_CAP
  const stats = new Map(),
    ids = pids.slice(0, HOST_CAP)
  for (let offset = 0; offset < ids.length; offset += 16)
    await Promise.all(
      ids.slice(offset, offset + 16).map(async (name) => {
        const pid = typeof name === 'string' ? pidNumber(name) : null
        if (!pid) {
          result.statErrors++
          return
        }
        if (pid === selfPid) return
        result.hostPidsScanned++
        try {
          const stat = parseProcStat(await readText(`/proc/${pid}/stat`))
          if (!stat || stat.pid !== pid) result.statErrors++
          else stats.set(pid, stat)
        } catch {
          result.statErrors++
        }
      }),
    )
  const children = new Map()
  for (const stat of stats.values()) {
    const list = children.get(stat.ppid) ?? []
    list.push(stat)
    children.set(stat.ppid, list)
  }
  const selected = [],
    queue = [parentPid],
    seen = new Set([parentPid, selfPid])
  for (let at = 0; at < queue.length; at++) {
    for (const child of children.get(queue[at]) ?? []) {
      if (seen.has(child.pid)) continue
      if (selected.length === DESCENDANT_CAP) {
        result.descendantLimit = true
        break
      }
      seen.add(child.pid)
      selected.push(child)
      queue.push(child.pid)
    }
    if (result.descendantLimit) break
  }
  result.descendants = selected.length
  for (let offset = 0; offset < selected.length; offset += 16)
    await Promise.all(
      selected.slice(offset, offset + 16).map(async (stat) => {
        try {
          const rss = parseRssKiB(await readText(`/proc/${stat.pid}/status`))
          const current = parseProcStat(await readText(`/proc/${stat.pid}/stat`))
          if (
            !current ||
            current.startTimeTicks !== stat.startTimeTicks ||
            current.pid !== stat.pid ||
            current.ppid !== stat.ppid
          ) {
            result.identityChanges++
            return
          }
          if (rss === null) result.rssErrors++
          result.processes.set(stat.pid, {
            startTimeTicks: current.startTimeTicks,
            cpuTicks: current.cpuTicks,
            rssKiB: rss,
          })
        } catch {
          result.rssErrors++
        }
      }),
    )
  result.cgroup = await readGroup(readText, parentPid)
  const last = await parentState(readText, parentPid, parentStartTimeTicks)
  result.status =
    last.status !== 'ok'
      ? last.status
      : result.hostLimit ||
          result.descendantLimit ||
          result.statErrors ||
          result.rssErrors ||
          result.identityChanges ||
          result.cgroup.status !== 'ok'
        ? 'partial'
        : 'ok'
  return result
}
function groupOutput(current, previous) {
  const output = { scope: 'parent_cgroup_v2_may_include_non_api', status: current.status }
  if (current.identity === null || current.identity !== previous?.identity) previous = null
  for (const field of [
    'cpuUsageUs',
    'throttledUs',
    'throttledCount',
    'memoryBytes',
    'memoryHighEvents',
    'memoryMaxEvents',
    'oom',
    'oomKill',
  ]) {
    output[field] = safeNumber(current[field])
    if (field !== 'memoryBytes')
      output[field + 'Delta'] = counterDelta(current[field], previous?.[field] ?? null)
  }
  for (const field of ['cpuPressure', 'memoryPressure', 'ioPressure']) {
    const value = current[field]
    output[field] = value
      ? {
          someAvg10: value.someAvg10,
          fullAvg10: value.fullAvg10,
          someTotalUs: safeNumber(value.someTotalUs),
          fullTotalUs: safeNumber(value.fullTotalUs),
        }
      : null
  }
  return output
}
export function runObserver({
  parentPid,
  readText,
  listPids,
  platform = process.platform,
  sampleIntervalMs = 30000,
  livenessIntervalMs = 1000,
  writeLine = (line) => process.stdout.write(line + '\n'),
  exit = (code) => process.exit(code),
}) {
  let stopped = false,
    rows = 0,
    sampling = false,
    checking = false,
    parentStart,
    sampleTimer,
    liveTimer
  let previous = null,
    cached = null,
    livenessErrors = 0,
    samples = 0
  const started = performance.now(),
    cpuStart = process.cpuUsage()
  function emit(kind, status, data = {}) {
    if (rows >= ROW_CAP) return
    rows++
    try {
      writeLine(
        JSON.stringify({
          version: 1,
          kind,
          status,
          row: rows,
          elapsedMs: Math.round(performance.now() - started),
          ...data,
        }),
      )
    } catch {
      halt(0)
    } // A closed log must not emit a raw error or affect the test process.
  }
  function halt(code, reason) {
    if (stopped) return
    stopped = true
    clearInterval(sampleTimer)
    clearInterval(liveTimer)
    process.removeListener('SIGTERM', term)
    process.removeListener('SIGINT', interrupt)
    try {
      if (reason) emit('stop', reason, { samples, livenessErrors, lastSample: cached })
    } finally {
      exit(code)
    }
  }
  const stop = (reason, code = 0) => halt(code, reason)
  const term = () => stop('sigterm'),
    interrupt = () => stop('sigint')
  process.on('SIGTERM', term)
  process.on('SIGINT', interrupt)
  process.stdout.on('error', () => halt(0)) // Keep guarded until exit, including errors from a final buffered write.
  if (platform !== 'linux') {
    stop('unsupported_platform')
    return
  }
  if (
    !Number.isInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid !== process.ppid ||
    !Number.isFinite(sampleIntervalMs) ||
    sampleIntervalMs < 1 ||
    !Number.isFinite(livenessIntervalMs) ||
    livenessIntervalMs < 1
  ) {
    stop('invalid_configuration', 2)
    return
  }
  async function check() {
    if (stopped || checking) return
    checking = true
    try {
      const state = await parentState(readText, parentPid, parentStart)
      if (stopped) return
      if (state.status === 'parent_unavailable') livenessErrors++
      else if (state.status !== 'ok') stop(state.status)
    } finally {
      checking = false
    }
  }
  async function sample() {
    if (stopped || sampling) return
    if (rows >= ROW_CAP - 1) {
      stop('row_limit')
      return
    }
    sampling = true
    const at = performance.now(),
      cpu = process.cpuUsage()
    try {
      const snap = await readSnapshot({
        parentPid,
        parentStartTimeTicks: parentStart,
        selfPid: process.pid,
        readText,
        listPids,
      })
      if (stopped) return
      if (['parent_missing', 'parent_reused', 'parent_dead'].includes(snap.status)) {
        stop(snap.status)
        return
      }
      let ticks = 0n,
        matched = 0,
        newObserved = 0,
        cpuDeltaUnavailable = 0,
        rss = 0n,
        rssKnown = 0
      const top = []
      for (const [pid, stat] of snap.processes) {
        const old = previous?.processes.get(pid),
          same = old?.startTimeTicks === stat.startTimeTicks
        const delta = same ? counterDelta(stat.cpuTicks, old.cpuTicks) : null
        if (delta !== null) {
          ticks += BigInt(delta)
          matched++
        } else if (!same) newObserved++
        else cpuDeltaUnavailable++
        if (stat.rssKiB !== null) {
          rss += BigInt(stat.rssKiB)
          rssKnown++
          top.push(stat.rssKiB)
          top.sort((a, b) => b - a)
          if (top.length > 5) top.pop()
        }
      }
      const cost = process.cpuUsage(cpu),
        totalCost = process.cpuUsage(cpuStart)
      cached = {
        samples: ++samples,
        sampleMs: Math.round(performance.now() - at),
        livenessErrors,
        hostPidsScanned: snap.hostPidsScanned,
        descendants: snap.descendants,
        hostLimit: snap.hostLimit,
        descendantLimit: snap.descendantLimit,
        statErrors: snap.statErrors,
        rssErrors: snap.rssErrors,
        identityChanges: snap.identityChanges,
        processScope: 'sampled_descendants_excluding_observer',
        rssScope: 'sum_rss_double_counts_shared_pages',
        sampledRssKiB: rssKnown
          ? safeNumber(rss)
          : snap.descendants === 0 && snap.status === 'ok'
            ? 0
            : null,
        rssKnown,
        topRssKiB: top,
        observedCpuTickDelta: matched ? safeNumber(ticks) : null,
        matchedProcesses: matched,
        newObservedProcesses: newObserved,
        cpuDeltaUnavailable,
        observerCpuUs: cost.user + cost.system,
        observerTotalCpuUs: totalCost.user + totalCost.system,
        observerMaxRssKiB: process.resourceUsage().maxRSS,
        cgroup: groupOutput(snap.cgroup, previous?.cgroup),
      }
      previous = snap
      emit('sample', snap.status, cached)
    } catch {
      if (!stopped) {
        samples++
        emit('sample', 'sampling_unavailable', { samples, livenessErrors })
      }
    } finally {
      sampling = false
    }
  }
  void (async () => {
    const initial = await parentState(readText, parentPid)
    if (stopped) return
    if (initial.status !== 'ok') {
      stop(initial.status, initial.status === 'parent_unavailable' ? 1 : 0)
      return
    }
    parentStart = initial.stat.startTimeTicks
    emit('start', 'running', {
      parentPid,
      hostPidCap: HOST_CAP,
      descendantCap: DESCENDANT_CAP,
      sampleIntervalMs,
      livenessIntervalMs,
    })
    if (stopped) return
    liveTimer = setInterval(() => {
      void check()
    }, livenessIntervalMs)
    sampleTimer = setInterval(() => {
      void sample()
    }, sampleIntervalMs)
    void sample()
  })().catch(() => {
    if (!stopped) stop('startup_unavailable', 1)
  })
}
async function listHostPids() {
  const result = []
  for await (const entry of await opendir('/proc')) {
    if (pidNumber(entry.name) !== null) result.push(entry.name)
    if (result.length > HOST_CAP) break
  }
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parentPid =
    process.argv.length === 4 && process.argv[2] === '--parent' ? pidNumber(process.argv[3]) : null
  runObserver({ parentPid, readText: (path) => readFile(path, 'utf8'), listPids: listHostPids })
}
