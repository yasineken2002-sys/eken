import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const gate = createRequire(__filename)('../../scripts/release-gate.cjs')
const revision = 'a'.repeat(40)
const repository = { id: gate.REPO_ID, full_name: gate.REPO }
const workflowSource = readFileSync(
  resolve(__dirname, '../../../..', '.github/workflows/ci.yml'),
  'utf8',
)
let root: string
function fixture() {
  const manifest = gate.artifact(root, revision, workflowSource, [
    {
      path: 'apps/api/prisma/schema.prisma',
      blob: gate.gitBlob(readFileSync(join(root, 'prisma/schema.prisma'))),
    },
  ])
  const run = {
    id: 10,
    run_number: 3,
    run_attempt: 2,
    workflow_id: gate.WORKFLOW_ID,
    path: gate.WORKFLOW_PATH,
    repository,
    head_repository: repository,
    event: 'push',
    head_branch: 'main',
    head_sha: revision,
    status: 'completed',
    conclusion: 'success',
  }
  const jobs = manifest.jobs.map((name: string, i: number) => ({
    id: i + 100,
    name,
    run_id: 10,
    run_attempt: 2,
    head_sha: revision,
    status: 'completed',
    conclusion: 'success',
  }))
  const tree = [
    {
      path: gate.WORKFLOW_PATH,
      type: 'blob',
      mode: '100644',
      sha: gate.gitBlob(Buffer.from(workflowSource)),
    },
    ...manifest.migrations.map((file: { path: string; blob: string }) => ({
      path: `apps/api/${file.path}`,
      type: 'blob',
      mode: '100644',
      sha: file.blob,
    })),
    ...manifest.sources.map((file: { path: string; blob: string }) => ({
      path: file.path,
      type: 'blob',
      mode: '100644',
      sha: file.blob,
    })),
  ]
  const deployment = {
    id: 'deployment',
    serviceId: gate.SERVICE,
    environmentId: gate.ENVIRONMENT,
    status: 'DEPLOYING',
    meta: { repo: gate.REPO, branch: 'main', commitHash: revision },
  }
  const environment = {
    RAILWAY_SERVICE_ID: gate.SERVICE,
    RAILWAY_ENVIRONMENT_ID: gate.ENVIRONMENT,
    RAILWAY_DEPLOYMENT_ID: 'deployment',
    RAILWAY_GIT_COMMIT_SHA: revision,
  }
  const github = jest.fn(async (path: string): Promise<Record<string, unknown>> => {
    if (path.includes('/runs?')) return { total_count: 1, workflow_runs: [run] }
    if (path.includes('/jobs?')) return { total_count: jobs.length, jobs }
    if (path === '/actions/runs/10') return run
    if (path.includes('/git/trees/')) return { truncated: false, tree }
    if (path === '/git/ref/heads/main') return { object: { sha: revision, type: 'commit' } }
    if (path === `/actions/workflows/${gate.WORKFLOW_ID}`)
      return { id: gate.WORKFLOW_ID, name: 'CI', path: gate.WORKFLOW_PATH, state: 'active' }
    throw new Error('UNEXPECTED_ENDPOINT')
  })
  return {
    root,
    manifest,
    environment,
    github,
    railway: jest.fn(async () => deployment),
    migrate: jest.fn(async () => undefined),
    run,
    jobs,
    tree,
    deployment,
  }
}
async function denied(f: ReturnType<typeof fixture>, reason: string) {
  await expect(gate.verifyAndMigrate(f)).rejects.toThrow(reason)
  expect(f.migrate).toHaveBeenCalledTimes(0)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'api-release-test-'))
  mkdirSync(join(root, 'prisma/migrations/20260912000000_probe'), { recursive: true })
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'prisma/migrations/20260912000000_probe/migration.sql'), 'SELECT 1;\n')
  writeFileSync(join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n')
  writeFileSync(
    join(root, 'prisma/schema.prisma'),
    'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
  )
  writeFileSync(join(root, 'dist/main.js'), 'void 0\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('api-release-01 exact artifact, canonical latest attempt and all dependencies permit one invocation', async () => {
  const f = fixture()
  const result = await gate.verifyAndMigrate(f)
  expect(f.migrate).toHaveBeenCalledTimes(1)
  expect(result).toEqual({ revision, runId: 10, attempt: 2, requiredJobs: f.jobs.length })
  expect(f.github.mock.calls.some(([path]) => path.includes('/attempts/2/jobs?'))).toBe(true)
})
test('api-release-02 artifact and deployment SHA mismatch never invokes migrator', async () => {
  const f = fixture()
  f.environment.RAILWAY_GIT_COMMIT_SHA = 'b'.repeat(40)
  await denied(f, 'DEPLOYMENT_SHA')
})
test('api-release-03 repository, workflow, event and branch identity must all match', async () => {
  for (const change of [
    { repository: { ...repository, id: 1 } },
    { head_repository: { ...repository, full_name: 'fork/eken' } },
    { workflow_id: 1 },
    { path: 'other.yml' },
    { event: 'pull_request' },
    { head_branch: 'other' },
    { head_sha: 'b'.repeat(40) },
  ]) {
    const f = fixture()
    Object.assign(f.run, change)
    await denied(f, 'IDENTITY')
  }
})
test('api-release-04 latest failed canonical run cannot be hidden by older success', async () => {
  const f = fixture()
  const get = f.github.getMockImplementation()!
  f.github.mockImplementation(async (path) =>
    path.includes('/runs?')
      ? {
          total_count: 2,
          workflow_runs: [f.run, { ...f.run, id: 11, run_number: 4, conclusion: 'failure' }],
        }
      : get(path),
  )
  await denied(f, 'RUN_NOT_SUCCESS')
})
test('api-release-05 attempt changes and stale successful detail are denied', async () => {
  const f = fixture()
  const get = f.github.getMockImplementation()!
  f.github.mockImplementation(async (path) =>
    path === '/actions/runs/10' ? { ...f.run, run_attempt: 3 } : get(path),
  )
  await denied(f, 'RUN_CHANGED')
})
test('api-release-06 every non-green mandatory job denies even with successful umbrella', async () => {
  for (const status of [
    'failure',
    'skipped',
    'neutral',
    'cancelled',
    'timed_out',
    'action_required',
    '',
  ]) {
    const f = fixture()
    f.jobs.find((job: { name: string }) => job.name !== 'CI passed').conclusion = status
    await denied(f, 'JOB_NOT_SUCCESS')
  }
  const f = fixture()
  f.jobs[0].status = 'in_progress'
  await denied(f, 'JOB_NOT_SUCCESS')
})
test('api-release-07 missing, duplicate and previous-attempt mandatory jobs deny', async () => {
  const missing = fixture()
  missing.jobs.pop()
  await denied(missing, 'JOB_MISSING_OR_DUPLICATE')
  const duplicate = fixture()
  duplicate.jobs.push({ ...duplicate.jobs[0], id: 999 })
  await denied(duplicate, 'JOB_MISSING_OR_DUPLICATE')
  const stale = fixture()
  stale.jobs[0].run_attempt = 1
  await denied(stale, 'JOB_IDENTITY')
  const identity = fixture()
  delete identity.jobs[0].id
  await denied(identity, 'API_ITEM_IDENTITY')
})
test('api-release-08 PR annotation outside needs may be skipped', async () => {
  const f = fixture()
  f.jobs.push({
    ...f.jobs[0],
    id: 999,
    name: 'Migrationer i denna PR (annotering)',
    conclusion: 'skipped',
  })
  await gate.verifyAndMigrate(f)
  expect(f.migrate).toHaveBeenCalledTimes(1)
})
test('api-release-09 network failure at every verification request invokes zero times', async () => {
  const baseline = fixture()
  await gate.verifyAndMigrate(baseline)
  for (let failAt = 1; failAt <= baseline.github.mock.calls.length; failAt++) {
    const f = fixture()
    const get = f.github.getMockImplementation()!
    let calls = 0
    f.github.mockImplementation(async (path) => {
      if (++calls === failAt) throw new Error('NETWORK')
      return get(path)
    })
    await denied(f, 'NETWORK')
  }
  const f = fixture()
  f.railway.mockRejectedValue(new Error('NETWORK'))
  await denied(f, 'NETWORK')
})
test('api-release-10 incomplete pagination and truncated tree deny', async () => {
  for (const endpoint of ['runs?', 'jobs?', '/git/trees/']) {
    const f = fixture()
    const get = f.github.getMockImplementation()!
    f.github.mockImplementation(async (path) => {
      const value = await get(path)
      return path.includes(endpoint) ? { ...value, total_count: 998, truncated: true } : value
    })
    await denied(f, endpoint.includes('trees') ? 'TREE_INCOMPLETE' : 'API_TRUNCATED_LIST')
  }
})
test('api-release-11 waiting exhausts bounded time without invocation', async () => {
  const f = fixture()
  f.run.status = 'in_progress'
  let time = 0
  await expect(
    gate.verifyAndMigrate({
      ...f,
      maxWaitMs: 5000,
      now: () => time,
      pause: async (ms: number) => {
        time += ms
      },
    }),
  ).rejects.toThrow('WAIT_EXHAUSTED')
  expect(f.migrate).toHaveBeenCalledTimes(0)
})
test('api-release-12 changed, missing and added artifact migrations deny', async () => {
  const changed = fixture()
  writeFileSync(join(root, 'prisma/migrations/20260912000000_probe/migration.sql'), 'SELECT 2;')
  await denied(changed, 'ARTIFACT_HASH_OR_SET')
  const added = fixture()
  mkdirSync(join(root, 'prisma/migrations/20260912000001_extra'))
  writeFileSync(join(root, 'prisma/migrations/20260912000001_extra/migration.sql'), 'SELECT 3;')
  await denied(added, 'ARTIFACT_HASH_OR_SET')
  const missing = fixture()
  rmSync(join(root, 'prisma/migrations/20260912000001_extra'), { recursive: true })
  await denied(missing, 'ARTIFACT_HASH_OR_SET')
})
test('api-release-13 migration hashes must match exact remote source tree', async () => {
  const f = fixture()
  f.tree[1].sha = 'b'.repeat(40)
  await denied(f, 'MIGRATION_REMOTE_HASH')
})
test('api-release-14 workflow content and runtime bytes are bound to artifact', async () => {
  const workflow = fixture()
  workflow.tree[0].sha = 'b'.repeat(40)
  await denied(workflow, 'WORKFLOW_ARTIFACT')
  const runtime = fixture()
  writeFileSync(join(root, 'dist/main.js'), 'different')
  await denied(runtime, 'ARTIFACT_HASH_OR_SET')
})
test('api-release-15 unclassified jobs and dynamic workflow shapes fail closed', async () => {
  const f = fixture()
  f.jobs.push({ ...f.jobs[0], id: 999, name: 'Unknown outward step' })
  await denied(f, 'JOB_UNCLASSIFIED')
  expect(() =>
    gate.ciPolicy(workflowSource.replace('name: Typecheck', 'name: "${{ matrix.name }}"')),
  ).toThrow('WORKFLOW_DYNAMIC_JOB')
  expect(() => gate.ciPolicy(workflowSource.replace('      - typecheck\n', ''))).toThrow(
    'WORKFLOW_UNCOVERED_JOB',
  )
})
test('api-release-16 later attempt appearing after jobs invalidates approval', async () => {
  const f = fixture()
  const get = f.github.getMockImplementation()!
  let lists = 0
  f.github.mockImplementation(async (path) =>
    path.includes('/runs?') && ++lists === 2
      ? { total_count: 1, workflow_runs: [{ ...f.run, run_attempt: 3, conclusion: 'failure' }] }
      : get(path),
  )
  await denied(f, 'RUN_CHANGED')
})
test('api-release-17 superseded main and changed deployment are denied at final boundary', async () => {
  const f = fixture()
  const get = f.github.getMockImplementation()!
  f.github.mockImplementation(async (path) =>
    path === '/git/ref/heads/main'
      ? { object: { sha: 'b'.repeat(40), type: 'commit' } }
      : get(path),
  )
  await denied(f, 'RELEASE_SUPERSEDED')
  const d = fixture()
  d.railway.mockResolvedValueOnce(d.deployment).mockResolvedValue({
    ...d.deployment,
    meta: { ...d.deployment.meta, commitHash: 'b'.repeat(40) },
  })
  await denied(d, 'DEPLOYMENT_SHA')
})
test('api-release-18 missing canonical run or umbrella denies', async () => {
  const f = fixture()
  const get = f.github.getMockImplementation()!
  f.github.mockImplementation(async (path) =>
    path.includes('/runs?') ? { total_count: 0, workflow_runs: [] } : get(path),
  )
  await denied(f, 'RUN_MISSING')
  const umbrella = fixture()
  umbrella.jobs.splice(
    umbrella.jobs.findIndex((job: { name: string }) => job.name === 'CI passed'),
    1,
  )
  await denied(umbrella, 'JOB_MISSING_OR_DUPLICATE')
})
test('api-release-19 schema and omitted build input deny', async () => {
  const changed = fixture()
  writeFileSync(join(root, 'prisma/schema.prisma'), 'changed datasource')
  await denied(changed, 'SCHEMA_ARTIFACT')
  for (const path of [
    'apps/api/src/new-source.ts',
    'tsconfig.base.json',
    '.npmrc',
    '.dockerignore',
  ]) {
    const omitted = fixture()
    omitted.tree.push({ path, type: 'blob', mode: '100644', sha: 'b'.repeat(40) })
    await denied(omitted, 'BUILD_SOURCE_SET')
  }
})
test('api-release-20 real HTTP and process adapter denies malformed responses and timeout before spawn', async () => {
  const { runRelease } = createRequire(__filename)('../../scripts/release-api.cjs')
  let responseMode = 'valid'
  const f = fixture()
  writeFileSync(join(root, 'release-artifact.json'), JSON.stringify(f.manifest))
  const server = createServer(async (request, response) => {
    if (responseMode === 'timeout') return
    if (responseMode === 'network') {
      request.socket.destroy()
      return
    }
    if (responseMode === 'http') {
      response.writeHead(503).end('unavailable')
      return
    }
    if (responseMode === 'json') {
      response.end('{broken')
      return
    }
    if (responseMode === 'incomplete') {
      response.end('{}')
      return
    }
    const value =
      request.url === '/graphql'
        ? { data: { deployment: f.deployment } }
        : await f.github(request.url!)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address() as AddressInfo
  const fetchImpl = (url: string, options: RequestInit) =>
    fetch(
      `http://127.0.0.1:${address.port}${url.includes('railway.com') ? '/graphql' : url.split(`/repos/${gate.REPO}`)[1]}`,
      options,
    )
  // Den verkliga child_process-adaptern körs med en ofarlig syntetisk migrator.
  const spawnImpl = jest.fn(() => spawn(process.execPath, ['-e', 'process.exit(0)']))
  const options = {
    apiRoot: root,
    env: {
      ...f.environment,
      API_RELEASE_GITHUB_TOKEN: 'synthetic',
      API_RELEASE_RAILWAY_TOKEN: 'synthetic',
    },
    fetchImpl,
    spawnImpl,
    requestTimeoutMs: 200,
  }
  try {
    for (responseMode of ['http', 'json', 'incomplete', 'network', 'timeout']) {
      await expect(runRelease(options)).rejects.toThrow()
      expect(spawnImpl).toHaveBeenCalledTimes(0)
    }
    responseMode = 'valid'
    await runRelease(options)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    )
  }
}, 30000)
