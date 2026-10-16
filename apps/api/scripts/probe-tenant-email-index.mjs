import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import os from 'node:os'

const require = createRequire(`${process.cwd()}/package.json`)
const { PrismaClient } = require('@prisma/client')
// Manual synthetic measurement; run from apps/api. Never uses an env-file.
const url = new URL(process.env.DATABASE_URL ?? '')
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/eveno_portal_email_index_test'
) {
  throw new Error('Only the dedicated local synthetic index database is allowed')
}
const mode = process.argv[2]
const target = process.argv[3]
if (!['seed', 'before', 'after'].includes(mode) || (mode !== 'seed' && !target)) {
  throw new Error(
    'Usage: node scripts/probe-tenant-email-index.mjs seed | before/after output.json',
  )
}
const db = new PrismaClient()
try {
  if (mode === 'seed') {
    if ((await db.tenant.count()) !== 0 || (await db.organization.count()) !== 0) {
      throw new Error('Seed requires an empty dedicated database')
    }
    await db.organization.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        id: `index-org-${i + 1}`,
        name: `Synthetic index landlord ${i + 1}`,
        email: `index-org-${i + 1}@example.invalid`,
        street: 'Synthetic street',
        city: 'Teststad',
        postalCode: '11122',
      })),
    })
    await db.$executeRawUnsafe(`
      INSERT INTO "Tenant" ("id", "organizationId", "type", "firstName", "lastName", "email", "portalActivated", "passwordHash", "updatedAt")
      SELECT 'index-tenant-' || o || '-' || n, 'index-org-' || o, 'INDIVIDUAL'::"TenantType",
        'Syntetisk', 'Hyresgast',
        CASE WHEN n=1 THEN 'shared-index@example.invalid' ELSE 'index-' || o || '-' || n || '@example.invalid' END,
        n % 5 <> 0, 'synthetic-non-authenticating-hash', now()
      FROM generate_series(1,30) AS o CROSS JOIN generate_series(1,3000) AS n
    `)
    await db.$executeRawUnsafe('ANALYZE "Tenant"')
    console.log(
      JSON.stringify({
        organizations: await db.organization.count(),
        tenants: await db.tenant.count(),
      }),
    )
  } else if (mode === 'before' || mode === 'after') {
    const index = await db.$queryRawUnsafe(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='Tenant_email_idx' AND i.indrelid='"Tenant"'::regclass`,
    )
    if (
      (mode === 'before' && index.length !== 0) ||
      (mode === 'after' && (index.length !== 1 || !index[0].indisvalid))
    ) {
      throw new Error('Index state does not match requested before/after measurement')
    }
    const cases = {
      loginShared: `SELECT * FROM "Tenant" WHERE "email"='shared-index@example.invalid' LIMIT 1`,
      loginSingle: `SELECT * FROM "Tenant" WHERE "email"='index-30-2999@example.invalid' LIMIT 1`,
      loginMissing: `SELECT * FROM "Tenant" WHERE "email"='absent-index@example.invalid' LIMIT 1`,
      resetShared: `SELECT * FROM "Tenant" WHERE "email"='shared-index@example.invalid' AND "portalActivated"=true AND "anonymizedAt" IS NULL ORDER BY "id" ASC`,
      resetMissing: `SELECT * FROM "Tenant" WHERE "email"='absent-index@example.invalid' AND "portalActivated"=true AND "anonymizedAt" IS NULL ORDER BY "id" ASC`,
      scopedLogin: `SELECT * FROM "Tenant" WHERE "organizationId"='index-org-30' AND "email"='shared-index@example.invalid' LIMIT 1`,
    }
    const plans = {}
    for (const [name, sql] of Object.entries(cases)) {
      await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)
      const runs = []
      for (let i = 0; i < 5; i++) {
        const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)
        runs.push(rows[0]['QUERY PLAN'][0])
      }
      const times = runs.map((r) => r['Execution Time']).sort((a, b) => a - b)
      const resultIds = (await db.$queryRawUnsafe(sql)).map((row) => row.id)
      plans[name] = {
        sql,
        resultIds,
        executionMs: { min: times[0], median: times[2], max: times[4], n: 5 },
        sample: runs[2],
      }
    }
    const indexes = await db.$queryRawUnsafe(
      `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, pg_get_indexdef(i.indexrelid) AS definition, pg_relation_size(i.indexrelid)::text AS bytes FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='"Tenant"'::regclass ORDER BY c.relname`,
    )
    const result = {
      mode,
      at: new Date().toISOString(),
      hardware: {
        cpus: os.cpus().length,
        model: os.cpus()[0].model,
        memoryGB: os.totalmem() / 1024 ** 3,
      },
      postgres: await db.$queryRawUnsafe('SELECT version()'),
      tenants: await db.tenant.count(),
      indexes,
      plans,
    }
    writeFileSync(target, JSON.stringify(result, null, 2) + '\n')
    console.log(
      JSON.stringify(
        {
          mode,
          tenants: result.tenants,
          cases: Object.fromEntries(
            Object.entries(plans).map(([k, v]) => [
              k,
              {
                ...v.executionMs,
                topNode: v.sample.Plan['Node Type'],
                sharedHitBlocks: v.sample.Plan['Shared Hit Blocks'],
                rows: v.sample.Plan['Actual Rows'],
              },
            ]),
          ),
        },
        null,
        2,
      ),
    )
  } else throw new Error('Expected seed, before or after')
} finally {
  await db.$disconnect()
}
