import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { DeliveryDecisions } from './delivery-decisions'
import { DeliveryExecution } from './delivery-execution'
import type { DeliveryPacket, DeliveryPorts, DeliveryReply } from './delivery-execution'
import type { DeliveryDispatch, DeliveryObservation } from '@prisma/client'
import { DeliveryWrites } from './delivery-writes'
import {
  SimulatedDeliveryProvider,
  fixtureResources,
  fixtureResourceDigests,
  syntheticRenderer,
  assertRendererContract,
  latch,
} from './delivery-execution.test-ports'
import type { DeliveryDecisionCommand, DeliveryTransitionCommand } from './delivery-decisions'
import { ReadingReviewService } from './reading-review.service'
import { ConsumptionService } from './consumption.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import type { PrismaService } from '../common/prisma/prisma.service'

// Facit: docs/granskning/agent3-utskicksgrind-2b-facit.md, fryst före SQL.
// Riktig PostgreSQL/domänkod, uttryckligen syntetiska renderer-/providerportar.
// Inga krav-ID:n eller förväntade tidsgränser härleds från implementationen.
jest.setTimeout(90_000)
describe('2b: inaktivt exekveringsmaskineri i PostgreSQL', () => {
  const schema = 'delivery_2b_' + randomUUID().replaceAll('-', '')
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
    expect(row).toEqual({ database: url.pathname.slice(1), schema })
  }
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('2b kräver riktig PostgreSQL')
    url = new URL(process.env.DATABASE_URL)
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      (!process.env.CI && !url.pathname.startsWith('/agent3_delivery_2a_'))
    ) {
      throw new Error('2b kräver egen lokal testdatabas eller CI:s isolerade databas')
    }
    const publicUrl = new URL(url)
    publicUrl.searchParams.set('schema', 'public')
    base = new PrismaClient({ datasources: { db: { url: publicUrl.toString() } } })
    expect(await extension()).toEqual([{ nspname: 'public' }])
    baseline = await inventory(base, 'public')
    schemasBefore = await base.$queryRaw`SELECT nspname FROM pg_namespace ORDER BY nspname`
    console.warn('2b DB före:', url.pathname.slice(1), JSON.stringify(baseline))
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
    expect(await db.deliveryDecision.count()).toBe(0)
    console.warn(
      '2b privat schema:',
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
          '2b egna fixturrader före städning:',
          JSON.stringify(
            Object.fromEntries(Object.entries(rows).filter(([, count]) => count !== '0')),
          ),
        )
      }
    } finally {
      const disconnected = await Promise.allSettled(clients.map((value) => value.$disconnect()))
      if (base) {
        try {
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
            '2b DB efter:',
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
        name: '2b syntetisk organisation',
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
        name: '2b hus',
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
  function transition(
    f: Fixture,
    decisionId: string,
    to: DeliveryTransitionCommand['to'],
    attemptId: string | null = null,
    evidence: Prisma.InputJsonObject = { detail: 'Syntetiskt kontrollförlopp' },
  ): DeliveryTransitionCommand {
    return {
      organizationId: f.organizationId,
      documentId: f.documentId,
      actorId: f.actorId,
      commandKey: key(),
      decisionId,
      to,
      attemptId,
      evidence,
    }
  }
  type InternalExecution = {
    grant(decisionId: string): Promise<{ d: DeliveryDispatch; grant: DeliveryObservation } | null>
    finalCheck(d: DeliveryDispatch): Promise<false | bigint>
    record(d: DeliveryDispatch, grant: DeliveryObservation, reply: DeliveryReply): Promise<void>
  }
  const internal = (value: DeliveryExecution) => value as unknown as InternalExecution
  const observe = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
  beforeEach(async () => {
    await setTime(Date.UTC(2026, 8, 11))
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await Promise.all(
      clients
        .filter((connection) => connection !== db && connection !== clockDb)
        .map((connection) => connection.$disconnect()),
    )
  })

  async function setTime(value: number, provider?: SimulatedDeliveryProvider) {
    now = value
    await clockDb.$executeRaw`UPDATE "SyntheticDeliveryClock" SET "now" = ${new Date(value)}`
    if (provider) provider.now = value
  }
  const advance = (milliseconds: number, provider?: SimulatedDeliveryProvider) =>
    setTime(now + milliseconds, provider)
  async function counts(f: Fixture, tx: Prisma.TransactionClient = db) {
    const where = { organizationId: f.organizationId }
    return {
      roots: await tx.deliveryDocument.count({ where }),
      decisions: await tx.deliveryDecision.count({ where }),
      members: await tx.deliveryMember.count({ where }),
      events: await tx.deliveryEvent.count({ where }),
      dispatches: await tx.deliveryDispatch.count({ where }),
      observations: await tx.deliveryObservation.count({ where }),
    }
  }
  async function harness(value?: Fixture, provider = new SimulatedDeliveryProvider()) {
    const f = value ?? (await fixture())
    provider.now = now
    const principal = await db.deliveryPrincipal.create({
      data: { organizationId: f.organizationId, name: 'Syntetisk organisationsbunden exekverare' },
    })
    const configuration = {
      organizationId: f.organizationId,
      principalId: principal.id,
      team: 'synthetic-team-' + f.organizationId,
    }
    const resources = { ...fixtureResources }
    const jobs: string[] = []
    const ports = {
      resources: jest.fn(() => ({ ...resources })),
      render: jest.fn(syntheticRenderer),
      publish: jest.fn(async (decisionId: string) => {
        jobs.push(decisionId)
      }),
      send: jest.fn((packet: DeliveryPacket) => provider.send(packet)),
    } satisfies DeliveryPorts
    const execution = new DeliveryExecution(
      db,
      configuration,
      ports,
      () => BigInt(now) * 1_000_000n,
    )
    const restart = (connection = client()) =>
      new DeliveryExecution(connection, configuration, ports, () => BigInt(now) * 1_000_000n)
    const enqueueCommand = async (operation: 'ORIGINAL' | 'INVOICE_RESEND' = 'ORIGINAL') => ({
      ...(await command(f, operation)),
      resources: fixtureResourceDigests(),
      team: configuration.team,
    })
    return {
      f,
      principal,
      configuration,
      resources,
      provider,
      jobs,
      ports,
      execution,
      restart,
      enqueueCommand,
    }
  }
  async function setup(f?: Fixture) {
    const h = await harness(f)
    const decisionCommand = await h.enqueueCommand()
    const dispatch = await h.execution.enqueue(decisionCommand)
    return { ...h, dispatch, decisionCommand }
  }
  type Setup = Awaited<ReturnType<typeof setup>>
  async function latest(decisionId: string) {
    return db.deliveryEvent.findFirstOrThrow({
      where: { decisionId },
      orderBy: { revision: 'desc' },
    })
  }
  async function observations(decisionId: string, kind?: string) {
    return db.deliveryObservation.findMany({
      where: { decisionId, ...(kind ? { kind } : {}) },
      orderBy: { sequence: 'asc' },
    })
  }
  async function startTime(dispatch: DeliveryDispatch, reader = db) {
    return (
      await reader.deliveryEvent.findUniqueOrThrow({ where: { id: dispatch.attemptId } })
    ).createdAt.getTime()
  }
  async function expectUnknown(h: Setup) {
    expect((await latest(h.dispatch.decisionId)).state).toBe('UNKNOWN')
    expect(
      await db.deliveryEvent.count({
        where: { decisionId: h.dispatch.decisionId, state: 'SENDING' },
      }),
    ).toBe(1)
  }
  async function lostResponse(h: Setup, mode: 'drop-before' | 'drop-after' = 'drop-after') {
    h.provider.modes.push(mode)
    expect((await h.execution.run(h.dispatch.decisionId)).called).toBe(true)
    await expectUnknown(h)
  }
  const writeScope = (
    f: Fixture,
    documentIds = [f.documentId],
    chargeIds = f.charges.map((c) => c.id),
  ) => ({
    organizationId: f.organizationId,
    actorId: f.actorId,
    documentIds,
    chargeIds,
  })
  async function changeDocument(f: Fixture, connection = db) {
    return new DeliveryWrites(connection).run(writeScope(f), (tx) =>
      tx.invoice.update({ where: { id: f.documentId }, data: { notes: 'Syntetisk ändring' } }),
    )
  }
  async function pid(connection: PrismaClient) {
    return (await connection.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
      .pid
  }
  async function expectBlocked(secondPid: number, firstPid: number) {
    expect(secondPid).not.toBe(firstPid)
    let blocked = false
    for (let n = 0; n < 200; n++) {
      const [row] = await db.$queryRaw<Array<{ blockers: number[] }>>`
        SELECT pg_blocking_pids(${secondPid}::int) AS blockers`
      if (row!.blockers.includes(firstPid)) {
        blocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(blocked).toBe(true)
    console.warn('2b faktisk låsväntan:', { firstPid, secondPid, blocked })
  }
  async function terminateOwnWorker(workerPid: number) {
    const [terminated] = await db.$queryRaw<Array<{ terminated: boolean }>>`
      SELECT pg_terminate_backend(${workerPid}::int) AS terminated
      WHERE EXISTS (SELECT FROM pg_stat_activity WHERE pid = ${workerPid}::int AND datname = current_database())`
    expect(terminated!.terminated).toBe(true)
    for (let n = 0; n < 100; n++) {
      const rows = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE pid = ${workerPid}::int`
      if (!rows.length) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(
      await db.$queryRaw`SELECT pid FROM pg_stat_activity WHERE pid = ${workerPid}::int`,
    ).toEqual([])
    console.warn('2b avslutad egen worker-PID medan provideranrop pågick:', workerPid)
  }

  function holdNextCommit(execution: DeliveryExecution) {
    const entered = latch(),
      release = latch()
    let transactionPid = 0
    const original = execution.decisions.checkConstraints.bind(execution.decisions)
    jest.spyOn(execution.decisions, 'checkConstraints').mockImplementationOnce(async (tx) => {
      await original(tx)
      transactionPid = (
        await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      )[0]!.pid
      entered.release()
      await release.promise
    })
    return { entered: entered.promise, release: release.release, pid: () => transactionPid }
  }

  it('2b-01 beslut, samtliga medlemmar och outbox blir synliga i samma commit', async () => {
    const h = await harness()
    const c = await h.enqueueCommand()
    const original = h.execution.decisions.checkConstraints.bind(h.execution.decisions)
    let inside: Awaited<ReturnType<typeof counts>> | undefined
    let outside: Awaited<ReturnType<typeof counts>> | undefined
    jest.spyOn(h.execution.decisions, 'checkConstraints').mockImplementationOnce(async (tx) => {
      inside = await counts(h.f, tx)
      outside = await counts(h.f, client())
      expect(h.provider.calls).toHaveLength(0)
      expect(h.jobs).toHaveLength(0)
      await original(tx)
    })
    const dispatch = await h.execution.enqueue(c)
    expect(inside).toMatchObject({ decisions: 1, members: 2, events: 1, dispatches: 1 })
    expect(outside).toMatchObject({ decisions: 0, members: 0, events: 0, dispatches: 0 })
    expect(await counts(h.f)).toMatchObject({ decisions: 1, members: 2, events: 1, dispatches: 1 })
    expect(dispatch).toMatchObject({
      organizationId: h.f.organizationId,
      documentId: h.f.documentId,
    })
    expect((await latest(dispatch.decisionId)).request).toMatchObject({
      resources: c.resources,
      team: c.team,
    })
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-02 delskrivningsfel och verkligt uppskjutet FK-fel återställer exakta radantal', async () => {
    const h = await harness()
    const before = await counts(h.f)
    h.ports.render.mockImplementationOnce(() => {
      throw new Error('SYNTHETIC_RENDER_FAILURE')
    })
    await expect(h.execution.enqueue(await h.enqueueCommand())).rejects.toThrow(
      'SYNTHETIC_RENDER_FAILURE',
    )
    expect(await counts(h.f)).toEqual(before)
    const original = h.execution.decisions.checkConstraints.bind(h.execution.decisions)
    let reachedAfterOutbox = false
    jest.spyOn(h.execution.decisions, 'checkConstraints').mockImplementationOnce(async (tx) => {
      expect((await counts(h.f, tx)).dispatches).toBe(1)
      const missingInvoice = key()
      await tx.$executeRaw`INSERT INTO "DeliveryDocument" ("id", "organizationId", "invoiceId", "createdById")
        VALUES (${missingInvoice}, ${h.f.organizationId}, ${missingInvoice}, ${h.f.actorId})`
      reachedAfterOutbox = true
      await original(tx)
    })
    await expect(h.execution.enqueue(await h.enqueueCommand())).rejects.toThrow()
    expect(reachedAfterOutbox).toBe(true)
    expect(await counts(h.f)).toEqual(before)
    expect(h.provider.calls).toHaveLength(0)
    expect(h.jobs).toHaveLength(0)
  })

  it('2b-03 krasch efter commit före publicering återupptas med samma avsikt', async () => {
    const h = await setup()
    expect(h.jobs).toEqual([])
    const restarted = h.restart()
    const pending = await db.deliveryDispatch.findMany({
      where: { organizationId: h.f.organizationId },
    })
    expect(pending).toHaveLength(1)
    await restarted.publish(pending[0]!.decisionId)
    expect(h.jobs).toEqual([h.dispatch.decisionId])
    expect(
      await db.deliveryDispatch.findUnique({ where: { decisionId: h.dispatch.decisionId } }),
    ).toEqual(h.dispatch)
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-04 tappad publiceringskvittens och förlorat köjobb återpublicerar samma identitet', async () => {
    const h = await setup()
    h.ports.publish.mockImplementationOnce(async (id) => {
      h.jobs.push(id)
      throw new Error('SIMULATED_QUEUE_ACK_LOST')
    })
    await expect(h.execution.publish(h.dispatch.decisionId)).rejects.toThrow(
      'SIMULATED_QUEUE_ACK_LOST',
    )
    await h.restart().publish(h.dispatch.decisionId)
    expect(h.jobs).toEqual([h.dispatch.decisionId, h.dispatch.decisionId])
    h.jobs.splice(0) // Simulerad Redis-retention; databasen förändras inte.
    await h.restart().publish(h.dispatch.decisionId)
    expect(h.jobs).toEqual([h.dispatch.decisionId])
    expect((await h.execution.run(h.jobs[0]!)).called).toBe(true)
    expect((await h.restart().run(h.dispatch.decisionId)).called).toBe(false)
    expect(h.provider.calls).toHaveLength(1)
    expect(h.provider.accepted).toHaveLength(1)
    expect(
      await db.deliveryEvent.count({
        where: { decisionId: h.dispatch.decisionId, state: 'SENDING' },
      }),
    ).toBe(1)
  })

  it('2b-05 två verkligt överlappande workers får en start och ett kontrollanrop', async () => {
    const h = await setup()
    const firstConnection = client(),
      secondConnection = client()
    const first = h.restart(firstConnection),
      second = h.restart(secondConnection)
    const secondPid = await pid(secondConnection)
    const hold = holdNextCommit(first)
    const one = observe(first.run(h.dispatch.decisionId))
    await hold.entered
    const two = observe(second.run(h.dispatch.decisionId))
    try {
      await expectBlocked(secondPid, hold.pid())
    } finally {
      hold.release()
    }
    const outcomes = await Promise.all([one, two])
    expect(outcomes.filter((r) => r.ok && r.value.called)).toHaveLength(1)
    expect((await latest(h.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
    expect(
      await db.deliveryEvent.count({
        where: { decisionId: h.dispatch.decisionId, state: 'SENDING' },
      }),
    ).toBe(1)
    expect(h.provider.calls).toHaveLength(1)
    expect(h.provider.accepted).toHaveLength(1)
  })

  it('2b-06 ny verklig INCORRECT-bedömning ger beständigt startkonfliktspår', async () => {
    const h = await setup(await fixture('INVOICE', 4, true))
    const originalDecision = await db.deliveryDecision.findUniqueOrThrow({
      where: { id: h.dispatch.decisionId },
    })
    const reviews = new ReadingReviewService(db as unknown as PrismaService)
    const finding = (await reviews.getReview(h.f.organizationId)).findings.find(
      (f) => f.code === 'HIGH_RATE',
    )!
    expect(finding.reviews[0]!.billingBasisDecision).toBe('VERIFIED_CORRECT_REAL_INCREASE')
    await new DeliveryWrites(db).run(writeScope(h.f), async (tx) => {
      const joined = new ReadingReviewService({
        $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
      } as unknown as PrismaService)
      await joined.saveReview(h.f.organizationId, h.f.actorId, {
        readingId: finding.readingId,
        findingCode: finding.code,
        fingerprint: finding.fingerprint,
        expectedRevision: finding.reviews[0]!.revision,
        assessment: 'EXPLAINED',
        billingBasisDecision: 'INCORRECT',
        comment: 'Syntetisk senare utredning visar felaktigt underlag',
      })
    })
    expect((await h.execution.run(h.dispatch.decisionId)).called).toBe(false)
    expect((await observations(h.dispatch.decisionId, 'CONFLICT'))[0]!.evidence).toMatchObject({
      expected: originalDecision.fingerprint,
    })
    expect(
      await db.deliveryDecision.findUniqueOrThrow({ where: { id: originalDecision.id } }),
    ).toEqual(originalDecision)
    expect((await latest(h.dispatch.decisionId)).state).toBe('DECIDED')
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-07 återkallat beslut förblir återkallat vid gammal köleverans', async () => {
    const h = await setup()
    await service.transition(transition(h.f, h.dispatch.decisionId, 'REVOKED'))
    await h.restart().publish(h.dispatch.decisionId)
    expect((await h.restart().run(h.jobs[0]!)).called).toBe(false)
    expect((await latest(h.dispatch.decisionId)).state).toBe('REVOKED')
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-08 existerande främmande organisation, dokument, mottagare och artefakt avvisas', async () => {
    const a = await setup(),
      b = await setup()
    const beforeA = await counts(a.f),
      beforeB = await counts(b.f)
    await expect(a.execution.run(b.dispatch.decisionId)).rejects.toThrow()
    await expect(
      a.execution.enqueue({ ...a.decisionCommand, organizationId: b.f.organizationId }),
    ).rejects.toThrow()
    await expect(
      a.execution.enqueue({ ...a.decisionCommand, commandKey: key(), documentId: b.f.documentId }),
    ).rejects.toThrow()
    const third = await harness()
    third.ports.render.mockImplementationOnce((snapshot, resources) => {
      const body = JSON.parse(syntheticRenderer(snapshot, resources))
      body.to = [b.f.tenant.email]
      return JSON.stringify(body)
    })
    const beforeThird = await counts(third.f)
    await expect(third.execution.enqueue(await third.enqueueCommand())).rejects.toThrow()
    expect(await counts(third.f)).toEqual(beforeThird)
    const grant = await internal(a.execution).grant(a.dispatch.decisionId)
    expect(grant).not.toBeNull()
    expect(
      await internal(a.execution).finalCheck({
        ...a.dispatch,
        body: b.dispatch.body,
        digest: b.dispatch.digest,
      }),
    ).toBe(false)
    expect((await observations(a.dispatch.decisionId, 'CONFLICT')).length).toBeGreaterThan(0)
    expect((await counts(a.f)).dispatches).toBe(beforeA.dispatches)
    expect(await counts(b.f)).toEqual(beforeB)
    expect(a.provider.calls).toHaveLength(0)
    expect(third.provider.calls).toHaveLength(0)
  })

  it('2b-09 ersatta PDF-, mejl- och resursbyte nekas; kontrollen använder exakt förseglade byte', async () => {
    const h = await harness()
    const c = await h.enqueueCommand()
    h.resources['synthetic/pdf'] = Buffer.from('utbytt PDF under samma nyckel').toString('base64')
    await expect(h.execution.enqueue(c)).rejects.toThrow('DELIVERY_RESOURCE_CONFLICT')
    expect((await counts(h.f)).dispatches).toBe(0)
    expect(h.provider.calls).toHaveLength(0)
    h.resources['synthetic/pdf'] = fixtureResources['synthetic/pdf']!
    const d = await h.execution.enqueue(c)
    const control = await setup()
    for (const mutate of [
      (body: { text: string }) => {
        body.text += ' en ändrad mejlbyte'
      },
      (body: { attachments: Array<{ content: string }> }) => {
        const bytes = Buffer.from(body.attachments[0]!.content, 'base64')
        bytes[0] = bytes[0]! ^ 1
        body.attachments[0]!.content = bytes.toString('base64')
      },
    ]) {
      const changed = await setup()
      await internal(changed.execution).grant(changed.dispatch.decisionId)
      const body = JSON.parse(changed.dispatch.body)
      mutate(body)
      expect(
        await internal(changed.execution).finalCheck({
          ...changed.dispatch,
          body: JSON.stringify(body),
        }),
      ).toBe(false)
      expect((await observations(changed.dispatch.decisionId, 'CONFLICT')).length).toBeGreaterThan(
        0,
      )
      expect(changed.provider.calls).toHaveLength(0)
    }
    expect(h.provider.calls).toHaveLength(0)
    expect((await control.execution.run(control.dispatch.decisionId)).called).toBe(true)
    expect(control.provider.calls[0]!.body).toBe(control.dispatch.body)
    expect(JSON.parse(d.body).attachments[0]).toEqual({
      content: fixtureResources['synthetic/pdf'],
      filename: 'fryst-dokument.pdf',
      content_type: 'application/pdf',
    })
    expect(control.provider.accepted).toHaveLength(1)
  })

  it('2b-10 ändring vinner verklig låstävlan; nekad start committar konflikten', async () => {
    const h = await setup()
    const writer = client(),
      worker = client()
    const writerPid = await pid(writer),
      workerPid = await pid(worker)
    const entered = latch(),
      release = latch()
    const writing = observe(
      new DeliveryWrites(writer).run(writeScope(h.f), async (tx) => {
        await tx.invoice.update({
          where: { id: h.f.documentId },
          data: { notes: 'Vinnande relevant ändring' },
        })
        entered.release()
        await release.promise
      }),
    )
    await entered.promise
    const running = observe(h.restart(worker).run(h.dispatch.decisionId))
    try {
      await expectBlocked(workerPid, writerPid)
    } finally {
      release.release()
    }
    expect((await writing).ok).toBe(true)
    expect(await running).toEqual({ ok: true, value: { called: false } })
    expect((await observations(h.dispatch.decisionId, 'CONFLICT')).length).toBeGreaterThan(0)
    expect((await latest(h.dispatch.decisionId)).state).toBe('DECIDED')
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-11 start vinner verklig låstävlan; dokumentet är spärrat före provideranrop', async () => {
    const h = await setup()
    const firstConnection = client(),
      writer = client()
    const worker = h.restart(firstConnection)
    const writerPid = await pid(writer)
    const hold = holdNextCommit(worker),
      providerEntered = latch(),
      providerRelease = latch()
    h.ports.send.mockImplementationOnce(async (packet) => {
      expect((await latest(h.dispatch.decisionId)).state).toBe('SENDING')
      providerEntered.release()
      await providerRelease.promise
      return h.provider.send(packet)
    })
    const running = observe(worker.run(h.dispatch.decisionId))
    await hold.entered
    const writing = observe(changeDocument(h.f, writer))
    try {
      await expectBlocked(writerPid, hold.pid())
    } finally {
      hold.release()
    }
    await providerEntered.promise
    try {
      expect((await writing).ok).toBe(false)
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: h.f.documentId } })).notes,
      ).not.toBe('Syntetisk ändring')
    } finally {
      providerRelease.release()
    }
    expect((await running).ok).toBe(true)
    expect(h.provider.accepted).toHaveLength(1)
  })

  it('2b-12 bortkopplad workeranslutning under verkligt pågående simulerat provideranrop tar inte bort spärren', async () => {
    const h = await setup()
    const workerConnection = client(),
      worker = h.restart(workerConnection)
    const workerPid = await pid(workerConnection)
    const pending = h.provider.holdNextRequest()
    let originalSettled = false
    const running = observe(worker.run(h.dispatch.decisionId)).then((result) => {
      originalSettled = true
      return result
    })
    await pending.entered
    try {
      expect(h.provider.calls).toHaveLength(1)
      expect(h.provider.pendingRequests).toBe(1)
      expect(h.provider.accepted).toHaveLength(0)
      expect(originalSettled).toBe(false)
      expect((await latest(h.dispatch.decisionId)).state).toBe('SENDING')
      await terminateOwnWorker(workerPid)
      expect(h.provider.pendingRequests).toBe(1)
      expect(originalSettled).toBe(false)
      await expect(changeDocument(h.f, client())).rejects.toThrow('DELIVERY_WRITE_RESERVED')
      await expect(h.restart().run(h.dispatch.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
      await advance(1000, h.provider)
      expect(await h.restart().run(h.dispatch.decisionId)).toMatchObject({
        called: true,
        reply: { status: 409, code: 'concurrent_idempotent_requests' },
      })
      expect(h.provider.calls).toHaveLength(2)
      expect(h.provider.pendingRequests).toBe(1)
      expect(h.provider.accepted).toHaveLength(0)
      expect(originalSettled).toBe(false)
      await expectUnknown(h)
      await expect(changeDocument(h.f, client())).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    } finally {
      pending.release()
    }
    await running // Förlorad kvittocommit får inte göra en ny start tillåten.
    expect(h.provider.pendingRequests).toBe(0)
    expect(h.provider.accepted).toHaveLength(1)
    await expectUnknown(h) // Sent FIRST-svar får inte maskinellt lösa UNKNOWN.
    await advance(5000, h.provider)
    expect(await h.restart().run(h.dispatch.decisionId)).toMatchObject({
      called: true,
      reply: { status: 200, id: h.provider.accepted[0]!.id },
    })
    expect(h.provider.calls).toHaveLength(3)
    expect(h.provider.accepted).toHaveLength(1)
    expect((await latest(h.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
  })

  it('2b-13 krasch efter SENDING utan FIRST behåller tidsgrund och ger endast begränsad RETRY', async () => {
    const h = await setup()
    const start = await service.transaction((tx) =>
      service.transition(
        {
          ...transition(h.f, h.dispatch.decisionId, 'SENDING'),
          actorId: h.principal.id,
          actorKind: 'SERVICE',
        },
        tx,
      ),
    )
    expect(start.startGranted).toBe(false)
    expect(start.event.attemptId).toBe(h.dispatch.attemptId)
    expect(await observations(h.dispatch.decisionId, 'FIRST')).toHaveLength(0)
    const originalTime = await startTime(h.dispatch)
    await expect(changeDocument(h.f)).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    await expect(h.restart().run(h.dispatch.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
    await advance(1000, h.provider)
    expect((await h.restart().run(h.dispatch.decisionId)).called).toBe(true)
    expect(h.provider.calls[0]!.attemptId).toBe(h.dispatch.attemptId)
    expect(h.provider.accepted).toHaveLength(1)
    expect(await observations(h.dispatch.decisionId, 'FIRST')).toHaveLength(0)
    expect(await observations(h.dispatch.decisionId, 'RETRY')).toHaveLength(1)
    expect(await startTime(h.dispatch)).toBe(originalTime)
    const budget = await setup()
    await service.transaction((tx) =>
      service.transition(
        {
          ...transition(budget.f, budget.dispatch.decisionId, 'SENDING'),
          actorId: budget.principal.id,
          actorKind: 'SERVICE',
        },
        tx,
      ),
    )
    const budgetT0 = await startTime(budget.dispatch)
    budget.provider.modes.push({ status: 404 }, { status: 404 }, { status: 404 })
    for (const delay of [1000, 5000, 30_000]) {
      await advance(delay - 1, budget.provider)
      await expect(budget.restart().run(budget.dispatch.decisionId)).rejects.toThrow(
        'DELIVERY_RETRY_LATER',
      )
      await advance(1, budget.provider)
      expect((await budget.restart().run(budget.dispatch.decisionId)).called).toBe(true)
      await expectUnknown(budget)
    }
    await advance(60_000, budget.provider)
    expect((await budget.restart().run(budget.dispatch.decisionId)).called).toBe(false)
    expect(await observations(budget.dispatch.decisionId, 'FIRST')).toHaveLength(0)
    expect(await observations(budget.dispatch.decisionId, 'RETRY')).toHaveLength(3)
    expect((await observations(budget.dispatch.decisionId, 'CLOSED')).length).toBeGreaterThan(0)
    expect(budget.provider.calls).toHaveLength(3)
    expect(budget.provider.accepted).toHaveLength(0)
    expect(await startTime(budget.dispatch)).toBe(budgetT0)
    expect(new Set(budget.provider.calls.map((packet) => packet.attemptId))).toEqual(
      new Set([budget.dispatch.attemptId]),
    )
    await expect(changeDocument(budget.f)).rejects.toThrow('DELIVERY_WRITE_RESERVED')
  })

  it('2b-14 tappat svar och fel vid kvittocommit bevarar korrelation för identisk retry', async () => {
    const a = await setup()
    await lostResponse(a)
    await advance(1000, a.provider)
    await a.restart().run(a.dispatch.decisionId)
    expect(a.provider.calls).toHaveLength(2)
    expect(a.provider.accepted).toHaveLength(1)
    expect((await latest(a.dispatch.decisionId)).evidence).toMatchObject({
      reference: a.provider.accepted[0]!.id,
    })
    const b = await setup()
    const original = b.execution.decisions.checkConstraints.bind(b.execution.decisions)
    let commits = 0
    jest.spyOn(b.execution.decisions, 'checkConstraints').mockImplementation(async (tx) => {
      await original(tx)
      if (++commits === 3) throw new Error('SIMULATED_RECEIPT_COMMIT_FAILURE')
    })
    await expect(b.execution.run(b.dispatch.decisionId)).rejects.toThrow(
      'SIMULATED_RECEIPT_COMMIT_FAILURE',
    )
    expect(b.provider.accepted).toHaveLength(1)
    expect((await latest(b.dispatch.decisionId)).state).toBe('SENDING')
    expect(await observations(b.dispatch.decisionId, 'RECEIPT')).toHaveLength(0)
    await advance(1000, b.provider)
    await b.restart().run(b.dispatch.decisionId)
    expect(b.provider.calls).toHaveLength(2)
    expect(b.provider.accepted).toHaveLength(1)
    expect((await latest(b.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
  })

  it('2b-15 UNKNOWN förbjuder nya försök och kvarstår efter stängning och köomstart', async () => {
    const h = await setup()
    await lostResponse(h)
    const t0 = await startTime(h.dispatch)
    for (const operation of ['ORIGINAL', 'INVOICE_RESEND'] as const)
      await expect(h.execution.enqueue(await h.enqueueCommand(operation))).rejects.toThrow()
    await setTime(t0 + 23 * 3600_000, h.provider)
    await h.restart().publish(h.dispatch.decisionId)
    h.jobs.splice(0)
    await h.restart().publish(h.dispatch.decisionId)
    expect((await h.restart().run(h.jobs[0]!)).called).toBe(false)
    expect(await startTime(h.dispatch)).toBe(t0)
    await expectUnknown(h)
    expect(h.provider.calls).toHaveLength(1)
    expect(
      (await observations(h.dispatch.decisionId, 'CLOSED')).some(
        (o) => (o.evidence as Prisma.JsonObject).reason === 'EXPIRED',
      ),
    ).toBe(true)
    await expect(changeDocument(h.f)).rejects.toThrow('DELIVERY_WRITE_RESERVED')
  })

  it('2b-16 godtycklig acceptans, negativ retry, timeout och 404 lämnar UNKNOWN olöst', async () => {
    const h = await setup()
    await lostResponse(h)
    const fabricated = {
      kind: 'ACCEPTANCE',
      attemptId: h.dispatch.attemptId,
      provider: 'resend',
      reference: 'unverified-id',
      receipt: { outcome: 'ACCEPTED' },
      detail: 'Syntetiskt påstått bevis utan observation',
    }
    await expect(
      service.transition({
        ...transition(
          h.f,
          h.dispatch.decisionId,
          'PROVIDER_ACCEPTED',
          h.dispatch.attemptId,
          fabricated,
        ),
        actorId: h.principal.id,
        actorKind: 'SERVICE',
      }),
    ).rejects.toThrow()
    await expect(
      service.transition(
        transition(
          h.f,
          h.dispatch.decisionId,
          'PROVIDER_ACCEPTED',
          h.dispatch.attemptId,
          fabricated,
        ),
      ),
    ).rejects.toThrow()
    for (const [delay, reply] of [
      [1000, { status: 404, code: 'not_found' }],
      [5000, { status: 0, code: 'TRANSPORT_UNKNOWN' }],
      [30_000, { status: 422, code: 'validation_error' }],
    ] as const) {
      await advance(delay, h.provider)
      h.provider.modes.push(reply)
      await h.restart().run(h.dispatch.decisionId)
      await expectUnknown(h)
    }
    expect(h.provider.calls).toHaveLength(4)
    expect(h.provider.accepted).toHaveLength(1) // Fel på retry motbevisar inte originalacceptansen.
    expect(
      await db.deliveryEvent.count({
        where: {
          decisionId: h.dispatch.decisionId,
          state: { in: ['PROVIDER_ACCEPTED', 'FAILED_NO_ACCEPTANCE'] },
        },
      }),
    ).toBe(0)
    const whitespace = await setup()
    whitespace.provider.modes.push({ status: 200, id: '   ' })
    expect((await whitespace.execution.run(whitespace.dispatch.decisionId)).called).toBe(true)
    await expectUnknown(whitespace)
    expect(await observations(whitespace.dispatch.decisionId, 'RECEIPT')).toHaveLength(1)
    expect(
      (await observations(whitespace.dispatch.decisionId, 'RECEIPT'))[0]!.evidence,
    ).toMatchObject({ status: 200, id: '   ' })
    expect(whitespace.provider.accepted).toHaveLength(0)
  })

  it('2b-17 två uttryckliga fakturaomsändningar får egna identiteter och originalpositionen bevaras', async () => {
    const h = await setup()
    await h.execution.run(h.dispatch.decisionId)
    const dispatches = [h.dispatch]
    for (let i = 0; i < 2; i++) {
      const c = await h.enqueueCommand('INVOICE_RESEND')
      const next = await h.execution.enqueue(c)
      dispatches.push(next)
      await h.execution.run(next.decisionId)
      expect(await h.execution.enqueue(c)).toEqual(next)
      expect((await h.restart().run(next.decisionId)).called).toBe(false)
    }
    expect(new Set(dispatches.map((d) => d.decisionId)).size).toBe(3)
    expect(new Set(dispatches.map((d) => d.attemptId)).size).toBe(3)
    expect(h.provider.calls).toHaveLength(3)
    expect(h.provider.accepted).toHaveLength(3)
    const decisions = await db.deliveryDecision.findMany({
      where: { organizationId: h.f.organizationId },
      orderBy: { sequence: 'asc' },
    })
    expect(decisions.map((d) => d.operation)).toEqual([
      'ORIGINAL',
      'INVOICE_RESEND',
      'INVOICE_RESEND',
    ])
    expect(decisions.slice(1).map((d) => d.originalId)).toEqual([
      h.dispatch.decisionId,
      h.dispatch.decisionId,
    ])
    expect(decisions[2]!.previousId).toBe(decisions[1]!.id)
    await expect(h.execution.enqueue(await h.enqueueCommand())).rejects.toThrow()
    const notice = await setup(await fixture('NOTICE'))
    await notice.execution.run(notice.dispatch.decisionId)
    await expect(
      notice.execution.enqueue(await notice.enqueueCommand('INVOICE_RESEND')),
    ).rejects.toThrow()
  })

  it('2b-18 tjänsteprincipal har egen organisationsgren och ingen mänsklig beslutsrätt', async () => {
    const h = await setup(),
      other = await setup()
    const inactive = await db.deliveryPrincipal.create({
      data: { organizationId: h.f.organizationId, name: 'Inaktiv syntetisk tjänst', active: false },
    })
    for (const principalId of [other.principal.id, inactive.id, h.f.actorId]) {
      const untrusted = new DeliveryExecution(
        client(),
        { ...h.configuration, principalId },
        h.ports,
      )
      await expect(untrusted.run(h.dispatch.decisionId)).rejects.toThrow()
    }
    const serviceCommand = {
      ...(await h.enqueueCommand()),
      actorId: h.principal.id,
      actorKind: 'SERVICE' as const,
    }
    await expect(h.execution.enqueue(serviceCommand)).rejects.toThrow()
    await expect(
      service.register(h.f.organizationId, h.principal.id, {
        kind: 'INVOICE',
        data: { ...h.f.invoiceData, invoiceNumber: key() },
      }),
    ).rejects.toThrow()
    await expect(
      service.transition({
        ...transition(h.f, h.dispatch.decisionId, 'REVOKED'),
        actorId: h.principal.id,
        actorKind: 'SERVICE',
      }),
    ).rejects.toThrow()
    await expect(
      service.transition({
        ...transition(h.f, h.dispatch.decisionId, 'SENDING'),
        actorKind: 'SYSTEM',
      } as unknown as DeliveryTransitionCommand),
    ).rejects.toThrow()
    expect(h.provider.calls).toHaveLength(0)
    const adopted = await service.transaction((tx) =>
      service.transition(
        {
          ...transition(h.f, h.dispatch.decisionId, 'SENDING'),
          actorId: h.principal.id,
          actorKind: 'SERVICE',
        },
        tx,
      ),
    )
    expect(adopted.startGranted).toBe(false)
    expect(adopted.event.actorKind).toBe('SERVICE')
    expect(adopted.event.actorName).toBe(h.principal.name)
    expect(await db.user.findUnique({ where: { id: adopted.event.actorId } })).toBeNull()
    await expect(h.restart().run(h.dispatch.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
    await advance(1000, h.provider)
    h.provider.modes.push({ status: 404 })
    await h.restart().run(h.dispatch.decisionId)
    await expect(
      service.transition({
        ...transition(h.f, h.dispatch.decisionId, 'FAILED_NO_ACCEPTANCE', h.dispatch.attemptId, {
          kind: 'FINAL_REJECTION',
          attemptId: h.dispatch.attemptId,
          provider: 'synthetic',
          reference: key(),
          receipt: { outcome: 'NOT_ACCEPTED_FINAL', finalityReference: key() },
          investigation: { caseId: key(), source: 'synthetic-human-investigation' },
          detail: 'Tjänsten saknar denna rätt',
        }),
        actorId: h.principal.id,
        actorKind: 'SERVICE',
      }),
    ).rejects.toThrow()
    await h.restart().publish(h.dispatch.decisionId)
    expect(h.jobs).toEqual([h.dispatch.decisionId])
    expect(Object.keys(h.configuration).sort()).toEqual(['organizationId', 'principalId', 'team'])
    await expectUnknown(h)
    const revoked = await setup()
    const entered = latch(),
      release = latch()
    revoked.ports.send.mockImplementationOnce(async (packet) => {
      entered.release()
      await release.promise
      return revoked.provider.send(packet)
    })
    const inFlight = observe(revoked.execution.run(revoked.dispatch.decisionId))
    await entered.promise
    try {
      await db.deliveryPrincipal.update({
        where: { id: revoked.principal.id },
        data: { active: false },
      })
    } finally {
      release.release()
    }
    expect((await inFlight).ok).toBe(true)
    expect(await observations(revoked.dispatch.decisionId, 'RECEIPT')).toHaveLength(1)
    expect((await observations(revoked.dispatch.decisionId, 'RECEIPT'))[0]!.evidence).toMatchObject(
      { status: 200, id: revoked.provider.accepted[0]!.id },
    )
    expect((await latest(revoked.dispatch.decisionId)).state).toBe('SENDING')
    await advance(1000, revoked.provider)
    await expect(revoked.restart().run(revoked.dispatch.decisionId)).rejects.toThrow()
    expect(await observations(revoked.dispatch.decisionId, 'FIRST')).toHaveLength(1)
    expect(await observations(revoked.dispatch.decisionId, 'RETRY')).toHaveLength(0)
    expect(revoked.provider.calls).toHaveLength(1)
  })

  it('2b-19 förlorat acceptanssvar löses efter omstart med samma mejl-ID och exakt två POST', async () => {
    const h = await setup()
    await lostResponse(h)
    const t0 = await startTime(h.dispatch),
      firstId = h.provider.accepted[0]!.id
    await advance(1000, h.provider)
    const result = await h.restart().run(h.dispatch.decisionId)
    expect(result).toMatchObject({ called: true, reply: { status: 200, id: firstId } })
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.accepted).toHaveLength(1)
    expect(h.provider.calls[1]).toEqual(h.provider.calls[0])
    expect(h.provider.calls[0]!.attemptId).toBe(h.dispatch.attemptId)
    expect(await startTime(h.dispatch)).toBe(t0)
    const event = await latest(h.dispatch.decisionId)
    expect(event.state).toBe('PROVIDER_ACCEPTED')
    const receipt = await db.deliveryObservation.findUniqueOrThrow({
      where: { id: (event.evidence as Prisma.JsonObject).observationId as string },
    })
    const grant = await db.deliveryObservation.findUniqueOrThrow({
      where: { id: receipt.grantId! },
    })
    expect(grant.kind).toBe('RETRY')
    expect(receipt.evidence).toMatchObject({ status: 200, id: firstId })
    expect(h.ports.render).toHaveBeenCalledTimes(1)
  })

  it('2b-20 aldrig framkommet original får en acceptans genom identisk retry med samma spärr', async () => {
    const h = await setup()
    await lostResponse(h, 'drop-before')
    expect(h.provider.accepted).toHaveLength(0)
    await expect(changeDocument(h.f)).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    const t0 = await startTime(h.dispatch)
    await advance(1000, h.provider)
    await h.restart().run(h.dispatch.decisionId)
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.accepted).toHaveLength(1)
    expect(h.provider.calls[1]).toEqual(h.provider.calls[0])
    expect((await latest(h.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
    expect(await startTime(h.dispatch)).toBe(t0)
    expect((await counts(h.f)).decisions).toBe(1)
  })

  it('2b-21 samtidiga retries möter ett verkligt väntande original; 409, intervall och budget är beständiga', async () => {
    const h = await setup()
    const originalConnection = client(),
      originalWorker = h.restart(originalConnection)
    const originalPid = await pid(originalConnection)
    const pending = h.provider.holdNextRequest()
    let originalSettled = false
    const original = observe(originalWorker.run(h.dispatch.decisionId)).then((result) => {
      originalSettled = true
      return result
    })
    await pending.entered
    const t0 = await startTime(h.dispatch)
    try {
      expect(h.provider.calls).toHaveLength(1)
      expect(h.provider.pendingRequests).toBe(1)
      expect(h.provider.accepted).toHaveLength(0)
      expect(originalSettled).toBe(false)
      await terminateOwnWorker(originalPid)
      expect(h.provider.pendingRequests).toBe(1)
      await advance(999, h.provider)
      await expect(h.restart().run(h.dispatch.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
      await advance(1, h.provider)
      const c1 = client(),
        c2 = client(),
        first = h.restart(c1),
        second = h.restart(c2)
      const secondPid = await pid(c2),
        hold = holdNextCommit(first)
      const one = observe(first.run(h.dispatch.decisionId))
      await hold.entered
      const two = observe(second.run(h.dispatch.decisionId))
      try {
        await expectBlocked(secondPid, hold.pid())
      } finally {
        hold.release()
      }
      const outcomes = await Promise.all([one, two])
      const called = outcomes.filter((result) => result.ok && result.value.called)
      expect(called).toHaveLength(1)
      expect(called[0]).toMatchObject({
        ok: true,
        value: {
          called: true,
          reply: { status: 409, code: 'concurrent_idempotent_requests' },
        },
      })
      await expectUnknown(h)
      expect(h.provider.calls).toHaveLength(2)
      expect(h.provider.pendingRequests).toBe(1)
      expect(h.provider.accepted).toHaveLength(0)
      expect(originalSettled).toBe(false)
      await expect(changeDocument(h.f, client())).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    } finally {
      pending.release()
    }
    await original
    expect(h.provider.pendingRequests).toBe(0)
    expect(h.provider.accepted).toHaveLength(1)
    await expectUnknown(h)
    const finalId = h.provider.accepted[0]!.id
    await advance(4999, h.provider)
    await expect(h.restart().run(h.dispatch.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
    await advance(1, h.provider)
    await h.restart().run(h.dispatch.decisionId)
    expect((await latest(h.dispatch.decisionId)).evidence).toMatchObject({ reference: finalId })
    expect(h.provider.accepted).toHaveLength(1)
    expect(h.provider.calls).toHaveLength(3)
    expect(await startTime(h.dispatch)).toBe(t0)
    const budget = await setup()
    budget.provider.modes.push({ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 })
    await budget.execution.run(budget.dispatch.decisionId)
    for (const delay of [1000, 5000, 30_000]) {
      await advance(delay - 1, budget.provider)
      await expect(budget.restart().run(budget.dispatch.decisionId)).rejects.toThrow(
        'DELIVERY_RETRY_LATER',
      )
      await advance(1, budget.provider)
      await budget.restart().run(budget.dispatch.decisionId)
    }
    await advance(60_000, budget.provider)
    expect((await budget.restart().run(budget.dispatch.decisionId)).called).toBe(false)
    expect(budget.provider.calls).toHaveLength(4)
    expect(await observations(budget.dispatch.decisionId, 'FIRST')).toHaveLength(1)
    expect(await observations(budget.dispatch.decisionId, 'RETRY')).toHaveLength(3)
    expect((await observations(budget.dispatch.decisionId, 'CLOSED')).length).toBeGreaterThan(0)
    await expectUnknown(budget)
  })

  it('2b-22 innehållskonflikt 409 stänger beständigt och blir aldrig provideracceptans', async () => {
    const h = await setup()
    await lostResponse(h)
    await advance(1000, h.provider)
    h.provider.modes.push({ status: 409, code: 'invalid_idempotent_request' })
    await h.restart().run(h.dispatch.decisionId)
    await expectUnknown(h)
    expect(
      (await observations(h.dispatch.decisionId, 'CONFLICT')).some(
        (o) => (o.evidence as Prisma.JsonObject).reason === 'CONTENT_CONFLICT',
      ),
    ).toBe(true)
    expect(
      (await observations(h.dispatch.decisionId, 'CLOSED')).some(
        (o) => (o.evidence as Prisma.JsonObject).reason === 'CONTENT_CONFLICT',
      ),
    ).toBe(true)
    await advance(60_000, h.provider)
    expect((await h.restart().run(h.dispatch.decisionId)).called).toBe(false)
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.accepted).toHaveLength(1)
    expect(
      await db.deliveryDispatch.findUniqueOrThrow({ where: { decisionId: h.dispatch.decisionId } }),
    ).toEqual(h.dispatch)
    const simulated = await h.provider.send({ ...h.provider.calls[0]!, body: 'different-content' })
    expect(simulated).toEqual({ status: 409, code: 'invalid_idempotent_request' })
    expect(h.provider.accepted).toHaveLength(1)
  })

  it('2b-23 DB och anropsgräns förbjuder byte av scope, nyckel och innehåll samt dubbelt attemptId', async () => {
    const h = await setup(),
      other = await setup()
    for (const patch of [
      { team: other.dispatch.team },
      { method: 'GET' },
      { endpoint: 'https://api.resend.com/emails/batch' },
      { attemptId: other.dispatch.attemptId },
      { body: other.dispatch.body, digest: other.dispatch.digest },
    ]) {
      const changed = await setup()
      await internal(changed.execution).grant(changed.dispatch.decisionId)
      await expect(
        db.deliveryDispatch.update({
          where: { decisionId: changed.dispatch.decisionId },
          data: patch,
        }),
      ).rejects.toThrow()
      expect(await internal(changed.execution).finalCheck({ ...changed.dispatch, ...patch })).toBe(
        false,
      )
      expect((await observations(changed.dispatch.decisionId, 'CONFLICT')).length).toBeGreaterThan(
        0,
      )
      expect(changed.provider.calls).toHaveLength(0)
    }
    const foreignTeam = new DeliveryExecution(
      client(),
      { ...h.configuration, team: other.dispatch.team },
      h.ports,
    )
    await expect(foreignTeam.run(h.dispatch.decisionId)).rejects.toThrow()
    for (const attemptId of [h.dispatch.attemptId, 'not-a-uuid']) {
      const fresh = await harness()
      const c = await fresh.enqueueCommand()
      const before = await counts(fresh.f)
      await expect(
        service.transaction(async (tx) => {
          const result = await service.decide(c, tx)
          const body = syntheticRenderer(result.decision.snapshot, fixtureResources)
          await tx.deliveryDispatch.create({
            data: {
              decisionId: result.decision.id,
              organizationId: fresh.f.organizationId,
              documentId: fresh.f.documentId,
              attemptId,
              team: fresh.configuration.team,
              method: 'POST',
              endpoint: 'https://api.resend.com/emails',
              resources: c.resources,
              body,
              digest: createHash('sha256').update(body).digest('hex'),
            },
          })
        }),
      ).rejects.toThrow(/attemptId|uuid|invalid input syntax|Unique constraint/)
      expect(await counts(fresh.f)).toEqual(before)
    }
    expect(h.provider.calls).toHaveLength(0)
    expect(
      await db.deliveryDispatch.findUniqueOrThrow({ where: { decisionId: h.dispatch.decisionId } }),
    ).toEqual(h.dispatch)
  })

  it('2b-24 strikt före deadline kan retry ske; vid och efter stängs den beständigt', async () => {
    for (const offset of [-1, 0, 1]) {
      const h = await setup()
      await lostResponse(h)
      const t0 = await startTime(h.dispatch)
      await setTime(t0 + 23 * 3600_000 + offset, h.provider)
      const result = await h.restart().run(h.dispatch.decisionId)
      expect(result.called).toBe(offset < 0)
      expect(h.provider.calls).toHaveLength(offset < 0 ? 2 : 1)
      expect(h.provider.accepted).toHaveLength(1)
      expect(await startTime(h.dispatch)).toBe(t0)
      if (offset >= 0) {
        await expectUnknown(h)
        expect(
          (await observations(h.dispatch.decisionId, 'CLOSED')).some(
            (o) => (o.evidence as Prisma.JsonObject).reason === 'EXPIRED',
          ),
        ).toBe(true)
        expect((await h.restart().run(h.dispatch.decisionId)).called).toBe(false)
      } else expect((await latest(h.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
    }
  })

  it('2b-25 stängningen överlever omstart, ny köleverans och bakåtflyttad klocka', async () => {
    const h = await setup()
    await lostResponse(h)
    const t0 = await startTime(h.dispatch)
    await setTime(t0 + 23 * 3600_000, h.provider)
    expect((await h.execution.run(h.dispatch.decisionId)).called).toBe(false)
    const closing = await observations(h.dispatch.decisionId, 'CLOSED')
    expect(closing.length).toBeGreaterThan(0)
    await setTime(t0 + 1000, h.provider) // Klockavläsning får aldrig återöppna beständig stängning.
    await h.restart().publish(h.dispatch.decisionId)
    expect((await h.restart().run(h.jobs[0]!)).called).toBe(false)
    expect(await startTime(h.dispatch)).toBe(t0)
    expect(await observations(h.dispatch.decisionId, 'CLOSED')).toEqual(
      expect.arrayContaining(closing),
    )
    await expectUnknown(h)
    expect(h.provider.calls).toHaveLength(1)
    expect(h.provider.accepted).toHaveLength(1)
  })

  it('2b-26 paus före kontroll stoppar POST; paus efter kontroll visar transportantagandets gräns', async () => {
    const before = await setup()
    const entered = latch(),
      release = latch()
    const original = internal(before.execution).finalCheck.bind(before.execution)
    jest
      .spyOn(internal(before.execution), 'finalCheck')
      .mockImplementationOnce(async (dispatch) => {
        entered.release()
        await release.promise
        return original(dispatch)
      })
    const running = observe(before.execution.run(before.dispatch.decisionId))
    await entered.promise
    await setTime((await startTime(before.dispatch)) + 23 * 3600_000, before.provider)
    release.release()
    expect(await running).toEqual({ ok: true, value: { called: false } })
    expect(before.provider.calls).toHaveLength(0)
    expect((await observations(before.dispatch.decisionId, 'CLOSED')).length).toBeGreaterThan(0)

    const duringCommit = await setup()
    const commitEntered = latch(),
      commitRelease = latch()
    const originalCheck = duringCommit.execution.decisions.checkConstraints.bind(
      duringCommit.execution.decisions,
    )
    let commitCount = 0
    jest
      .spyOn(duringCommit.execution.decisions, 'checkConstraints')
      .mockImplementation(async (tx) => {
        await originalCheck(tx)
        if (++commitCount === 2) {
          commitEntered.release()
          await commitRelease.promise
        }
      })
    const delayedCommit = observe(duringCommit.execution.run(duringCommit.dispatch.decisionId))
    await commitEntered.promise
    await setTime(
      (await startTime(duringCommit.dispatch, clockDb)) + 23 * 3600_000,
      duringCommit.provider,
    )
    commitRelease.release()
    expect(await delayedCommit).toEqual({ ok: true, value: { called: false } })
    expect(duringCommit.provider.calls).toHaveLength(0)
    expect(
      (await observations(duringCommit.dispatch.decisionId, 'CLOSED')).some(
        (o) => (o.evidence as Prisma.JsonObject).reason === 'CONSERVATIVE_DEADLINE',
      ),
    ).toBe(true)

    const after = await setup()
    await lostResponse(after)
    const t0 = await startTime(after.dispatch)
    await advance(1000, after.provider)
    const transportEntered = latch(),
      transportRelease = latch()
    after.ports.send.mockImplementationOnce(async (packet) => {
      transportEntered.release() // Exekveraren har redan passerat sista synkrona kontrollen.
      await transportRelease.promise
      return after.provider.send(packet)
    })
    const delayedTransport = observe(after.restart().run(after.dispatch.decisionId))
    await transportEntered.promise
    await setTime(t0 + 25 * 3600_000, after.provider)
    transportRelease.release()
    expect((await delayedTransport).ok).toBe(true)
    expect(after.provider.calls).toHaveLength(2)
    expect(after.provider.accepted).toHaveLength(2) // AVSIKTLIGT brutet transportantagande, inte godkänd driftgaranti.
    expect(after.provider.accepted[0]!.id).not.toBe(after.provider.accepted[1]!.id)
    expect(after.provider.calls[1]).toEqual(after.provider.calls[0])
    expect((await observations(after.dispatch.decisionId, 'CLOSED')).length).toBeGreaterThan(0)
    console.warn('2b-26 avsiktligt obegränsad transportpaus:', {
      calls: after.provider.calls.length,
      acceptances: after.provider.accepted.length,
      guarantee:
        'Kontroll före POST kan inte återkalla redan auktoriserad transport över 24h-cacheutgång.',
    })
  })

  it('2b-27 sena och felkorrelerade kvitton bevaras utan ny anropsrätt', async () => {
    const h = await setup()
    await lostResponse(h)
    await advance(1000, h.provider)
    const retry = (await internal(h.execution).grant(h.dispatch.decisionId))!
    expect(retry.grant.kind).toBe('RETRY')
    expect(await internal(h.execution).finalCheck(retry.d)).not.toBe(false)
    const reply = await h.ports.send(retry.d)
    await setTime((await startTime(h.dispatch)) + 23 * 3600_000, h.provider)
    await internal(h.execution).record(retry.d, retry.grant, reply)
    expect((await latest(h.dispatch.decisionId)).state).toBe('PROVIDER_ACCEPTED')
    expect((await observations(h.dispatch.decisionId, 'CLOSED')).length).toBeGreaterThan(0)
    expect((await h.restart().run(h.dispatch.decisionId)).called).toBe(false)
    const beforeReceipts = (await observations(h.dispatch.decisionId, 'RECEIPT')).length
    await internal(h.execution).record(retry.d, retry.grant, reply)
    await internal(h.execution).record(retry.d, retry.grant, {
      status: 200,
      id: 'different-late-id',
    })
    expect(await observations(h.dispatch.decisionId, 'RECEIPT')).toHaveLength(beforeReceipts + 2)
    expect(
      (await observations(h.dispatch.decisionId, 'CONFLICT')).some(
        (o) => (o.evidence as Prisma.JsonObject).reason === 'CONTRADICTORY_RECEIPT',
      ),
    ).toBe(true)
    expect((await latest(h.dispatch.decisionId)).evidence).toMatchObject({ reference: reply.id })
    const foreign = await setup()
    const foreignGrant = (await internal(foreign.execution).grant(foreign.dispatch.decisionId))!
    const beforeConflicts = (await observations(h.dispatch.decisionId, 'CONFLICT')).length
    await internal(h.execution).record(retry.d, foreignGrant.grant, {
      status: 200,
      id: 'wrong-grant',
    })
    await internal(h.execution).record({ ...retry.d, team: foreign.dispatch.team }, retry.grant, {
      status: 200,
      id: 'wrong-team',
    })
    expect(await observations(h.dispatch.decisionId, 'CONFLICT')).toHaveLength(beforeConflicts + 2)
    expect((await latest(h.dispatch.decisionId)).evidence).toMatchObject({ reference: reply.id })

    const lateOriginal = await setup()
    const first = (await internal(lateOriginal.execution).grant(lateOriginal.dispatch.decisionId))!
    const originalReply = await lateOriginal.ports.send(first.d)
    await service.transition({
      ...transition(lateOriginal.f, first.d.decisionId, 'UNKNOWN', first.d.attemptId),
      actorId: lateOriginal.principal.id,
      actorKind: 'SERVICE',
    })
    await setTime((await startTime(lateOriginal.dispatch)) + 23 * 3600_000, lateOriginal.provider)
    await internal(lateOriginal.execution).record(first.d, first.grant, originalReply)
    await expectUnknown(lateOriginal)
    expect(await observations(first.d.decisionId, 'RECEIPT')).toHaveLength(1)
    expect((await lateOriginal.restart().run(first.d.decisionId)).called).toBe(false)
    expect(lateOriginal.provider.accepted).toHaveLength(1)
    const conflictsBeforeForgedKind = (await observations(first.d.decisionId, 'CONFLICT')).length
    await internal(lateOriginal.execution).record(
      first.d,
      { ...first.grant, kind: 'RETRY' },
      originalReply,
    )
    expect(await observations(first.d.decisionId, 'CONFLICT')).toHaveLength(
      conflictsBeforeForgedKind + 1,
    )
    expect((await observations(first.d.decisionId, 'CONFLICT')).at(-1)!.evidence).toMatchObject({
      reason: 'RECEIPT_CORRELATION',
      grantId: first.grant.id,
    })
    expect(
      (await db.deliveryObservation.findUniqueOrThrow({ where: { id: first.grant.id } })).kind,
    ).toBe('FIRST')
    expect(await observations(first.d.decisionId, 'RECEIPT')).toHaveLength(1)
    await expectUnknown(lateOriginal)
  })

  it('2b-28 dokument och charge-medlemmar spärras; obesläktat dokument i samma org kan skrivas', async () => {
    const f = await fixture()
    const unrelated = await service.register(f.organizationId, f.actorId, {
      kind: 'INVOICE',
      data: { ...f.invoiceData, invoiceNumber: key() },
    })
    const unlinked = await f.addCharge()
    const h = await setup(f)
    const worker = h.restart(client())
    await lostResponse({ ...h, execution: worker })
    await expect(changeDocument(h.f, client())).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    for (const charge of h.f.charges) {
      await expect(
        new DeliveryWrites(client()).run(writeScope(h.f, [], [charge.id]), (tx) =>
          tx.consumptionCharge.update({
            where: { id: charge.id },
            data: { invoiceId: unrelated.id },
          }),
        ),
      ).rejects.toThrow('DELIVERY_WRITE_RESERVED')
      await expect(
        new DeliveryWrites(client()).run(writeScope(h.f, [], [charge.id]), (tx) =>
          tx.consumptionCharge.update({ where: { id: charge.id }, data: { invoiceId: null } }),
        ),
      ).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    }
    await expect(
      new DeliveryWrites(client()).run(writeScope(h.f, [h.f.documentId], [unlinked.id]), (tx) =>
        tx.consumptionCharge.update({
          where: { id: unlinked.id },
          data: { invoiceId: h.f.documentId },
        }),
      ),
    ).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    const changed = await new DeliveryWrites(client()).run(
      writeScope(h.f, [unrelated.id], []),
      (tx) =>
        tx.invoice.update({
          where: { id: unrelated.id },
          data: { notes: 'Annat dokument får committa' },
        }),
    )
    expect(changed.notes).toBe('Annat dokument får committa')
    expect(await db.consumptionCharge.count({ where: { invoiceId: h.f.documentId } })).toBe(
      h.f.charges.length,
    )
    expect(
      (await db.consumptionCharge.findUniqueOrThrow({ where: { id: unlinked.id } })).invoiceId,
    ).toBeNull()
    expect(await db.deliveryMember.count({ where: { decisionId: h.dispatch.decisionId } })).toBe(
      h.f.charges.length,
    )
    await expectUnknown(h)
    // Här simuleras uttryckligen äldre OSAMORDNADE produktionsskrivare.
    // De går direkt mot domäntabellen med samtliga SQL-regler fortfarande på.
    // Produktionsluckan före 2c är alltså synlig; följande kontroller gäller deltagare.
    const frozenOnly = h.f.charges[0]!
    await db.consumptionCharge.update({
      where: { id: frozenOnly.id },
      data: { invoiceId: unrelated.id },
    })
    await db.consumptionCharge.update({
      where: { id: unlinked.id },
      data: { invoiceId: h.f.documentId, status: 'ATTACHED' },
    })
    expect(
      await db.deliveryMember.count({
        where: { decisionId: h.dispatch.decisionId, chargeId: frozenOnly.id },
      }),
    ).toBe(1)
    expect(
      (await db.consumptionCharge.findUniqueOrThrow({ where: { id: frozenOnly.id } })).invoiceId,
    ).toBe(unrelated.id)
    expect(
      await db.deliveryMember.count({
        where: { decisionId: h.dispatch.decisionId, chargeId: unlinked.id },
      }),
    ).toBe(0)
    expect(
      (await db.consumptionCharge.findUniqueOrThrow({ where: { id: unlinked.id } })).invoiceId,
    ).toBe(h.f.documentId)
    for (const chargeId of [frozenOnly.id, unlinked.id]) {
      await expect(
        new DeliveryWrites(client()).run(writeScope(h.f, [], [chargeId]), (tx) =>
          tx.consumptionCharge.update({ where: { id: chargeId }, data: { invoiceId: null } }),
        ),
      ).rejects.toThrow('DELIVERY_WRITE_RESERVED')
    }
    const stillUnrelated = await service.register(h.f.organizationId, h.f.actorId, {
      kind: 'INVOICE',
      data: { ...h.f.invoiceData, invoiceNumber: key() },
    })
    const finalControl = await new DeliveryWrites(client()).run(
      writeScope(h.f, [stillUnrelated.id], []),
      (tx) =>
        tx.invoice.update({
          where: { id: stillUnrelated.id },
          data: { notes: 'Fortfarande ingen organisationsspärr' },
        }),
    )
    expect(finalControl.notes).toBe('Fortfarande ingen organisationsspärr')
    await expectUnknown(h)
  })

  it('2b-29 återanvändbart rendererportkontrakt fäller timestamp, slump, filnamn och en bilagebyte', async () => {
    const h = await setup()
    const snapshot = (
      await db.deliveryDecision.findUniqueOrThrow({ where: { id: h.dispatch.decisionId } })
    ).snapshot
    const expected = syntheticRenderer(snapshot, fixtureResources)
    expect(
      await assertRendererContract(
        () => ({ render: syntheticRenderer }),
        snapshot,
        fixtureResources,
      ),
    ).toBe(expected)
    const mutations: Array<(body: Record<string, unknown>, n: number) => void> = [
      (body, n) => {
        body.text = 'Genererad ' + new Date(Date.UTC(2026, 8, 11) + n).toISOString()
      },
      (body, n) => {
        body.html = '<p>Slumptal ' + n * 0.12345 + '</p>'
      },
      (body, n) => {
        ;(body.attachments as Array<{ filename: string }>)[0]!.filename = `dokument-${n}.pdf`
      },
      (body, n) => {
        const attachment = (body.attachments as Array<{ content: string }>)[0]!
        const bytes = Buffer.from(attachment.content, 'base64')
        bytes[0] = (bytes[0]! + n) % 256
        attachment.content = bytes.toString('base64')
      },
    ]
    for (const mutate of mutations) {
      let n = 0
      await expect(
        assertRendererContract(
          () => ({
            render: (frozen, resources) => {
              const body = JSON.parse(syntheticRenderer(frozen, resources))
              mutate(body, n++)
              return JSON.stringify(body)
            },
          }),
          snapshot,
          fixtureResources,
        ),
      ).rejects.toThrow('RENDERER_NONDETERMINISTIC_BYTES')
    }
    let instance = 0
    await expect(
      assertRendererContract(
        () => {
          const ownInstance = instance++
          return { render: () => expected + ownInstance }
        },
        snapshot,
        fixtureResources,
      ),
    ).rejects.toThrow('RENDERER_NONDETERMINISTIC_BYTES')
    expect(h.provider.calls).toHaveLength(0)
  })

  it('2b-30 resursbyte bakom samma nyckel nekas före försegling men påverkar inte sparad retry', async () => {
    const before = await harness()
    const c = await before.enqueueCommand()
    before.resources['synthetic/template'] = Buffer.from('Ny resurs bakom samma nyckel').toString(
      'base64',
    )
    await expect(before.execution.enqueue(c)).rejects.toThrow('DELIVERY_RESOURCE_CONFLICT')
    expect((await counts(before.f)).decisions).toBe(0)
    const h = await setup()
    await lostResponse(h)
    await expect(
      db.deliveryDispatch.update({
        where: { decisionId: h.dispatch.decisionId },
        data: { body: h.dispatch.body + ' ' },
      }),
    ).rejects.toThrow()
    h.resources['synthetic/template'] = Buffer.from('Live-nyckeln har bytt innehåll').toString(
      'base64',
    )
    h.resources['synthetic/pdf'] = Buffer.from('Utbytta levande PDF-byte').toString('base64')
    h.ports.resources.mockImplementation(() => {
      throw new Error('RETRY_FÅR_INTE_LÄSA_RESURSER')
    })
    h.ports.render.mockImplementation(() => {
      throw new Error('RETRY_FÅR_INTE_RENDERA')
    })
    const renders = h.ports.render.mock.calls.length,
      resourceReads = h.ports.resources.mock.calls.length
    await advance(1000, h.provider)
    await h.restart().run(h.dispatch.decisionId)
    expect(h.ports.render).toHaveBeenCalledTimes(renders)
    expect(h.ports.resources).toHaveBeenCalledTimes(resourceReads)
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.accepted).toHaveLength(1)
    expect(h.provider.calls[1]!.body).toBe(h.dispatch.body)
    expect(h.provider.calls[1]).toEqual(h.provider.calls[0])
  })
})
