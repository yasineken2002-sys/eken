/** R165-1/176: riktig kundstart, CSV-import och allokering på syntetisk Postgres.
 * Fixturen följer den uppmätta basreproduktionen. Externa beroenden kastar eller fångas
 * lokalt; inga providers, appbootstrap, reset eller radering. BANKDATUM176_OUTPUT är
 * en valfri befintlig katalog för råa kundobservationer.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => '' }))
import { PrismaClient, Prisma, type Tenant, type Lease } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { FastifyRequest } from 'fastify'
import { AccountingService as Accounting } from '../accounting/accounting.service'
import { VerifikationsnummerService as Numbers } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService as InvoiceEvents } from '../invoices/invoice-events.service'
import { InvoicesService as Invoices } from '../invoices/invoices.service'
import { ReconciliationService as Reconciliation } from './reconciliation.service'
import { ReconciliationController } from './reconciliation.controller'
import { BankAccountService as BankAccounts } from './bank-account.service'
import { BankImportAttemptService as Attempts } from './bank-import-attempt.service'
import { PaymentFreshnessService as Freshness } from '../payment-freshness/payment-freshness.service'
import { RentNoticeEventsService as NoticeEvents } from '../avisering/rent-notice-events.service'
import { OcrService as Ocr } from '../common/ocr/ocr.service'
import { CutoverService as Cutover } from '../kundstart/cutover.service'
import { OpeningPackageService as Packages } from '../kundstart/opening-package.service'
import { VerifiedVoucherDraftBuilder as ExportBuilder } from '../fortnox/fortnox-export-builder'
const db = new PrismaClient()
const prisma = db as unknown as PrismaService
const medDb = process.env.DATABASE_URL ? describe : describe.skip
const H =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'
const REG = 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt'
const record = (name: string, data: object) => {
  if (process.env.BANKDATUM176_OUTPUT)
    appendFileSync(
      join(process.env.BANKDATUM176_OUTPUT, 'observations.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), name, ...data }) + '\n',
    )
}
const forbidden = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, key) => () => {
        throw new Error(`Förbjudet beroende: ${name}.${String(key)}`)
      },
    },
  ) as never
const attempt = async <T>(f: () => Promise<T>) => {
  try {
    return { returned: await f(), error: null }
  } catch (e) {
    return { returned: null, error: { name: (e as Error).name, message: (e as Error).message } }
  }
}
let serial = 0
jest.setTimeout(120_000)
medDb('bankdatum med riktig Postgres', () => {
  beforeAll(async () => {
    // Samma syntetiska DB får behålla tidigare körningars bevis. Varje fixture har egna id:n.
    await db.$connect()
    globalThis.fetch = (async () => {
      throw new Error('Extern fetch förbjuden')
    }) as typeof fetch
  })
  afterAll(async () => {
    await db.$disconnect()
  }) // Bevara syntetiska bevis, ingen radering.

  async function fixture(label: string, count = 1) {
    const id = `repro165-${label}-${Date.now()}-${++serial}`
    const orgNumber = `97${String(Date.now()).slice(-6)}${String(serial).padStart(2, '0')}`
    await db.organization.create({
      data: {
        id,
        name: `SYNTETISK ${label}`,
        orgNumber,
        email: `${id}@example.invalid`,
        street: 'Syntetgatan 1',
        city: 'Teststad',
        postalCode: '12345',
        status: 'TRIAL',
      },
    })
    const owner = await db.user.create({
      data: {
        organizationId: id,
        email: `${id}-owner@example.invalid`,
        passwordHash: 'synthetic-not-a-login',
        firstName: 'Syntetisk',
        lastName: 'Ägare',
        role: 'OWNER',
      },
    })
    const user = { sub: owner.id, role: 'OWNER' as const }
    const conn = await db.fortnoxConnection.create({
      data: {
        organizationId: id,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 990165,
        fortnoxOrgNumber: orgNumber,
        connectedAt: new Date(Date.now() - 3_600_000),
        exportVoucherSeries: 'A',
        exportOmitDimensionsAt: new Date(Date.now() - 3_600_000),
        exportOmitDimensionsBy: owner.id,
      },
    })
    const property = await db.property.create({
      data: {
        organizationId: id,
        name: 'Syntetfastigheten',
        propertyDesignation: `${id}:1`,
        type: 'RESIDENTIAL',
        street: 'Syntetgatan 1',
        city: 'Teststad',
        postalCode: '12345',
        totalArea: new Prisma.Decimal(100),
      },
    })
    for (const [number, name, type] of [
      [1510, 'Fordran', 'ASSET'],
      [1930, 'Bank', 'ASSET'],
      [2890, 'Deposition', 'LIABILITY'],
      [3911, 'Bostadshyra', 'REVENUE'],
    ] as const)
      await db.account.create({ data: { organizationId: id, number, name, type } })
    const tenants: Array<Tenant & { ocrNumber: string; lease: Lease }> = []
    for (let n = 1; n <= count; n++) {
      const tenant = await db.tenant.create({
        data: {
          organizationId: id,
          type: 'INDIVIDUAL',
          firstName: 'Syntetisk',
          lastName: `Person${n}`,
          email: `${id}-t${n}@example.invalid`,
          ocrNumber: `77710000${n}${n}`,
        },
      })
      const unit = await db.unit.create({
        data: {
          propertyId: property.id,
          name: `Lgh${n}`,
          unitNumber: `${1000 + n}`,
          type: 'APARTMENT',
          area: new Prisma.Decimal(50),
          monthlyRent: new Prisma.Decimal(6000),
        },
      })
      const lease = await db.lease.create({
        data: {
          organizationId: id,
          tenantId: tenant.id,
          unitId: unit.id,
          contractNumber: `K-${n}`,
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          monthlyRent: new Prisma.Decimal(6000),
          depositAmount: new Prisma.Decimal(0),
        },
      })
      tenants.push({ ...tenant, ocrNumber: `77710000${n}${n}`, lease })
    }
    const accounting = new Accounting(prisma, new Numbers(prisma)),
      events = new InvoiceEvents(prisma)
    const notices = new NoticeEvents(prisma),
      notify = { createForAllOrgUsers: async () => undefined }
    const invoices = new Invoices(
      prisma,
      events,
      forbidden('Pdf'),
      forbidden('Mail'),
      accounting,
      notify as never,
      forbidden('InvoiceOcr'),
      forbidden('PdfQueue'),
    )
    const freshness = new Freshness(prisma, {
      sendCustomEmail: jest.fn().mockResolvedValue(undefined),
    } as never)
    const recon = new Reconciliation(
      prisma,
      invoices,
      events,
      accounting,
      freshness,
      notices,
      { enqueue: jest.fn().mockResolvedValue('synthetic-shadow-job') } as never,
      {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      } as never,
      new Attempts(prisma),
    )
    const banks = new BankAccounts(prisma),
      bank = await banks.create(id, { name: 'SYNTETISKT målkonto' })
    const controller = new ReconciliationController(recon, forbidden('PdfImport'), banks)
    const ocr = new Ocr(prisma)
    const cutover = new Cutover(prisma)
    await cutover.set(id, user, '2026-11-01')
    return {
      id,
      orgNumber,
      user,
      conn,
      tenants,
      recon,
      bank,
      banks,
      controller,
      accounting,
      cutover,
      paket: new Packages(prisma, ocr),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function csv(f: Fixture, swapped = false) {
    return (
      [
        H,
        ...f.tenants.map((_t, i) => {
          const t = f.tenants[swapped ? 1 - i : i]!,
            amount = i === 0 ? 6000 : 4000
          return [
            `DOC-${i + 1}`,
            'FORDRAN',
            t.ocrNumber,
            t.lease.contractNumber,
            '',
            '',
            2026,
            10,
            '2026-10-31',
            amount,
            amount,
            '',
          ].join(';')
        }),
      ].join('\n') + '\n'
    )
  }
  async function prepare(f: Fixture, swapped = false, draftOnly = false) {
    const p = await f.paket.create(f.id, f.user, {
      sourceName: 'SYNTETISK-oppning.csv',
      innehall: csv(f, swapped),
    })
    if (draftOnly) return p
    expect((await f.paket.validate(f.id, p.id, f.user)).status).toBe('VALIDATED')
    // Samma lokala läsformat som kundstart.db.spec.ts:83–115; ingen Fortnox-läsning.
    const read = await db.fortnoxReadRun.create({
      data: {
        organizationId: f.id,
        connectionId: f.conn.id,
        fortnoxDatabaseNumber: 990165,
        status: 'COMPLETE',
        financialYearId: 1,
        financialYearStart: new Date('2026-01-01'),
        financialYearEnd: new Date('2026-12-31'),
        periodFrom: new Date('2026-01-01'),
        periodTo: new Date('2026-10-31'),
        costAccounts: [1510, 2890],
        startedAt: new Date(),
        completedAt: new Date(),
        summary: { balanceBroughtForwardOre: { '1510': 0, '2890': 0 } },
        rows: {
          rows: [
            {
              account: 1510,
              amountOre: f.tenants.length === 1 ? 600000 : 1000000,
              bucket: 'UNALLOCATED',
            },
            { account: 2890, amountOre: 0, bucket: 'UNALLOCATED' },
          ],
          references: [],
        },
      },
    })
    await f.paket.bindFortnoxRead(f.id, p.id, f.user, read.id)
    await f.paket.setFirstPeriodRegister(f.id, p.id, f.user, {
      filnamn: 'SYNTETISKT-forsta-perioden.csv',
      innehall: REG,
      system: 'Syntetiskt gammalt system',
      ansvarig: 'Syntetisk ekonomiansvarig',
      tackningFran: '2026-11-01',
      tackningTill: '2026-12-31',
      intaktskonton: [3911],
      forskottskonton: [2420],
    })
    return db.openingPackage.findUniqueOrThrow({ where: { id: p.id } })
  }
  async function execute(f: Fixture, p: Awaited<ReturnType<typeof prepare>>) {
    await f.paket.approve(f.id, p.id, f.user, { version: p.version, sourceSha256: p.sourceSha256 })
    const executed = await f.paket.execute(f.id, p.id, f.user)
    // Syntetisk huvudboksbindning efter verkligt verkställd öppning. f33:s DB-constraint
    // kräver aktiverings-id + företagsbindning; ensam ledgerOwner=FORTNOX är ogiltig fixture.
    const activation = await db.fortnoxCustomerActivation.create({
      data: {
        organizationId: f.id,
        status: 'ACTIVE',
        connectionId: f.conn.id,
        connectionGeneration: f.conn.generation,
        fortnoxDatabaseNumber: 990165,
        fortnoxOrgNumber: f.orgNumber,
        financialYearId: 1,
        financialYearFrom: new Date('2026-01-01'),
        financialYearTo: new Date('2026-12-31'),
        voucherSeries: 'A',
        financialYearAccountingMethod: 'ACCRUAL',
        mappingSha256: 'a'.repeat(64),
        openingPackageId: p.id,
        fortnoxReadRunId: p.fortnoxReadRunId!,
        consequencesText: 'SYNTETISK bindning, inga provideranrop',
        consequencesSha256: 'b'.repeat(64),
        approvedById: f.user.sub,
      },
    })
    await db.organization.update({
      where: { id: f.id },
      data: {
        ledgerOwner: 'FORTNOX',
        ledgerOwnerActivationId: activation.id,
        ledgerOwnerFortnoxDatabaseNumber: 990165,
        ledgerOwnerFortnoxOrgNumber: f.orgNumber,
        ledgerOwnerSetAt: new Date(),
        ledgerOwnerSetById: f.user.sub,
      },
    })
    return executed
  }
  async function snapshot(id: string) {
    const [notices, payments, journals, bankRows, exports, packages, invoicePayments, invoices] =
      await Promise.all([
        db.rentNotice.findMany({
          where: { organizationId: id },
          orderBy: { noticeNumber: 'asc' },
          select: {
            id: true,
            tenantId: true,
            leaseId: true,
            openingRowId: true,
            status: true,
            origin: true,
            totalAmount: true,
            paidAmount: true,
            paidAt: true,
            sentAt: true,
          },
        }),
        db.rentNoticePayment.findMany({ where: { rentNotice: { organizationId: id } } }),
        db.journalEntry.findMany({
          where: { organizationId: id },
          include: { lines: { include: { account: true } } },
        }),
        db.bankTransaction.findMany({ where: { organizationId: id } }),
        db.fortnoxVoucherExport.findMany({
          where: { organizationId: id },
          select: { id: true, state: true },
        }),
        db.openingPackage.findMany({
          where: { organizationId: id },
          select: { id: true, status: true, reconciliationStatus: true },
        }),
        db.invoicePayment.findMany({ where: { invoice: { organizationId: id } } }),
        db.invoice.findMany({
          where: { organizationId: id },
          select: { id: true, status: true, paidAt: true },
        }),
      ])
    return { notices, payments, journals, bankRows, exports, packages, invoicePayments, invoices }
  }

  describe('R165-1 bankimport efter öppning', () => {
    it('före brytdatum får inte reglera OPENING; exakt brytdatum är positiv kontroll', async () => {
      const observations = []
      for (const date of ['2026-10-31', '2026-11-01', '2026-11-02']) {
        const f = await fixture(`bank-${date}`),
          p = await prepare(f)
        expect((await execute(f, p)).status).toBe('EXECUTED')
        const before = await snapshot(f.id)
        expect(before.notices).toHaveLength(1)
        expect(before.notices[0]!.status).toBe('OPENING')
        expect(before.payments).toHaveLength(0)
        expect(before.journals).toHaveLength(0)
        const contents = `Datum;Beskrivning;Belopp;Referens\n${date};SYNTETISK inbetalning;6000;${f.tenants[0]!.ocrNumber}\n`
        const request = {
          file: async () => ({
            filename: `SYNTETISK-${date}.csv`,
            toBuffer: async () => Buffer.from(contents),
          }),
        }
        const imported = await attempt(() =>
          f.controller.importStatement(f.id, request as unknown as FastifyRequest, f.bank.id),
        )
        const afterImport = await snapshot(f.id)
        record('R165-1-import', { date, orgId: f.id, before, imported, afterImport })
        expect(imported.error).toBeNull()
        expect(afterImport.bankRows).toHaveLength(1)
        expect(afterImport.notices[0]!.status).toBe('OPENING')
        expect(afterImport.payments).toHaveLength(0)
        expect(afterImport.journals).toHaveLength(0)
        await f.recon.autoMatchAll(f.id)
        expect((await snapshot(f.id)).payments).toHaveLength(0) // OPENING-pausen gäller även lagrat svep.
        const matched = await attempt(() =>
          f.recon.manualMatch(
            afterImport.bankRows[0]!.id,
            { rentNoticeId: before.notices[0]!.id },
            f.id,
            f.user.sub,
          ),
        )
        const after = await snapshot(f.id)
        let exportDraft: Awaited<ReturnType<ExportBuilder['build']>> | null = null
        if (date === '2026-10-31' && after.journals.length)
          exportDraft = await new ExportBuilder(
            prisma,
            forbidden('FortnoxConnection'),
            forbidden('FortnoxReader'),
          ).build(f.id, after.journals[0]!.id)
        const observation = { date, orgId: f.id, before, afterImport, matched, after, exportDraft }
        record('R165-1-match', observation)
        observations.push(observation)
      }
      const old = observations[0]!
      // Positiv kontroll: godtyckligt bokföringsfel får inte ge ett falskt godkänt stopp.
      for (const current of observations.slice(1)) {
        expect(current.matched.error).toBeNull()
        expect(current.after.payments).toHaveLength(1)
        expect(current.after.journals).toHaveLength(1)
        expect(current.after.notices[0]!.status).toBe('PAID')
        expect(current.after.journals[0]!.date.toISOString().slice(0, 10)).toBe(current.date)
        expect(Number(current.after.payments[0]!.amount)).toBe(6000)
        const lines = current.after.journals[0]!.lines
        expect(Number(lines.find((l) => l.account.number === 1930)?.debit)).toBe(6000)
        expect(Number(lines.find((l) => l.account.number === 1510)?.credit)).toBe(6000)
        expect(current.after.exports).toHaveLength(0)
      }
      if (old.after.journals.length) {
        expect(old.exportDraft!.ok).toBe(false)
        expect(
          (old.exportDraft && !old.exportDraft.ok ? old.exportDraft.reasons : []).join(' '),
        ).toContain('BEFORE_CUTOVER')
      }
      // Basutfall176: före brytdatum blev OPENING PAID + betalning/verifikat 6 000 kr.
      expect(old.matched.error?.message).toMatch(/brytdatum|BEFORE_CUTOVER/i)
      expect(old.after.notices).toEqual(old.before.notices)
      expect(old.after.payments).toHaveLength(0)
      expect(old.after.journals).toHaveLength(0)
      expect(old.after.exports).toHaveLength(0)
      expect(old.afterImport.bankRows[0]!.identityReviewAt).not.toBeNull()
      expect(old.after.bankRows[0]!.identityReviewAt).toEqual(
        old.afterImport.bankRows[0]!.identityReviewAt,
      )
      expect(old.after.bankRows[0]!.status).toBe('UNMATCHED')
    })
  })

  type Target = 'invoice' | 'rent' | 'waterfall'
  type Entry = 'automatic' | 'manual' | 'stored'

  async function targets(f: Fixture, kind: Target) {
    const ids: string[] = []
    const count = kind === 'waterfall' ? 2 : 1
    for (let i = 0; i < count; i++) {
      const amount = 6000 / count
      let id: string
      if (kind === 'invoice') {
        const invoice = await db.invoice.create({
          data: {
            organizationId: f.id,
            invoiceNumber: `F-${serial}`,
            type: 'RENT',
            status: 'SENT',
            tenantId: f.tenants[0]!.id,
            ocrNumber: f.tenants[0]!.ocrNumber,
            subtotal: amount,
            vatTotal: 0,
            total: amount,
            issueDate: new Date('2026-11-01'),
            dueDate: new Date('2026-11-27'),
          },
        })
        id = invoice.id
      } else {
        const notice = await db.rentNotice.create({
          data: {
            organizationId: f.id,
            tenantId: f.tenants[0]!.id,
            leaseId: f.tenants[0]!.lease.id,
            noticeNumber: `A-${serial}-${i}`,
            ocrNumber: f.tenants[0]!.ocrNumber,
            type: 'RENT',
            status: 'SENT',
            sentAt: new Date('2026-11-01'),
            month: 11 + i,
            year: 2026,
            dueDate: new Date(`2026-${11 + i}-27`),
            amount,
            totalAmount: amount,
          },
        })
        id = notice.id
      }
      ids.push(id)
      // Bokförd syntetisk fordran krävs av den riktiga betalningsmotorn.
      const accounts = await db.account.findMany({ where: { organizationId: f.id } })
      await db.journalEntry.create({
        data: {
          organizationId: f.id,
          date: new Date('2026-11-01'),
          fiscalYear: 2026,
          verNumber: i + 1,
          description: 'SYNTETISK bokförd fordran',
          source: 'INVOICE',
          sourceId: kind === 'invoice' ? id : `rent-notice:${id}`,
          lines: {
            create: [
              { accountId: accounts.find((a) => a.number === 1510)!.id, debit: amount, credit: 0 },
              { accountId: accounts.find((a) => a.number === 3911)!.id, debit: 0, credit: amount },
            ],
          },
        },
      })
    }
    return ids
  }

  function bankRequest(date: string, ocr: string) {
    const contents = `Datum;Beskrivning;Belopp;Referens\n${date};SYNTETISK inbetalning;6000;${ocr}\n`
    return {
      file: async () => ({
        filename: `SYNTETISK-${date}.csv`,
        toBuffer: async () => Buffer.from(contents),
      }),
    }
  }

  function manualTarget(kind: Target, ids: string[]) {
    return kind === 'invoice'
      ? { invoiceId: ids[0]! }
      : kind === 'waterfall'
        ? { rentNoticeIds: ids }
        : { rentNoticeId: ids[0]! }
  }

  const cases: Array<[Target, Entry, string]> = []
  for (const kind of ['invoice', 'rent', 'waterfall'] as const)
    for (const entry of ['automatic', 'manual', 'stored'] as const)
      for (const day of ['2026-10-31', '2026-11-01', '2026-11-02']) cases.push([kind, entry, day])

  it.each(cases)('%s / %s / CSV-bankdag %s', async (kind, entry, day) => {
    const f = await fixture(`${kind}-${entry}-${day}`)
    const request = bankRequest(day, entry === 'manual' ? '9990000099' : f.tenants[0]!.ocrNumber)
    const importBank = () =>
      f.controller.importStatement(f.id, request as unknown as FastifyRequest, f.bank.id)
    if (entry === 'stored') await importBank()
    const ids = await targets(f, kind)
    const before = await snapshot(f.id)
    if (entry !== 'stored') await importBank()
    const bank = await db.bankTransaction.findFirstOrThrow({ where: { organizationId: f.id } })
    expect(bank.date.toISOString()).toBe(`${day}T00:00:00.000Z`) // Verkligt CSV-lagrat värde.
    const outcome =
      entry === 'manual'
        ? await attempt(() =>
            f.recon.manualMatch(bank.id, manualTarget(kind, ids), f.id, f.user.sub),
          )
        : entry === 'stored'
          ? await attempt(() => f.recon.autoMatchAll(f.id))
          : null
    const after = await snapshot(f.id)
    const denied = day === '2026-10-31'
    record('matrix', { kind, entry, day, orgId: f.id, before, outcome, after })
    if (denied) {
      if (entry === 'manual') expect(outcome?.error?.message).toMatch(/brytdatum/i)
      expect(after.notices).toEqual(before.notices)
      expect(after.invoices).toEqual(before.invoices)
      expect(after.payments).toHaveLength(0)
      expect(after.invoicePayments).toHaveLength(0)
      expect(after.journals).toEqual(before.journals)
      expect(after.bankRows[0]!.status).toBe('UNMATCHED')
      // Även ett inaktuellt anroparobjekt med senare dag måste stoppas av den lagrade dagen.
      expect(await f.recon.matchTransaction({ ...bank, date: new Date('2026-11-02') }, f.id)).toBe(
        false,
      )
    } else {
      expect(outcome?.error ?? null).toBeNull()
      expect(after.bankRows[0]!.status).toBe('MATCHED')
      const payments = kind === 'invoice' ? after.invoicePayments : after.payments
      expect(payments).toHaveLength(kind === 'waterfall' ? 2 : 1)
      expect(payments.reduce((sum: number, p) => sum + Number(p.amount), 0)).toBe(6000)
      expect(
        (kind === 'invoice' ? after.invoices : after.notices).every((x) => x.status === 'PAID'),
      ).toBe(true)
      const journals = after.journals.filter((j) => j.source === 'PAYMENT')
      expect(journals).toHaveLength(kind === 'waterfall' ? 2 : 1)
      expect(journals.every((j) => j.date.toISOString().slice(0, 10) === day)).toBe(true)
      const lines = journals.flatMap((j) => j.lines)
      expect(
        lines
          .filter((l) => l.account.number === 1930)
          .reduce((n: number, l) => n + Number(l.debit), 0),
      ).toBe(6000)
      expect(
        lines
          .filter((l) => l.account.number === 1510)
          .reduce((n: number, l) => n + Number(l.credit), 0),
      ).toBe(6000)
    }
    expect(after.exports).toHaveLength(0)
    // Repris av samma CSV skapar varken en andra bankrad eller en andra betalning.
    await importBank()
    const replay = await snapshot(f.id)
    expect(replay.bankRows).toHaveLength(1)
    expect(replay.payments).toEqual(after.payments)
    expect(replay.invoicePayments).toEqual(after.invoicePayments)
    expect(replay.journals).toEqual(after.journals)
  })

  it.each(['invoice', 'rent', 'waterfall'] as const)(
    '%s: NULL-brytdatum ger befintlig betalning',
    async (kind) => {
      const f = await fixture(`null-${kind}`)
      await db.organization.update({ where: { id: f.id }, data: { billingCutoverDate: null } })
      await targets(f, kind)
      await f.controller.importStatement(
        f.id,
        bankRequest('2026-10-31', f.tenants[0]!.ocrNumber) as unknown as FastifyRequest,
        f.bank.id,
      )
      const after = await snapshot(f.id)
      expect(after.bankRows[0]!.status).toBe('MATCHED')
      expect(after.journals.filter((j) => j.source === 'PAYMENT')).toHaveLength(
        kind === 'waterfall' ? 2 : 1,
      )
      record('null-cutover', { kind, orgId: f.id, after })
    },
  )

  it('en redan allokerad äldre betalning kan fortfarande avmatchas', async () => {
    const f = await fixture('legacy-unmatch')
    await db.organization.update({ where: { id: f.id }, data: { billingCutoverDate: null } })
    await targets(f, 'rent')
    await f.controller.importStatement(
      f.id,
      bankRequest('2026-10-31', f.tenants[0]!.ocrNumber) as unknown as FastifyRequest,
      f.bank.id,
    )
    const paid = await snapshot(f.id)
    expect(paid.payments).toHaveLength(1)
    // Representerar en historisk allokering som redan fanns före denna rättning.
    // Endast fixtureuppsättning; produktens CutoverService-flyttspärr ändras inte.
    await db.organization.update({
      where: { id: f.id },
      data: { billingCutoverDate: new Date('2026-11-01') },
    })
    await f.recon.unmatchTransaction(
      paid.bankRows[0]!.id,
      f.id,
      f.user.sub,
      'SYNTETISK felallokering',
    )
    const undone = await snapshot(f.id)
    expect(undone.payments).toHaveLength(0)
    expect(undone.bankRows[0]!.status).toBe('UNMATCHED')
    expect(undone.bankRows[0]!.autoMatchExcludedAt).not.toBeNull()
    expect(undone.notices[0]!.status).toBe('SENT')
    expect(undone.journals).toHaveLength(paid.journals.length + 1)
    await f.recon.autoMatchAll(f.id)
    expect((await snapshot(f.id)).payments).toHaveLength(0)
    record('legacy-unmatch', { orgId: f.id, paid, undone })
  })

  it('konto och mål måste tillhöra samma organisation; avvecklat konto stoppas', async () => {
    const a = await fixture('scope-a'),
      b = await fixture('scope-b')
    const own = await targets(a, 'rent'),
      foreign = await targets(b, 'rent')
    const request = bankRequest('2026-11-01', '9990000099')
    await expect(
      a.controller.importStatement(a.id, request as unknown as FastifyRequest, b.bank.id),
    ).rejects.toThrow()
    expect(await db.bankTransaction.count({ where: { organizationId: a.id } })).toBe(0)
    await a.controller.importStatement(a.id, request as unknown as FastifyRequest, a.bank.id)
    const bank = await db.bankTransaction.findFirstOrThrow({ where: { organizationId: a.id } })
    await expect(
      a.recon.manualMatch(bank.id, { rentNoticeId: foreign[0]! }, a.id, a.user.sub),
    ).rejects.toThrow()
    await expect(
      a.recon.manualMatch(bank.id, { rentNoticeId: own[0]! }, b.id, b.user.sub),
    ).rejects.toThrow()
    expect((await snapshot(a.id)).payments).toHaveLength(0)
    expect((await snapshot(b.id)).payments).toHaveLength(0)
    await db.bankAccount.update({ where: { id: a.bank.id }, data: { isActive: false } })
    await expect(
      a.controller.importStatement(a.id, request as unknown as FastifyRequest, a.bank.id),
    ).rejects.toThrow()
  })
})
