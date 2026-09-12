// Inaktiv kandidat. Inget startup-script eller Railway-kommando anropar denna fil.
// Tillitsgräns: ägarstyrd immutable image och Railways autentiserade deploymentmetadata.
// Beviset gäller kontrollögonblicket; releaseordning genom routing kräver separat grind.
const { createHash } = require('node:crypto')
const { readdirSync, readFileSync, lstatSync } = require('node:fs')
const { join, relative } = require('node:path')
const YAML = require('yaml')

const REPO = 'yasineken2002-sys/eken'
const REPO_ID = 1186637753
const WORKFLOW_ID = 261975754
const WORKFLOW_PATH = '.github/workflows/ci.yml'
const SERVICE = '16bded97-b732-4739-a7b2-fb40fde35f8c'
const ENVIRONMENT = '7979ad22-c825-4ed3-a421-cb32f73d585b'
const SHA = /^[0-9a-f]{40}$/u
function demand(value, reason) {
  if (!value) throw new Error(reason)
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function gitBlob(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
function files(root, directory, skip = []) {
  const result = []
  function visit(path) {
    const stat = lstatSync(path)
    demand(!stat.isSymbolicLink(), 'ARTIFACT_SYMLINK')
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) {
        if (!skip.includes(name)) visit(join(path, name))
      }
    else {
      demand(stat.isFile(), 'ARTIFACT_FILE')
      result.push(relative(root, path).split('\\').join('/'))
    }
  }
  visit(join(root, directory))
  return result.sort()
}
function ciPolicy(source) {
  const document = YAML.parseDocument(source, { uniqueKeys: true })
  demand(document.errors.length === 0, 'WORKFLOW_YAML')
  const workflow = document.toJS({ maxAliasCount: 0 })
  demand(
    workflow.name === 'CI' && JSON.stringify(workflow.on?.push?.branches) === '["main"]',
    'WORKFLOW_TRIGGER',
  )
  const jobs = workflow.jobs
  demand(jobs && jobs['ci-passed']?.name === 'CI passed', 'WORKFLOW_GATE')
  demand(
    jobs['migration-annotation']?.if === "github.event_name == 'pull_request'",
    'WORKFLOW_EXCEPTION',
  )
  const required = new Set()
  function visit(id) {
    demand(id !== 'migration-annotation' && jobs[id], 'WORKFLOW_DEPENDENCY')
    if (required.has(id)) return
    required.add(id)
    const job = jobs[id]
    demand(
      typeof job.name === 'string' &&
        !job.name.includes('${{') &&
        !job.strategy &&
        !job.uses &&
        !job['continue-on-error'],
      'WORKFLOW_DYNAMIC_JOB',
    )
    demand(Array.isArray(job.steps) && job.steps.length > 0, 'WORKFLOW_STEPS')
    demand(
      job.steps.every((step) => !step['continue-on-error']),
      'WORKFLOW_TOLERATED_FAILURE',
    )
    const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? [])
    demand(Array.isArray(needs), 'WORKFLOW_NEEDS')
    needs.forEach(visit)
  }
  visit('ci-passed')
  demand(
    Object.keys(jobs).every((id) => id === 'migration-annotation' || required.has(id)),
    'WORKFLOW_UNCOVERED_JOB',
  )
  const names = [...required].map((id) => jobs[id].name).sort()
  demand(new Set(names).size === names.length, 'WORKFLOW_DUPLICATE_NAME')
  return names
}
function isBuildSource(path) {
  return (
    path.startsWith('apps/api/src/') ||
    path.startsWith('packages/') ||
    /^apps\/api\/tsconfig[^/]*\.json$/u.test(path) ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'turbo.json',
      'apps/api/package.json',
      'apps/api/nest-cli.json',
      'apps/api/Dockerfile',
      'apps/api/prisma/schema.prisma',
    ].includes(path) ||
    /^apps\/api\/scripts\/[^/]+\.cjs$/u.test(path)
  )
}
function buildSources(repositoryRoot) {
  const paths = ['apps/api/src', 'packages', 'apps/api/scripts'].flatMap((dir) =>
    files(repositoryRoot, dir, ['node_modules', 'dist', '.turbo']),
  )
  paths.push(...readdirSync(repositoryRoot).filter((name) => isBuildSource(name)))
  paths.push(
    ...readdirSync(join(repositoryRoot, 'apps/api'))
      .map((name) => `apps/api/${name}`)
      .filter(isBuildSource),
    'apps/api/prisma/schema.prisma',
  )
  return [...new Set(paths.filter(isBuildSource))]
    .sort()
    .map((path) => ({ path, blob: gitBlob(readFileSync(join(repositoryRoot, path))) }))
}
function artifact(root, revision, workflowSource, sources) {
  demand(SHA.test(revision), 'ARTIFACT_SHA')
  const migrations = files(root, 'prisma/migrations').map((path) => {
    demand(
      path === 'prisma/migrations/migration_lock.toml' ||
        /^prisma\/migrations\/[^/]+\/migration\.sql$/u.test(path),
      'MIGRATION_FILE',
    )
    const bytes = readFileSync(join(root, path))
    return { path, sha256: sha256(bytes), blob: gitBlob(bytes) }
  })
  demand(
    migrations.some((file) => file.path.endsWith('/migration.sql')),
    'MIGRATIONS_EMPTY',
  )
  const runtime = files(root, 'dist').map((path) => ({
    path,
    sha256: sha256(readFileSync(join(root, path))),
  }))
  demand(
    runtime.some((file) => file.path === 'dist/main.js'),
    'RUNTIME_EMPTY',
  )
  demand(
    Array.isArray(sources) && sources.some((file) => file.path === 'apps/api/prisma/schema.prisma'),
    'BUILD_SOURCES_MISSING',
  )
  const schema = gitBlob(readFileSync(join(root, 'prisma/schema.prisma')))
  demand(
    sources.find((file) => file.path === 'apps/api/prisma/schema.prisma').blob === schema,
    'SCHEMA_ARTIFACT',
  )
  return {
    format: 1,
    repository: REPO,
    revision,
    workflowSource,
    jobs: ciPolicy(workflowSource),
    sources,
    migrations,
    runtime,
  }
}
function verifyArtifact(root, manifest) {
  demand(manifest?.format === 1 && manifest.repository === REPO, 'ARTIFACT_IDENTITY')
  const actual = artifact(root, manifest.revision, manifest.workflowSource, manifest.sources)
  demand(JSON.stringify(actual) === JSON.stringify(manifest), 'ARTIFACT_HASH_OR_SET')
}
function repoIdentity(repo) {
  demand(repo?.id === REPO_ID && repo.full_name === REPO, 'REPOSITORY_IDENTITY')
}
function runIdentity(run, revision) {
  repoIdentity(run.repository)
  repoIdentity(run.head_repository)
  demand(
    run.workflow_id === WORKFLOW_ID &&
      run.path === WORKFLOW_PATH &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.head_sha === revision,
    'RUN_IDENTITY',
  )
  demand(
    Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_number) &&
      run.run_number > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'RUN_INCOMPLETE',
  )
}
async function completeList(get, path, key) {
  const all = []
  let total
  for (let page = 1; page <= 10; page++) {
    const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    demand(
      Number.isSafeInteger(data.total_count) &&
        data.total_count >= 0 &&
        data.total_count < 1000 &&
        Array.isArray(data[key]),
      'API_INCOMPLETE_LIST',
    )
    total ??= data.total_count
    demand(total === data.total_count && data[key].length <= 100, 'API_LIST_CHANGED')
    all.push(...data[key])
    demand(
      all.length <= total && new Set(all.map((row) => row.id)).size === all.length,
      'API_DUPLICATE_LIST',
    )
    if (all.length === total) return all
    demand(data[key].length === 100, 'API_TRUNCATED_LIST')
  }
  throw new Error('API_PAGINATION_LIMIT')
}
async function latest(get, revision) {
  // Ingen statusfiltrering: en senare röd/pågående körning måste förbli synlig.
  const runs = await completeList(
    get,
    `/actions/workflows/${WORKFLOW_ID}/runs?head_sha=${revision}&event=push&branch=main`,
    'workflow_runs',
  )
  demand(runs.length > 0, 'RUN_MISSING')
  runs.forEach((run) => runIdentity(run, revision))
  demand(new Set(runs.map((run) => run.run_number)).size === runs.length, 'RUN_AMBIGUOUS')
  return runs.sort((a, b) => b.run_number - a.run_number)[0]
}
function successful(run) {
  demand(run.status === 'completed' && run.conclusion === 'success', 'RUN_NOT_SUCCESS')
}
function sameAttempt(first, next) {
  demand(
    first.id === next.id &&
      first.run_attempt === next.run_attempt &&
      first.run_number === next.run_number,
    'RUN_CHANGED',
  )
}
function deploymentIdentity(deployment, environment, revision) {
  demand(
    deployment?.id === environment.RAILWAY_DEPLOYMENT_ID &&
      deployment.serviceId === SERVICE &&
      deployment.environmentId === ENVIRONMENT,
    'DEPLOYMENT_IDENTITY',
  )
  demand(
    deployment.meta?.repo === REPO &&
      deployment.meta.branch === 'main' &&
      deployment.meta.commitHash === revision &&
      environment.RAILWAY_GIT_COMMIT_SHA === revision,
    'DEPLOYMENT_SHA',
  )
  demand(deployment.status === 'DEPLOYING', 'DEPLOYMENT_PHASE')
}
async function verifyAndMigrate({
  root,
  manifest,
  environment,
  github,
  railway,
  migrate,
  now = () => performance.now(),
  maxWaitMs = 600000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  demand(Number.isSafeInteger(maxWaitMs) && maxWaitMs > 0 && maxWaitMs <= 600000, 'WAIT_LIMIT')
  const deadline = now() + maxWaitMs
  const checked = async (promise) => {
    const result = await promise
    demand(now() < deadline, 'WAIT_EXHAUSTED')
    return result
  }
  verifyArtifact(root, manifest)
  const revision = manifest.revision
  demand(
    environment.RAILWAY_SERVICE_ID === SERVICE &&
      environment.RAILWAY_ENVIRONMENT_ID === ENVIRONMENT &&
      environment.RAILWAY_DEPLOYMENT_ID,
    'ENVIRONMENT_IDENTITY',
  )
  deploymentIdentity(
    await checked(railway(environment.RAILWAY_DEPLOYMENT_ID)),
    environment,
    revision,
  )
  const get = (path) => checked(github(path))
  const workflow = await get(`/actions/workflows/${WORKFLOW_ID}`)
  demand(
    workflow.id === WORKFLOW_ID &&
      workflow.path === WORKFLOW_PATH &&
      workflow.name === 'CI' &&
      workflow.state === 'active',
    'WORKFLOW_IDENTITY',
  )
  const tree = await get(`/git/trees/${revision}?recursive=1`)
  demand(tree.truncated === false && Array.isArray(tree.tree), 'TREE_INCOMPLETE')
  const source = tree.tree.find((entry) => entry.path === WORKFLOW_PATH)
  demand(
    source?.type === 'blob' && source.sha === gitBlob(Buffer.from(manifest.workflowSource)),
    'WORKFLOW_ARTIFACT',
  )
  const inputs = tree.tree.filter((entry) => entry.type !== 'tree' && isBuildSource(entry.path))
  demand(
    inputs.length === manifest.sources.length &&
      new Set(manifest.sources.map((file) => file.path)).size === inputs.length,
    'BUILD_SOURCE_SET',
  )
  for (const file of manifest.sources)
    demand(
      inputs.some(
        (entry) =>
          entry.path === file.path &&
          entry.type === 'blob' &&
          ['100644', '100755'].includes(entry.mode) &&
          entry.sha === file.blob,
      ),
      'BUILD_SOURCE_HASH',
    )
  const remoteFiles = tree.tree.filter(
    (entry) => entry.type !== 'tree' && entry.path.startsWith('apps/api/prisma/migrations/'),
  )
  demand(
    remoteFiles.length === manifest.migrations.length &&
      new Set(remoteFiles.map((entry) => entry.path)).size === remoteFiles.length,
    'MIGRATION_REMOTE_SET',
  )
  for (const file of manifest.migrations)
    demand(
      remoteFiles.some(
        (entry) =>
          entry.path === `apps/api/${file.path}` &&
          entry.type === 'blob' &&
          entry.mode === '100644' &&
          entry.sha === file.blob,
      ),
      'MIGRATION_REMOTE_HASH',
    )
  let run
  for (;;) {
    run = await latest(get, revision)
    if (run.status === 'completed') {
      successful(run)
      break
    }
    demand(
      ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status),
      'RUN_STATUS',
    )
    demand(now() + 2000 < deadline, 'WAIT_EXHAUSTED')
    await pause(2000)
  }
  const detail = await get(`/actions/runs/${run.id}`)
  runIdentity(detail, revision)
  sameAttempt(run, detail)
  successful(detail)
  const jobs = await completeList(
    get,
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    'jobs',
  )
  for (const name of manifest.jobs) {
    const matches = jobs.filter((job) => job.name === name)
    demand(matches.length === 1, 'JOB_MISSING_OR_DUPLICATE')
    const job = matches[0]
    demand(
      job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === revision,
      'JOB_IDENTITY',
    )
    demand(job.status === 'completed' && job.conclusion === 'success', 'JOB_NOT_SUCCESS')
  }
  demand(
    jobs.every(
      (job) =>
        manifest.jobs.includes(job.name) || job.name === 'Migrationer i denna PR (annotering)',
    ),
    'JOB_UNCLASSIFIED',
  )
  // Omkontroll nära effekten; ingen cache eller återanvänd attest mellan anrop.
  const finalRun = await latest(get, revision)
  sameAttempt(run, finalRun)
  successful(finalRun)
  const finalDetail = await get(`/actions/runs/${run.id}`)
  runIdentity(finalDetail, revision)
  sameAttempt(run, finalDetail)
  successful(finalDetail)
  const main = await get('/git/ref/heads/main')
  demand(main.object?.sha === revision && main.object.type === 'commit', 'RELEASE_SUPERSEDED')
  deploymentIdentity(
    await checked(railway(environment.RAILWAY_DEPLOYMENT_ID)),
    environment,
    revision,
  )
  verifyArtifact(root, manifest)
  demand(now() < deadline, 'WAIT_EXHAUSTED')
  await migrate()
  return { revision, runId: run.id, attempt: run.run_attempt, requiredJobs: manifest.jobs.length }
}
module.exports = {
  REPO,
  REPO_ID,
  WORKFLOW_ID,
  WORKFLOW_PATH,
  SERVICE,
  ENVIRONMENT,
  demand,
  artifact,
  verifyArtifact,
  ciPolicy,
  gitBlob,
  buildSources,
  verifyAndMigrate,
}
