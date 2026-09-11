import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { DeliveryDecisions } from './delivery-decisions'
import type { DeliveryDecisionCommand } from './delivery-decisions'
import { ReadingReviewService } from './reading-review.service'
import { ConsumptionService } from './consumption.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import type { PrismaService } from '../common/prisma/prisma.service'

// Own local database, own random schema, migrations and only synthetic domain data.
export function deliveryRenderingRig() {
  const schema = 'delivery_r22_' + randomUUID().replaceAll('-', '')
  let base: PrismaClient,
    db: PrismaClient,
    clockDb: PrismaClient,
    service: DeliveryDecisions,
    url: URL
  let baseline: Awaited<ReturnType<typeof inventory>>
  let schemasBefore: unknown
  let now = Date.UTC(2026, 8, 11)
  const clients: PrismaClient[] = []
  const day = (n: number) => new Date(Date.UTC(2026, 0, n))
  const key = () => randomUUID()

  async function inventory(client: PrismaClient, namespace: string) {
    const tables = await client.$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = ${namespace} ORDER BY tablename`
    const rows: Record<string, string> = {}
    for (const { name } of tables) {
      const [count] = await client.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${namespace}"."${name.replaceAll('"', '""')}"`,
      )
      rows[name] = String(count!.n)
    }
    return rows
  }
  async function extension() {
    return base.$queryRaw`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`
  }
  function client() {
    const privateUrl = new URL(url)
    privateUrl.searchParams.set('schema', schema)
    privateUrl.searchParams.set('connection_limit', '1')
    const value = new PrismaClient({ datasources: { db: { url: privateUrl.toString() } } })
    clients.push(value)
    return value
  }
  async function identity(value: PrismaClient) {
    const [row] = await value.$queryRaw<Array<{ database: string; schema: string }>>`
      SELECT current_database() AS database, current_schema() AS schema`
    assert.deepEqual(row, { database: url.pathname.slice(1), schema })
  }
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('r22 kräver riktig PostgreSQL')
    url = new URL(process.env.DATABASE_URL)
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      (!process.env.CI && !url.pathname.startsWith('/agent3_delivery_2a_'))
    ) {
      throw new Error('r22 kräver egen lokal testdatabas eller CI:s isolerade databas')
    }
    const publicUrl = new URL(url)
    publicUrl.searchParams.set('schema', 'public')
    base = new PrismaClient({ datasources: { db: { url: publicUrl.toString() } } })
    assert.deepEqual(await extension(), [{ nspname: 'public' }])
    baseline = await inventory(base, 'public')
    schemasBefore = await base.$queryRaw`SELECT nspname FROM pg_namespace ORDER BY nspname`
    console.warn('r22 DB före:', url.pathname.slice(1), JSON.stringify(baseline))
    await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    const migrations = resolve(__dirname, '../../prisma/migrations')
    const sql = readdirSync(migrations)
      .sort()
      .filter((name) => /^\d/.test(name))
      .map((name) => readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8'))
      .join('\n')
    const migrated = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
      encoding: 'utf8',
      input: sql,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: url.pathname.slice(1),
        PGOPTIONS: `-c search_path=${schema},public`,
      },
    })
    if (migrated.status !== 0)
      throw new Error(`Privata migrationer: ${migrated.error ?? migrated.stderr}`)
    db = client()
    clockDb = client()
    service = new DeliveryDecisions(db)
    await db.$executeRawUnsafe('CREATE TABLE "SyntheticDeliveryClock" ("now" TIMESTAMP NOT NULL)')
    await db.$executeRaw`INSERT INTO "SyntheticDeliveryClock" VALUES (${new Date(now)})`
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION delivery_now() RETURNS TIMESTAMP LANGUAGE sql VOLATILE AS $$ SELECT "now" FROM "SyntheticDeliveryClock" $$`,
    )
    await identity(db)
    assert.equal(await db.deliveryDecision.count(), 0)
    console.warn(
      'r22 privat schema:',
      schema,
      'migrationer:',
      readdirSync(migrations).filter((n) => /^\d/.test(n)).length,
    )
  })
  afterAll(async () => {
    try {
      if (db) {
        const rows = await inventory(db, schema)
        console.warn(
          'r22 egna fixturrader före städning:',
          JSON.stringify(
            Object.fromEntries(Object.entries(rows).filter(([, count]) => count !== '0')),
          ),
        )
      }
    } finally {
      const disconnected = await Promise.allSettled(clients.map((value) => value.$disconnect()))
      if (base) {
        try {
          // Child tables first; SQL then resolves the remaining private domain dependencies.
          for (const table of [
            'DeliveryObservation',
            'DeliveryDispatch',
            'DeliveryEvent',
            'DeliveryMember',
            'DeliveryDecision',
            'DeliveryDocument',
          ]) {
            await base.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${table}"`)
          }
          await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
          expect(await base.$queryRaw`SELECT to_regnamespace(${schema})::text AS name`).toEqual([
            { name: null },
          ])
          expect(await extension()).toEqual([{ nspname: 'public' }])
          const after = await inventory(base, 'public')
          expect(disconnected.every((r) => r.status === 'fulfilled')).toBe(true)
          expect(after).toEqual(baseline)
          expect(await base.$queryRaw`SELECT nspname FROM pg_namespace ORDER BY nspname`).toEqual(
            schemasBefore,
          )
          console.warn(
            'r22 DB efter:',
            url.pathname.slice(1),
            'eget schema saknas;',
            JSON.stringify(after),
          )
        } finally {
          await base.$disconnect()
        }
      }
    }
  })

  async function fixture(
    kind: 'INVOICE' | 'NOTICE' = 'INVOICE',
    numberOfCharges = 2,
    highRate = false,
  ) {
    const organization = await db.organization.create({
      data: {
        name: 'r22 syntetisk organisation',
        email: key() + '@example.test',
        street: 'Provvägen 1',
        city: 'Provstad',
        postalCode: '11111',
      },
    })
    const actor = await db.user.create({
      data: {
        organizationId: organization.id,
        email: key() + '@example.test',
        firstName: 'Ada',
        lastName: 'Granskare',
        role: 'MANAGER',
      },
    })
    const property = await db.property.create({
      data: {
        organizationId: organization.id,
        name: 'r22 hus',
        propertyDesignation: key(),
        type: 'RESIDENTIAL',
        street: 'Provvägen 1',
        city: 'Provstad',
        postalCode: '11111',
        totalArea: 50,
        consumptionBillingMode: 'RENT_NOTICE_LINE',
      },
    })
    const unit = await db.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lägenhet 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 1000,
      },
    })
    const tenant = await db.tenant.create({
      data: {
        organizationId: organization.id,
        type: 'INDIVIDUAL',
        firstName: 'Prov',
        lastName: 'Mottagare',
        email: key() + '@example.test',
        street: 'Provvägen 1',
        city: 'Provstad',
        postalCode: '11111',
      },
    })
    const lease = await db.lease.create({
      data: {
        organizationId: organization.id,
        unitId: unit.id,
        tenantId: tenant.id,
        status: 'ACTIVE',
        startDate: day(1),
        tenancyStartDate: day(1),
        monthlyRent: 1000,
        depositAmount: 0,
      },
    })
    await db.account.createMany({
      data: [
        { organizationId: organization.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: organization.id, number: 1790, name: 'Upplupet', type: 'ASSET' },
        { organizationId: organization.id, number: 3920, name: 'Förbrukning', type: 'REVENUE' },
      ],
    })
    const prisma = db as unknown as PrismaService
    const consumption = new ConsumptionService(
      prisma,
      new AccountingService(prisma, new VerifikationsnummerService(prisma)),
      new InvoiceEventsService(prisma),
    )
    const meter = await consumption.createMeter(
      { unitId: unit.id, type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
      organization.id,
    )
    await consumption.createTariff(
      { scope: 'ORGANIZATION', meterType: 'ELECTRICITY', pricePerUnit: 2, validFrom: '2026-01-01' },
      organization.id,
    )
    let readingNumber = 0
    async function addCharge(value = 10) {
      const date = day(++readingNumber).toISOString()
      const reading = await consumption.recordReading(
        {
          meterId: meter.id,
          value,
          readingType: 'PERIOD_VOLUME',
          source: 'MANUAL',
          readingDate: date,
          periodStart: date,
          periodEnd: date,
        },
        organization.id,
        actor.id,
      )
      if (value === 40) {
        const reviews = new ReadingReviewService(prisma)
        const finding = (await reviews.getReview(organization.id)).findings.find(
          (f) => f.code === 'HIGH_RATE',
        )!
        await reviews.saveReview(organization.id, actor.id, {
          readingId: finding.readingId,
          findingCode: finding.code,
          fingerprint: finding.fingerprint,
          expectedRevision: 0,
          assessment: 'EXPLAINED',
          billingBasisDecision: 'VERIFIED_CORRECT_REAL_INCREASE',
          comment: 'Syntetisk godkänd verklig ökning före leveransbeslut',
        })
      }
      const control = await consumption.getChargeControl(reading.charge!.id, organization.id)
      await consumption.confirmCharge(reading.charge!.id, organization.id, actor.id, {
        expectedFingerprint: control.fingerprint,
      })
      return db.consumptionCharge.findUniqueOrThrow({ where: { id: reading.charge!.id } })
    }
    const charges = []
    for (let i = 0; i < numberOfCharges; i++)
      charges.push(await addCharge(highRate && i === numberOfCharges - 1 ? 40 : 10))
    const invoiceData = {
      invoiceNumber: key(),
      type: 'UTILITY' as const,
      tenantId: tenant.id,
      leaseId: lease.id,
      subtotal: numberOfCharges * 20,
      vatTotal: 0,
      total: numberOfCharges * 20,
      dueDate: day(90),
      issueDate: day(10),
      lines: {
        create: charges.map((charge) => ({
          description: 'El, provperiod',
          quantity: charge.quantity,
          unitPrice: charge.pricePerUnit,
          vatRate: charge.vatRate,
          total: charge.totalAmount,
        })),
      },
    }
    const root = await service.register(
      organization.id,
      actor.id,
      kind === 'INVOICE'
        ? { kind, data: invoiceData }
        : {
            kind,
            data: {
              leaseId: lease.id,
              tenantId: tenant.id,
              noticeNumber: key(),
              ocrNumber: key(),
              month: 4,
              year: 2026,
              amount: 1000,
              totalAmount: 1000,
              dueDate: day(90),
              type: 'RENT',
            },
          },
    )
    if (kind === 'INVOICE') {
      await db.consumptionCharge.updateMany({
        where: { id: { in: charges.map((c) => c.id) } },
        data: { status: 'ATTACHED', invoiceId: root.id },
      })
    } else {
      await consumption.attachRentNoticeLineCharges({
        organizationId: organization.id,
        leaseId: lease.id,
        rentNoticeId: root.id,
        aviMonth: 4,
        aviYear: 2026,
      })
    }
    return {
      organizationId: organization.id,
      actorId: actor.id,
      documentId: root.id,
      tenant,
      lease,
      charges,
      addCharge,
      consumption,
      invoiceData,
      kind,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function command(
    f: Fixture,
    operation: 'ORIGINAL' | 'INVOICE_RESEND' = 'ORIGINAL',
  ): Promise<DeliveryDecisionCommand> {
    const preview = await service.prepare(f)
    return {
      organizationId: f.organizationId,
      documentId: f.documentId,
      actorId: f.actorId,
      commandKey: key(),
      operation,
      expectedFingerprint: preview.fingerprint,
      reason: operation === 'INVOICE_RESEND' ? 'Avsiktlig begäran om ny kopia' : '',
    }
  }
  return {
    fixture,
    command,
    client,
    get db() {
      return db
    },
    get service() {
      return service
    },
    async setTime(value: number) {
      now = value
      await clockDb.$executeRaw`UPDATE "SyntheticDeliveryClock" SET "now" = ${new Date(value)}`
    },
  }
}
