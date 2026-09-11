import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { DeliveryDecisions } from './delivery-decisions'
import type { DeliveryDecisionCommand, DeliveryTransitionCommand } from './delivery-decisions'
import { ConsumptionService } from './consumption.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import type { PrismaService } from '../common/prisma/prisma.service'

// Facit 2a-01..14 fryst i docs/granskning/agent3-utskicksgrind-2a-bevisplan.md
// före SQL. Inga produktionskonstanter beräknar förväntade utfall här.
// Alla leverantörsbevis nedan är identifierade syntetiska fixturebevis.
jest.setTimeout(90_000)
describe('2a: beständiga leveransbeslut i PostgreSQL', () => {
  const schema = 'delivery_2a_' + randomUUID().replaceAll('-', '')
  let base: PrismaClient, db: PrismaClient, service: DeliveryDecisions, url: URL
  let baseline: Awaited<ReturnType<typeof inventory>>
  let schemasBefore: unknown
  const clients: PrismaClient[] = []
  const day = (n: number) => new Date(Date.UTC(2026, 0, n))
  const key = () => randomUUID()
  const inputJson = (value: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(value))

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
    if (!process.env.DATABASE_URL) throw new Error('2a kräver riktig PostgreSQL')
    url = new URL(process.env.DATABASE_URL)
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      (!process.env.CI && !url.pathname.startsWith('/agent3_delivery_2a_'))
    ) {
      throw new Error('2a kräver egen lokal testdatabas eller CI:s isolerade databas')
    }
    const publicUrl = new URL(url)
    publicUrl.searchParams.set('schema', 'public')
    base = new PrismaClient({ datasources: { db: { url: publicUrl.toString() } } })
    assert.deepEqual(await extension(), [{ nspname: 'public' }])
    baseline = await inventory(base, 'public')
    schemasBefore = await base.$queryRaw`SELECT nspname FROM pg_namespace ORDER BY nspname`
    console.warn('2a DB före:', url.pathname.slice(1), JSON.stringify(baseline))
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
    service = new DeliveryDecisions(db)
    await identity(db)
    assert.equal(await db.deliveryDecision.count(), 0)
    console.warn(
      '2a privat schema:',
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
          '2a egna fixturrader före städning:',
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
            '2a DB efter:',
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

  async function fixture(kind: 'INVOICE' | 'NOTICE' = 'INVOICE', numberOfCharges = 2) {
    const organization = await db.organization.create({
      data: {
        name: '2a syntetisk organisation',
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
        name: '2a hus',
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
    async function addCharge() {
      const date = day(++readingNumber).toISOString()
      const reading = await consumption.recordReading(
        {
          meterId: meter.id,
          value: 10,
          readingType: 'PERIOD_VOLUME',
          source: 'MANUAL',
          readingDate: date,
          periodStart: date,
          periodEnd: date,
        },
        organization.id,
        actor.id,
      )
      const control = await consumption.getChargeControl(reading.charge!.id, organization.id)
      await consumption.confirmCharge(reading.charge!.id, organization.id, actor.id, {
        expectedFingerprint: control.fingerprint,
      })
      return db.consumptionCharge.findUniqueOrThrow({ where: { id: reading.charge!.id } })
    }
    const charges = []
    for (let i = 0; i < numberOfCharges; i++) charges.push(await addCharge())
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
  function receipt(attemptId: string, kind = 'ACCEPTANCE'): Prisma.InputJsonObject {
    return {
      kind,
      attemptId,
      provider: 'fixture-no-network',
      reference: key(),
      receipt: {
        fixtureMessageId: key(),
        outcome: kind === 'ACCEPTANCE' ? 'ACCEPTED' : 'NOT_ACCEPTED_FINAL',
        finalityReference: key(),
      },
      detail: 'Konstruerat positivt eller slutligt negativt provbevis',
    }
  }
  async function accepted(f: Fixture, decisionId: string) {
    const started = await service.transition(transition(f, decisionId, 'SENDING'))
    return service.transition(
      transition(
        f,
        decisionId,
        'PROVIDER_ACCEPTED',
        started.event.attemptId,
        receipt(started.event.attemptId!),
      ),
    )
  }
  async function counts(f: Fixture, tx: Prisma.TransactionClient = db) {
    const where = { organizationId: f.organizationId }
    return {
      roots: await tx.deliveryDocument.count({ where }),
      decisions: await tx.deliveryDecision.count({ where }),
      members: await tx.deliveryMember.count({ where }),
      events: await tx.deliveryEvent.count({ where }),
    }
  }
  async function raced<T>(
    f: Fixture,
    a: (tx: Prisma.TransactionClient) => Promise<T>,
    b: (tx: Prisma.TransactionClient) => Promise<T>,
    lockOrganization = true,
  ) {
    const first = client(),
      second = client()
    await identity(first)
    await identity(second)
    let release!: () => void, entered!: () => void, secondEntered!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const locked = new Promise<void>((r) => {
      entered = r
    })
    const waiting = new Promise<void>((r) => {
      secondEntered = r
    })
    let firstPid = 0,
      secondPid = 0
    const one = first.$transaction(
      async (tx) => {
        firstPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid
        if (lockOrganization) await tx.$queryRaw`SELECT delivery_lock(${f.organizationId})::text`
        const result = await a(tx)
        await service.checkConstraints(tx)
        entered()
        await barrier
        return result
      },
      { timeout: 20_000 },
    )
    // Rejections observeras omedelbart även medan barriären hålls.
    const observedOne = one.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await Promise.race([
      locked,
      observedOne.then((r) => {
        if ('error' in r) throw r.error
      }),
    ])
    const two = second.$transaction(
      async (tx) => {
        secondPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid
        secondEntered()
        const result = await b(tx)
        await service.checkConstraints(tx)
        return result
      },
      { timeout: 20_000 },
    )
    const observedTwo = two.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await waiting
      expect(secondPid).not.toBe(firstPid)
      let blocked = false
      for (let i = 0; i < 200; i++) {
        const [row] = await db.$queryRaw<
          Array<{ blockers: number[] }>
        >`SELECT pg_blocking_pids(${secondPid}::int) AS blockers`
        if (row!.blockers.includes(firstPid)) {
          blocked = true
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(blocked).toBe(true)
      console.warn('2a faktisk konkurrens:', { firstPid, secondPid, blocked })
    } finally {
      release()
    }
    return Promise.all([observedOne, observedTwo])
  }

  it('2a-01 A: kontrollerat original binder verkligt dokument och hela underlaget', async () => {
    for (const kind of ['INVOICE', 'NOTICE'] as const) {
      const f = await fixture(kind)
      const result = await service.decide(await command(f))
      expect(result.outcome).toBe('CREATED')
      expect(result.startGranted).toBe(false)
      expect(result.event.state).toBe('DECIDED')
      expect(result.event.attemptId).toBeNull()
      expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
      const checks = await db.consumptionChargeCheck.findMany({
        where: { organizationId: f.organizationId },
      })
      expect(result.decision.members.map((m) => [m.chargeId, m.checkId]).sort()).toEqual(
        checks.map((c) => [c.chargeId, c.id]).sort(),
      )
      expect(result.decision.snapshot).toMatchObject({
        contract: 'delivery-domain/v1',
        artifactEvidence: 'UNVERIFIED',
        recipient: { id: f.tenant.id, email: f.tenant.email },
        sender: { name: '2a syntetisk organisation' },
        document: { id: f.documentId, organizationId: f.organizationId },
        lines: expect.arrayContaining([
          expect.objectContaining({ quantity: '10.0000', unitPrice: '2.00', total: '20.00' }),
        ]),
      })
    }
  })
  it('2a-02 B: originalacceptans förbrukar originalet över versions- och mottagarbyte', async () => {
    const f = await fixture()
    const first = await service.decide(await command(f))
    await accepted(f, first.decision.id)
    await db.invoice.update({
      where: { id: f.documentId },
      data: { notes: 'Ny version', status: 'SENT' },
    })
    await db.tenant.update({ where: { id: f.tenant.id }, data: { email: key() + '@example.test' } })
    const before = await counts(f)
    await expect(service.decide(await command(f))).rejects.toThrow('ORIGINAL_ALREADY_ACCEPTED')
    expect(await counts(f)).toEqual(before)
  })
  it('2a-03 C: två successiva avsiktliga fakturaomsändningar får egna identiteter', async () => {
    const f = await fixture()
    const first = await service.decide(await command(f))
    const original = await accepted(f, first.decision.id)
    const decisions = new Set([original.decision.id]),
      attempts = new Set([original.event.attemptId])
    for (let i = 0; i < 2; i++) {
      const request = await command(f, 'INVOICE_RESEND')
      const resend = await service.decide(request)
      expect(resend.decision.operation).toBe('INVOICE_RESEND')
      expect(resend.decision.originalId).toBe(original.decision.id)
      expect((await service.decide(request)).decision.id).toBe(resend.decision.id)
      const result = await accepted(f, resend.decision.id)
      decisions.add(result.decision.id)
      attempts.add(result.event.attemptId)
    }
    expect(decisions.size).toBe(3)
    expect(attempts.size).toBe(3)
    expect(await counts(f)).toEqual({ roots: 1, decisions: 3, members: 6, events: 9 })
    const avi = await fixture('NOTICE')
    await accepted(avi, (await service.decide(await command(avi))).decision.id)
    await expect(service.decide(await command(avi, 'INVOICE_RESEND'))).rejects.toThrow(
      'INVOICE_RESEND_REQUIRES_ACCEPTED_INVOICE',
    )
  })
  it('2a-04 D: UNKNOWN på original eller omsändning blockerar nya operationer beständigt', async () => {
    for (const resend of [false, true]) {
      const f = await fixture()
      let decision = await service.decide(await command(f))
      if (resend) {
        await accepted(f, decision.decision.id)
        decision = await service.decide(await command(f, 'INVOICE_RESEND'))
      }
      const started = await service.transition(transition(f, decision.decision.id, 'SENDING'))
      const unknown = transition(f, decision.decision.id, 'UNKNOWN', started.event.attemptId, {
        kind: 'TIMEOUT',
        detail: 'Utfallet är okänt',
      })
      const writer = client()
      await new DeliveryDecisions(writer).transition(unknown)
      await writer.$disconnect()
      const restarted = client()
      const restartedService = new DeliveryDecisions(restarted)
      const [beforeClock] = await restarted.$queryRaw<
        Array<{ at: Date }>
      >`SELECT clock_timestamp() AS at`
      await new Promise((r) => setTimeout(r, 20))
      const replay = await restartedService.transition(unknown)
      const [afterClock] = await restarted.$queryRaw<
        Array<{ at: Date }>
      >`SELECT clock_timestamp() AS at`
      expect(afterClock!.at.getTime()).toBeGreaterThan(beforeClock!.at.getTime())
      expect(replay.blockingReason).toBe('OUTCOME_UNKNOWN_REQUIRES_HUMAN')
      expect(replay.event.attemptId).toBe(started.event.attemptId)
      await db.invoice.update({
        where: { id: f.documentId },
        data: { notes: 'Ändrat dokument efter osäkerhet' },
      })
      const before = await counts(f)
      for (const operation of ['ORIGINAL', 'INVOICE_RESEND'] as const) {
        await expect(restartedService.decide(await command(f, operation))).rejects.toThrow(
          'OUTCOME_UNKNOWN_REQUIRES_HUMAN',
        )
      }
      expect(await counts(f)).toEqual(before)
      await restarted.$disconnect()
    }
  })
  it('2a-05 exakt återläsning ger ingen rätt; ändrad kommandoinnebörd ger konflikt', async () => {
    const f = await fixture()
    const request = await command(f)
    const saved = await service.decide(request)
    const other = await db.user.create({
      data: {
        organizationId: f.organizationId,
        email: key() + '@example.test',
        firstName: 'Bo',
        lastName: 'Granskare',
        role: 'MANAGER',
      },
    })
    const second = await service.register(f.organizationId, f.actorId, {
      kind: 'INVOICE',
      data: { ...f.invoiceData, invoiceNumber: key() },
    })
    const before = await counts(f)
    for (const change of [
      { operation: 'INVOICE_RESEND' as const },
      { actorId: other.id },
      { documentId: second.id },
      { expectedFingerprint: '0'.repeat(64) },
      { reason: 'Annan innebörd' },
    ]) {
      await expect(service.decide({ ...request, ...change })).rejects.toThrow('KEY_CONFLICT')
    }
    await db.tenant.update({ where: { id: f.tenant.id }, data: { email: 'ny@example.test' } })
    const replay = await service.decide(request)
    expect(replay.decision.id).toBe(saved.decision.id)
    expect(replay.startGranted).toBe(false)
    expect(replay.decision.snapshot).toEqual(saved.decision.snapshot)
    await expect(
      service.decide({ ...(await command(f)), commandKey: request.commandKey }),
    ).rejects.toThrow('KEY_CONFLICT')
    await expect(service.transition(transition(f, saved.decision.id, 'SENDING'))).rejects.toThrow(
      'DELIVERY_SNAPSHOT_CONFLICT',
    )
    expect(await counts(f)).toEqual(before)
  })
  it('2a-06 SENDING och samma försöksidentitet överlever ny anslutning och tjänst', async () => {
    const f = await fixture()
    const request = await command(f)
    const originalClient = client(),
      originalService = new DeliveryDecisions(originalClient)
    const decision = await originalService.decide(request)
    await originalClient.$disconnect()
    const middleClient = client(),
      middle = new DeliveryDecisions(middleClient)
    const recovered = await middle.decide(request)
    expect(recovered.event.state).toBe('DECIDED')
    expect(recovered.decision.id).toBe(decision.decision.id)
    expect(recovered.startGranted).toBe(false)
    const start = transition(f, decision.decision.id, 'SENDING')
    const started = await middle.transition(start)
    expect(started.startGranted).toBe(true)
    await middleClient.$disconnect()
    const freshClient = client(),
      fresh = new DeliveryDecisions(freshClient)
    const replay = await fresh.transition(start)
    expect(replay.outcome).toBe('ALREADY_STARTED')
    expect(replay.startGranted).toBe(false)
    expect(replay.event.state).toBe('SENDING')
    expect(replay.event.attemptId).toBe(started.event.attemptId)
    expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 2 })
    await expect(fresh.transition({ ...start, commandKey: key() })).rejects.toThrow(
      'DELIVERY_TRANSITION_FORBIDDEN',
    )
    await expect(fresh.transition({ ...start, attemptId: key() })).rejects.toThrow('KEY_CONFLICT')
    await freshClient.$disconnect()
  })
  it('2a-07 samtidiga originalbeslut: en vinnare, samma nyckel återläser', async () => {
    for (const sameKey of [false, true]) {
      const f = await fixture()
      const first = await command(f),
        second = { ...first, commandKey: sameKey ? first.commandKey : key() }
      const [a, b] = await raced(
        f,
        (tx) => service.decide(first, tx),
        (tx) => service.decide(second, tx),
      )
      expect(a).toHaveProperty('value')
      if ('value' in a && 'value' in b) {
        expect(sameKey).toBe(true)
        expect(b.value.decision.id).toBe(a.value.decision.id)
        expect(b.value.startGranted).toBe(false)
      } else {
        expect(sameKey).toBe(false)
        expect(String('error' in b ? b.error : '')).toContain('DECISION_IN_PROGRESS')
      }
      expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
    }
  })
  it('2a-08 återkallelse mot start: båda låsordningar har exakt en vinnare', async () => {
    for (const firstState of ['REVOKED', 'SENDING'] as const) {
      const f = await fixture()
      const decision = await service.decide(await command(f))
      const secondState = firstState === 'REVOKED' ? 'SENDING' : 'REVOKED'
      const [a, b] = await raced(
        f,
        (tx) => service.transition(transition(f, decision.decision.id, firstState), tx),
        (tx) => service.transition(transition(f, decision.decision.id, secondState), tx),
      )
      expect(a).toHaveProperty('value.event.state', firstState)
      expect(a).toHaveProperty('value.startGranted', false)
      expect(String('error' in b ? b.error : '')).toContain('DELIVERY_TRANSITION_FORBIDDEN')
      expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 2 })
      expect(
        await db.deliveryEvent.findMany({
          where: { decisionId: decision.decision.id },
          orderBy: { revision: 'asc' },
          select: { state: true },
        }),
      ).toEqual([{ state: 'DECIDED' }, { state: firstState }])
    }
  })
  it('2a-09 återkallat och slutligt misslyckat original tillåter nytt uttryckligt beslut', async () => {
    for (const end of ['REVOKED', 'FAILED_NO_ACCEPTANCE'] as const) {
      const f = await fixture(),
        request = await command(f)
      const first = await service.decide(request)
      if (end === 'REVOKED') await service.transition(transition(f, first.decision.id, end))
      else {
        const start = await service.transition(transition(f, first.decision.id, 'SENDING'))
        await service.transition(
          transition(
            f,
            first.decision.id,
            end,
            start.event.attemptId,
            receipt(start.event.attemptId!, 'FINAL_REJECTION'),
          ),
        )
      }
      const next = await service.decide(await command(f))
      expect(next.decision.id).not.toBe(first.decision.id)
      expect(next.decision.documentId).toBe(first.decision.documentId)
      expect(next.decision.previousId).toBe(first.decision.id)
      expect(next.decision.originalId).toBeNull()
      const before = await counts(f),
        replay = await service.decide(request)
      expect(replay.event.state).toBe(end)
      expect(replay.decision.id).toBe(first.decision.id)
      expect(replay.startGranted).toBe(false)
      expect(await counts(f)).toEqual(before)
    }
  })
  // Rå SQL via Prisma-modellerna: produktionsmetodernas kontroll körs inte här.
  async function rawDecision(
    tx: Prisma.TransactionClient,
    f: Fixture,
    request: DeliveryDecisionCommand,
  ) {
    const [data] = await tx.$queryRaw<
      Array<{ snapshot: Prisma.InputJsonObject; fingerprint: string }>
    >`
      SELECT s AS snapshot, delivery_fingerprint(s) AS fingerprint FROM (SELECT delivery_snapshot(${f.organizationId}, ${f.documentId}) AS s) q`
    return tx.deliveryDecision.create({
      data: {
        id: key(),
        organizationId: f.organizationId,
        documentId: f.documentId,
        sequence: 1,
        operation: request.operation,
        ...data!,
      },
    })
  }
  it('2a-10 existerande organisations-, dokument- och kontrollidentiteter får inte korskopplas', async () => {
    const f = await fixture(),
      other = await fixture()
    const request = await command(f),
      before = await counts(f)
    await expect(service.decide({ ...request, actorId: other.actorId })).rejects.toThrow()
    await expect(service.decide({ ...request, documentId: other.documentId })).rejects.toThrow(
      'HISTORY_UNVERIFIED',
    )
    const foreignCheck = await db.consumptionChargeCheck.findFirstOrThrow({
      where: { chargeId: other.charges[0]!.id },
    })
    const localChecks = await db.consumptionChargeCheck.findMany({
      where: { organizationId: f.organizationId },
      orderBy: { chargeId: 'asc' },
    })
    for (const member of [
      {
        chargeId: other.charges[0]!.id,
        checkId: foreignCheck.id,
        expected: 'DELIVERY_MEMBER_RELATION',
      },
      {
        chargeId: localChecks[0]!.chargeId,
        checkId: foreignCheck.id,
        expected: 'Foreign key constraint',
      },
      {
        chargeId: localChecks[0]!.chargeId,
        checkId: localChecks[1]!.id,
        expected: 'Foreign key constraint',
      },
    ]) {
      await expect(
        db.$transaction(async (tx) => {
          const decision = await rawDecision(tx, f, request)
          await tx.deliveryMember.create({
            data: {
              organizationId: f.organizationId,
              documentId: f.documentId,
              decisionId: decision.id,
              chargeId: member.chargeId,
              checkId: member.checkId,
            },
          })
        }),
      ).rejects.toThrow(member.expected)
      expect(await counts(f)).toEqual(before)
    }
    const wrongTenant = await db.tenant.create({
      data: {
        organizationId: f.organizationId,
        type: 'INDIVIDUAL',
        firstName: 'Fel',
        lastName: 'Part',
        email: 'wrong@example.test',
      },
    })
    await db.invoice.update({ where: { id: f.documentId }, data: { tenantId: wrongTenant.id } })
    await expect(service.decide(await command(f))).rejects.toThrow('DELIVERY_MEMBER_RELATION')
    expect(await counts(f)).toEqual(before)
    await db.invoice.update({ where: { id: f.documentId }, data: { tenantId: f.tenant.id } })
    await db.user.update({ where: { id: f.actorId }, data: { isActive: false } })
    await expect(service.decide(request)).rejects.toThrow()
    expect(await counts(f)).toEqual(before)
  })
  it('2a-11 medlemsmängden är fullständig och extra INSERT efter försegling avvisas', async () => {
    const f = await fixture(),
      request = await command(f)
    const saved = await service.decide(request)
    expect(saved.decision.members).toHaveLength(2)
    const extra = await f.addCharge()
    await db.consumptionCharge.update({
      where: { id: extra.id },
      data: { status: 'ATTACHED', invoiceId: f.documentId },
    })
    const check = await db.consumptionChargeCheck.findFirstOrThrow({
      where: { chargeId: extra.id },
    })
    const before = await counts(f)
    await expect(
      db.deliveryMember.create({
        data: {
          organizationId: f.organizationId,
          documentId: f.documentId,
          decisionId: saved.decision.id,
          chargeId: extra.id,
          checkId: check.id,
        },
      }),
    ).rejects.toThrow('DELIVERY_MEMBERS_SEALED')
    expect(await counts(f)).toEqual(before)
    for (const table of [
      'DeliveryDocument',
      'DeliveryDecision',
      'DeliveryMember',
      'DeliveryEvent',
    ]) {
      for (const sql of [
        `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE false`,
        `DELETE FROM "${table}" WHERE false`,
        `TRUNCATE "${table}" CASCADE`,
      ]) {
        await expect(db.$executeRawUnsafe(sql)).rejects.toThrow()
      }
    }
    const omitted = await fixture(),
      omittedRequest = await command(omitted)
    await expect(
      db.$transaction(async (tx) => {
        const d = await rawDecision(tx, omitted, omittedRequest)
        const check = await tx.consumptionChargeCheck.findFirstOrThrow({
          where: { chargeId: omitted.charges[0]!.id },
        })
        await tx.deliveryMember.create({
          data: {
            organizationId: omitted.organizationId,
            documentId: omitted.documentId,
            decisionId: d.id,
            chargeId: check.chargeId,
            checkId: check.id,
          },
        })
        await tx.deliveryEvent.create({
          data: {
            id: key(),
            organizationId: omitted.organizationId,
            documentId: omitted.documentId,
            decisionId: d.id,
            revision: 1,
            commandKey: omittedRequest.commandKey,
            request: inputJson(omittedRequest),
            state: 'DECIDED',
            evidence: {},
            actorId: omitted.actorId,
            actorName: '',
          },
        })
      }),
    ).rejects.toThrow('DELIVERY_MEMBER_CONFLICT')
    const changed = await fixture(),
      changedRequest = await command(changed)
    await expect(
      db.$transaction(async (tx) => {
        await service.decide(changedRequest, tx)
        await tx.invoice.update({
          where: { id: changed.documentId },
          data: { notes: 'Ändrat efter första event före commit' },
        })
        const [changedSnapshot] = await tx.$queryRaw<
          Array<{ fingerprint: string }>
        >`SELECT delivery_fingerprint(delivery_snapshot(${changed.organizationId}, ${changed.documentId})) AS fingerprint`
        expect(changedSnapshot!.fingerprint).not.toBe(changedRequest.expectedFingerprint)
        await service.checkConstraints(tx)
      }),
    ).rejects.toThrow('DELIVERY_UNSEALED')
    expect(await counts(changed)).toEqual({ roots: 1, decisions: 0, members: 0, events: 0 })
    const blocked = await fixture(),
      blockedRequest = await command(blocked)
    await db.meterReading.update({
      where: { id: blocked.charges[1]!.meterReadingId },
      data: { value: 20 },
    })
    await expect(service.decide(blockedRequest)).rejects.toThrow('aktuella avläsningen')
    expect(await counts(blocked)).toEqual({ roots: 1, decisions: 0, members: 0, events: 0 })
  })
  async function rawTransition(
    f: Fixture,
    decisionId: string,
    revision: number,
    request: DeliveryTransitionCommand,
  ) {
    const id = key()
    return db.deliveryEvent.create({
      data: {
        id,
        organizationId: f.organizationId,
        documentId: f.documentId,
        decisionId,
        revision,
        commandKey: request.commandKey,
        request: inputJson(request),
        state: request.to,
        attemptId: request.to === 'SENDING' ? id : request.attemptId,
        evidence: request.evidence,
        actorId: f.actorId,
        actorName: '',
      },
    })
  }
  it('2a-12 tillstånd, försökskorrelation och slutbevis skyddas även med direkt SQL', async () => {
    const f = await fixture(),
      decision = await service.decide(await command(f))
    for (const state of ['UNKNOWN', 'PROVIDER_ACCEPTED', 'FAILED_NO_ACCEPTANCE'] as const) {
      await expect(service.transition(transition(f, decision.decision.id, state))).rejects.toThrow(
        'DELIVERY_TRANSITION_FORBIDDEN',
      )
    }
    await expect(
      rawTransition(f, decision.decision.id, 2, {
        ...transition(f, decision.decision.id, 'SENDING'),
        organizationId: key(),
      }),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    const start = await service.transition(transition(f, decision.decision.id, 'SENDING'))
    await expect(
      service.transition(
        transition(f, decision.decision.id, 'PROVIDER_ACCEPTED', key(), receipt(key())),
      ),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    await expect(
      service.transition(
        transition(f, decision.decision.id, 'FAILED_NO_ACCEPTANCE', start.event.attemptId, {
          kind: 'FINAL_REJECTION',
          provider: 'fixture',
          reference: key(),
          attemptId: start.event.attemptId,
          receipt: { timeout: true },
          detail: 'En timeout avgör inte utfallet',
        }),
      ),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    await service.transition(transition(f, decision.decision.id, 'UNKNOWN', start.event.attemptId))
    const unknownEvent = await db.deliveryEvent.findFirstOrThrow({
      where: { decisionId: decision.decision.id },
      orderBy: { revision: 'desc' },
    })
    const illegalKey = key()
    await expect(
      db.deliveryEvent.create({
        data: {
          ...unknownEvent,
          id: key(),
          revision: 4,
          commandKey: illegalKey,
          state: 'DECIDED',
          request: { ...inputJson(unknownEvent.request), commandKey: illegalKey, to: 'DECIDED' },
          evidence: inputJson(unknownEvent.evidence),
        },
      }),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    const end = transition(
      f,
      decision.decision.id,
      'PROVIDER_ACCEPTED',
      start.event.attemptId,
      receipt(start.event.attemptId!),
    )
    await expect(service.transition(end)).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    const resolved = await service.transition({
      ...end,
      evidence: {
        ...end.evidence,
        investigation: {
          caseId: 'syntetiskt-utredningsärende',
          source: 'syntetisk leverantörskvittens',
        },
      },
    })
    expect(resolved.event.state).toBe('PROVIDER_ACCEPTED')
    expect(resolved.startGranted).toBe(false)
    await expect(
      service.transition(transition(f, decision.decision.id, 'REVOKED', start.event.attemptId)),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    await expect(
      service.transition(
        transition(
          f,
          decision.decision.id,
          'FAILED_NO_ACCEPTANCE',
          start.event.attemptId,
          receipt(start.event.attemptId!, 'FINAL_REJECTION'),
        ),
      ),
    ).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 4 })
    const failed = await fixture(),
      failedDecision = await service.decide(await command(failed))
    const failedStart = await service.transition(
      transition(failed, failedDecision.decision.id, 'SENDING'),
    )
    await service.transition(
      transition(failed, failedDecision.decision.id, 'UNKNOWN', failedStart.event.attemptId),
    )
    const failure = await service.transition(
      transition(
        failed,
        failedDecision.decision.id,
        'FAILED_NO_ACCEPTANCE',
        failedStart.event.attemptId,
        {
          ...receipt(failedStart.event.attemptId!, 'FINAL_REJECTION'),
          investigation: {
            caseId: 'syntetiskt-slutavslag',
            source: 'verifierbar syntetisk slutkvittens',
          },
        },
      ),
    )
    expect(failure.event.state).toBe('FAILED_NO_ACCEPTANCE')
    expect((await service.decide(await command(failed))).decision.previousId).toBe(
      failedDecision.decision.id,
    )

    const stale = await fixture(),
      saved = await service.decide(await command(stale))
    await db.meterReading.update({
      where: { id: stale.charges[0]!.meterReadingId },
      data: { value: 21 },
    })
    await expect(
      rawTransition(stale, saved.decision.id, 2, transition(stale, saved.decision.id, 'SENDING')),
    ).rejects.toThrow('DELIVERY_SNAPSHOT_CONFLICT')
    expect(await counts(stale)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
  })
  it('2a-13 fel efter observerade delskrivningar rullar tillbaka hela operationen', async () => {
    const f = await fixture(),
      request = await command(f),
      before = await counts(f)
    await expect(
      db.$transaction(async (tx) => {
        await service.decide(request, tx)
        expect(await counts(f, tx)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
        throw new Error('avsiktligt efter beslutsdelarna')
      }),
    ).rejects.toThrow('avsiktligt efter beslutsdelarna')
    expect(await counts(f)).toEqual(before)
    const saved = await service.decide(request)
    const start = transition(f, saved.decision.id, 'SENDING')
    await expect(
      db.$transaction(async (tx) => {
        const provisional = await service.transition(start, tx)
        expect(provisional.startGranted).toBe(false)
        expect(await tx.deliveryEvent.count({ where: { decisionId: saved.decision.id } })).toBe(2)
        throw new Error('avsiktligt efter startskrivning')
      }),
    ).rejects.toThrow('avsiktligt efter startskrivning')
    expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
    expect((await service.transition(start)).startGranted).toBe(true)
    let attemptedRoot = ''
    const observed = db.$extends({
      query: {
        deliveryDocument: {
          async create({ args, query }) {
            const result = await query(args)
            attemptedRoot = result.id!
            return result
          },
        },
      },
    })
    const registration = new DeliveryDecisions(observed as unknown as PrismaClient)
    const rootsBefore = await db.deliveryDocument.count(),
      invoicesBefore = await db.invoice.count()
    await expect(
      registration.register(f.organizationId, f.actorId, { kind: 'INVOICE', data: f.invoiceData }),
    ).rejects.toThrow()
    expect(attemptedRoot).not.toBe('')
    expect(await db.deliveryDocument.findUnique({ where: { id: attemptedRoot } })).toBeNull()
    expect(await db.invoice.findUnique({ where: { id: attemptedRoot } })).toBeNull()
    expect(await db.deliveryDocument.count()).toBe(rootsBefore)
    expect(await db.invoice.count()).toBe(invoicesBefore)
  })
  it('2a-14 äldre ID kan inte få skapandegrund, inte heller genom samtidighetsfönstret', async () => {
    const f = await fixture()
    const legacy = await db.invoice.create({
      data: {
        ...f.invoiceData,
        organizationId: f.organizationId,
        invoiceNumber: key(),
        status: 'SENT',
      },
    })
    await expect(service.prepare({ ...f, documentId: legacy.id })).rejects.toThrow(
      'HISTORY_UNVERIFIED',
    )
    await expect(
      db.deliveryDocument.create({
        data: {
          id: legacy.id,
          organizationId: f.organizationId,
          invoiceId: legacy.id,
          createdById: f.actorId,
        },
      }),
    ).rejects.toThrow('HISTORY_UNVERIFIED')
    const pendingId = key()
    const [older, registration] = await raced<unknown>(
      f,
      (tx) =>
        tx.invoice.create({
          data: {
            ...f.invoiceData,
            id: pendingId,
            organizationId: f.organizationId,
            invoiceNumber: key(),
          },
        }),
      (tx) =>
        tx.deliveryDocument.create({
          data: {
            id: pendingId,
            organizationId: f.organizationId,
            invoiceId: pendingId,
            createdById: f.actorId,
          },
        }),
      false,
    )
    expect(older).toHaveProperty('value')
    expect(String('error' in registration ? registration.error : '')).toContain(
      'HISTORY_UNVERIFIED',
    )
    expect(await db.deliveryDocument.findUnique({ where: { id: pendingId } })).toBeNull()
    // Extra runtime-fält kan inte göra create till upsert eller välja historisk identitet.
    const data = { ...f.invoiceData, id: legacy.id, organizationId: key(), invoiceNumber: key() }
    const root = await service.register(f.organizationId, f.actorId, { kind: 'INVOICE', data })
    expect(root.id).not.toBe(legacy.id)
    expect(root.organizationId).toBe(f.organizationId)
    expect(await db.invoice.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({
      id: root.id,
      organizationId: f.organizationId,
    })
    expect(await db.deliveryDocument.count({ where: { organizationId: f.organizationId } })).toBe(2)
  })
  it('2a-15 avtalsmottagare prövas utan att medlemsspärren kan maskera felet', async () => {
    const f = await fixture('INVOICE', 0)
    const other = await db.tenant.create({
      data: {
        organizationId: f.organizationId,
        type: 'INDIVIDUAL',
        firstName: 'Annan',
        lastName: 'Hyresgäst',
        email: 'annan@example.test',
      },
    })
    await db.invoice.update({ where: { id: f.documentId }, data: { tenantId: other.id } })
    await expect(service.decide(await command(f))).rejects.toThrow('DELIVERY_TRANSITION_FORBIDDEN')
    expect(await counts(f)).toEqual({ roots: 1, decisions: 0, members: 0, events: 0 })
  })
  it('2a-16 snapshot binder exakta rader, betalning, mall, avtal, fastighet och avi-kreditrader', async () => {
    for (const mutation of [
      'line',
      'payment',
      'template',
      'lease',
      'property',
      'notice-credit',
    ] as const) {
      const f = await fixture(mutation === 'notice-credit' ? 'NOTICE' : 'INVOICE')
      let creditLine = ''
      if (mutation === 'notice-credit') {
        const credit = await db.rentNoticeCredit.create({
          data: {
            organizationId: f.organizationId,
            rentNoticeId: f.documentId,
            amount: 5,
            reason: 'Syntetisk nedsättning',
            creditedAt: day(10),
            lines: { create: { description: 'Syntetisk kreditrad', amount: 5 } },
          },
          include: { lines: true },
        })
        creditLine = credit.lines[0]!.id
      }
      const request = await command(f),
        saved = await service.decide(request)
      const snapshot = saved.decision.snapshot as Record<string, unknown>
      const lines =
        f.kind === 'INVOICE'
          ? await db.invoiceLine.findMany({
              where: { invoiceId: f.documentId },
              orderBy: { id: 'asc' },
            })
          : await db.rentNoticeLine.findMany({
              where: { rentNoticeId: f.documentId },
              orderBy: { id: 'asc' },
            })
      expect((snapshot.lines as Array<{ id: string }>).map((l) => l.id)).toEqual(
        lines.map((l) => l.id),
      )
      expect(snapshot.checks).toEqual(
        expect.arrayContaining(
          f.charges.map((c) =>
            expect.objectContaining({
              chargeId: c.id,
              organizationId: f.organizationId,
              readingId: c.meterReadingId,
              fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
              evidence: expect.any(Object),
            }),
          ),
        ),
      )
      expect((snapshot.checks as unknown[]).length).toBe(2)
      expect(snapshot.lease).toMatchObject({ id: f.lease.id, tenantId: f.tenant.id })
      expect(snapshot.property).toMatchObject({ organizationId: f.organizationId })
      if (mutation === 'line')
        await db.invoiceLine.update({
          where: { id: lines[1]!.id },
          data: { description: 'Ändrad andra rad' },
        })
      if (mutation === 'payment')
        await db.organization.update({
          where: { id: f.organizationId },
          data: { bankgiro: '123-4567' },
        })
      if (mutation === 'template')
        await db.organization.update({
          where: { id: f.organizationId },
          data: { invoiceTemplate: 'modern' },
        })
      if (mutation === 'lease')
        await db.lease.update({ where: { id: f.lease.id }, data: { monthlyRent: 1001 } })
      if (mutation === 'property') {
        const unit = await db.unit.findUniqueOrThrow({ where: { id: f.lease.unitId } })
        await db.property.update({
          where: { id: unit.propertyId },
          data: { street: 'Ny tryckt adress' },
        })
      }
      if (mutation === 'notice-credit')
        await db.rentNoticeCreditLine.update({
          where: { id: creditLine },
          data: { description: 'Ändrad kreditrad' },
        })
      expect((await service.prepare(f)).fingerprint).not.toBe(request.expectedFingerprint)
      await expect(service.transition(transition(f, saved.decision.id, 'SENDING'))).rejects.toThrow(
        'DELIVERY_SNAPSHOT_CONFLICT',
      )
      expect(await counts(f)).toEqual({ roots: 1, decisions: 1, members: 2, events: 1 })
    }
  })
  it('2a-17 ägd registrering rapporterar uppskjutet FK-fel och full rollback', async () => {
    const f = await fixture('INVOICE', 0)
    const before = await counts(f),
      invoicesBefore = await db.invoice.count()
    let writtenRoot = '',
      writtenDocument = ''
    const faultyStorage = db.$extends({
      query: {
        deliveryDocument: {
          async create({ args, query }) {
            const row = await query(args)
            writtenRoot = row.id!
            return row
          },
        },
        invoice: {
          async create({ args, query }) {
            // Verklig insättning under fel identitet: rotens FK brister först vid slutkontroll.
            const row = await query({ ...args, data: { ...args.data, id: key() } })
            writtenDocument = row.id!
            return row
          },
        },
      },
    })
    await expect(
      new DeliveryDecisions(faultyStorage as unknown as PrismaClient).register(
        f.organizationId,
        f.actorId,
        { kind: 'INVOICE', data: { ...f.invoiceData, invoiceNumber: key() } },
      ),
    ).rejects.toThrow('DeliveryDocument_organizationId_invoiceId_fkey')
    expect(writtenRoot).not.toBe('')
    expect(writtenDocument).not.toBe('')
    expect(writtenRoot).not.toBe(writtenDocument)
    expect(await counts(f)).toEqual(before)
    expect(await db.invoice.count()).toBe(invoicesBefore)
    expect(await db.deliveryDocument.findUnique({ where: { id: writtenRoot } })).toBeNull()
    expect(await db.invoice.findUnique({ where: { id: writtenDocument } })).toBeNull()
  })
})
