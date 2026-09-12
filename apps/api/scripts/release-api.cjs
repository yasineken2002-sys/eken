// Fristående pre-deploy-kandidat; dagens startup-migration lämnas orörd.
const { readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { spawn } = require('node:child_process')
const { REPO, demand, verifyAndMigrate } = require('./release-gate.cjs')
const root = resolve(__dirname, '..')
async function runRelease({
  apiRoot = root,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  requestTimeoutMs = 15000,
} = {}) {
  async function json(url, options) {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    demand(response.ok, 'REMOTE_HTTP_ERROR')
    // API-fel kan innehålla credentials/metadata: skriv aldrig svarets body i loggen.
    return response.json()
  }
  demand(env.API_RELEASE_GITHUB_TOKEN && env.API_RELEASE_RAILWAY_TOKEN, 'READ_CREDENTIALS_MISSING')
  const manifest = JSON.parse(readFileSync(join(apiRoot, 'release-artifact.json'), 'utf8'))
  const result = await verifyAndMigrate({
    root: apiRoot,
    manifest,
    environment: env,
    github: (path) =>
      json(`https://api.github.com/repos/${REPO}${path}`, {
        headers: {
          Authorization: `Bearer ${env.API_RELEASE_GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
    railway: async (id) => {
      const result = await json('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.API_RELEASE_RAILWAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'query($id:String!){deployment(id:$id){id serviceId environmentId status meta}}',
          variables: { id },
        }),
      })
      demand(!result.errors && result.data?.deployment, 'DEPLOYMENT_API_INCOMPLETE')
      return result.data.deployment
    },
    migrate: () =>
      new Promise((resolveMigration, reject) => {
        const child = spawnImpl(
          process.execPath,
          [
            require.resolve('prisma/build/index.js'),
            'migrate',
            'deploy',
            '--schema',
            join(apiRoot, 'prisma/schema.prisma'),
          ],
          { cwd: apiRoot, env, stdio: ['ignore', 'ignore', 'ignore'] },
        )
        child.once('error', () => reject(new Error('MIGRATOR_START_FAILED')))
        child.once('exit', (code) =>
          code === 0 ? resolveMigration() : reject(new Error('MIGRATOR_FAILED')),
        )
      }),
  })
  return result
}
module.exports = { runRelease }
if (require.main === module)
  runRelease()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write(
        'API-release nekad eller migrator misslyckades; ingen appstart godkänd.\n',
      )
      process.exitCode = 1
    })
