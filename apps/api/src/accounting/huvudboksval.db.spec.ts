/**
 * HUVUDBOK-STEG1 (154/156/158): beständigt huvudboksval och gemensamma serverregler.
 *
 * Riktig Postgres, riktig Nest-HTTP (pipe, guards, felfilter), verklig `executeTool` och de
 * verkliga tjänsterna. Fixturerna för Fortnox-anslutning, öppningspaket och kundaktivering
 * skrivs direkt i den syntetiska databasen — inget externt anrop, ingen OAuth.
 *
 * Facit: KONTRAKT-154 F1–F11 och KONTRAKT-154-T1 (F4b, F6b, F7c, F11). Varje nekande prövas
 * mot RADER i databasen före och efter (verifikat, nummerserie, leverantörsfakturor,
 * bokslut), inte bara mot statuskoden.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { ConflictException, ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingController } from './accounting.controller'
import { AccountingService } from './accounting.service'
import { AccountingPeriodService } from './accounting-period.service'
import { SupplierInvoiceService } from './supplier-invoice.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { EXTERN_HUVUDBOK } from './huvudboksval'
import { FortnoxCustomerActivationController } from '../fortnox/fortnox-customer-activation.controller'
import { FortnoxCustomerActivationService } from '../fortnox/fortnox-customer-activation.service'
import {
  mappningsSha,
  provaAktivering,
  provaOchOgiltigforklara,
} from '../fortnox/fortnox-customer-activation'
import { OrganizationsController } from '../organizations/organizations.controller'
import { OrganizationsService } from '../organizations/organizations.service'
import { DelegationService } from '../ai/delegation/delegation.service'
import { StorageService } from '../storage/storage.service'
import { AiAuditService } from '../ai/audit/ai-audit.service'
import { ToolExecutorService } from '../ai/tools/tool-executor.service'
import { prövaDelegerbarhet } from '../ai/delegation/delegation-scope'
import { EFFECT_DECLARATIONS } from '../ai/tools/effect-idempotency'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const HEMLIGHET = 'huvudbok-154-syntetisk-provhemlighet'
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

type Roll = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'MANAGER'
interface Org {
  id: string
  orgnr: string
  anv: Record<Roll, string>
}

medDb('HUVUDBOK-STEG1 · huvudboksval och gemensamma serverregler', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let accounting: AccountingService
  let perioder: AccountingPeriodService
  let leverantor: SupplierInvoiceService
  let aktivering: FortnoxCustomerActivationService
  let executor: ToolExecutorService
  const jwt = new JwtService({ secret: HEMLIGHET })
  const skapade: string[] = []
  let dbnr = 970_000 + Math.floor(Math.random() * 20_000)

  const token = (o: Org, roll: Roll = 'OWNER') =>
    jwt.sign({ sub: o.anv[roll], organizationId: o.id, role: roll })
  const http = (
    o: Org,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    roll: Roll = 'OWNER',
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      headers: { authorization: `Bearer ${token(o, roll)}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        AccountingController,
        FortnoxCustomerActivationController,
        OrganizationsController,
      ],
      providers: [
        PrismaService,
        JwtStrategy,
        VerifikationsnummerService,
        AccountingService,
        AccountingPeriodService,
        SupplierInvoiceService,
        FortnoxCustomerActivationService,
        OrganizationsService,
        { provide: StorageService, useValue: {} },
        {
          provide: DelegationService,
          useValue: {
            pauseAllForOrganization: () => {
              throw new Error('154: delegationspausen anropades oväntat')
            },
          },
        },
        // FORTNOX_CUSTOMER_WRITES lämnas AV: valet kräver ingen kundskrivning.
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET, get: () => undefined } },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalFilters(
      new GlobalExceptionFilter({ logInternalError: async () => undefined } as never),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = module.get(PrismaService)
    accounting = module.get(AccountingService)
    perioder = module.get(AccountingPeriodService)
    leverantor = module.get(SupplierInvoiceService)
    aktivering = module.get(FortnoxCustomerActivationService)

    // Verklig executeTool, samma konstruktion som effect-trace-production-path.db.spec.ts:
    // bokföringsverktygen rör bara prisma, verifikationsnummer, audit och perioderna.
    executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma,
      audit: new AiAuditService(prisma),
      verifikationsnummer: module.get(VerifikationsnummerService),
      accountingPeriods: perioder,
    })
  })

  afterAll(async () => {
    if (prisma && skapade.length) {
      const where = { organizationId: { in: skapade } }
      await prisma.organization.updateMany({
        where: { id: { in: skapade } },
        data: {
          ledgerOwner: 'EVENO',
          ledgerOwnerActivationId: null,
          ledgerOwnerFortnoxDatabaseNumber: null,
          ledgerOwnerFortnoxOrgNumber: null,
          ledgerOwnerSetAt: null,
          ledgerOwnerSetById: null,
        },
      })
      // FK-ordning: barn före förälder. Varje steg är bästa försök; en kvarlämnad syntetisk
      // rad rör ingen annan svit (egna organisationer), men städningen ska inte fälla provet.
      const steg: Array<() => Promise<unknown>> = [
        () => prisma.aiToolExecution.deleteMany({ where }),
        () => prisma.supplierInvoiceVatAdjustment.deleteMany({ where }),
        () => prisma.supplierInvoice.deleteMany({ where }),
        () => prisma.expenseVatDecision.deleteMany({ where }),
        () => prisma.journalEntryLine.deleteMany({ where: { journalEntry: where } }),
        () => prisma.journalEntry.updateMany({ where, data: { reversalOfEntryId: null } }),
        () => prisma.journalEntry.deleteMany({ where }),
        () => prisma.journalEntrySequence.deleteMany({ where }),
        () => prisma.fiscalYearClose.deleteMany({ where }),
        () => prisma.accountingPeriodEvent.deleteMany({ where }),
        () => prisma.closedAccountingPeriod.deleteMany({ where }),
        () => prisma.fortnoxCustomerActivation.deleteMany({ where }),
        () => prisma.openingPackage.deleteMany({ where }),
        () => prisma.fortnoxConnection.deleteMany({ where }),
        () => prisma.lease.deleteMany({ where }),
        () => prisma.tenant.deleteMany({ where }),
        () => prisma.unit.deleteMany({ where: { property: where } }),
        () => prisma.property.deleteMany({ where }),
        () => prisma.account.deleteMany({ where }),
        () => prisma.user.deleteMany({ where }),
        () => prisma.organization.deleteMany({ where: { id: { in: skapade } } }),
      ]
      for (const s of steg)
        await s().catch((e: Error) => console.warn(`städning: ${e.message.split('\n').pop()}`))
    }
    if (app) await app.close()
  })

  // ── fixturer ────────────────────────────────────────────────────────────────
  async function nyOrg(): Promise<Org> {
    const sfx = randomUUID().slice(0, 8)
    const orgnr = `55${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const org = await prisma.organization.create({
      data: {
        name: `hb154-${sfx}`,
        email: `hb154-${sfx}@example.invalid`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        orgNumber: `${orgnr.slice(0, 6)}-${orgnr.slice(6)}`,
        billingCutoverDate: new Date('2026-01-01T00:00:00Z'),
      },
    })
    skapade.push(org.id)
    const anv = {} as Record<Roll, string>
    for (const roll of ['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'] as Roll[]) {
      const u = await prisma.user.create({
        data: {
          organizationId: org.id,
          email: `hb154-${sfx}-${roll.toLowerCase()}@example.invalid`,
          passwordHash: 'x',
          firstName: roll,
          lastName: 'Syntetisk',
          role: roll,
        },
      })
      anv[roll] = u.id
    }
    await accounting.seedDefaultAccounts(org.id)
    return { id: org.id, orgnr, anv }
  }

  /** Giltig ACTIVE kundaktivering mot en ACTIVE anslutning (direkt i syntetisk DB). */
  async function aktiv(o: Org, databasnummer = (dbnr += 1)) {
    const conn = await prisma.fortnoxConnection.create({
      data: {
        organizationId: o.id,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: databasnummer,
        fortnoxOrgNumber: o.orgnr,
        exportVoucherSeries: 'E',
        connectedAt: new Date(Date.now() - 3_600_000),
      },
    })
    const paket = await prisma.openingPackage.create({
      data: {
        organizationId: o.id,
        status: 'EXECUTED',
        cutoverDate: new Date('2026-01-01T00:00:00Z'),
        sourceName: 'syntetisk.csv',
        sourceSha256: 'a'.repeat(64),
        createdById: o.anv.OWNER,
        executedAt: new Date(Date.now() - 1_800_000),
        reconciliationStatus: 'AVSTAMD',
        zeroOpening: true,
      },
    })
    const sha = (await mappningsSha(prisma, o.id, 2026))!
    const a = await prisma.fortnoxCustomerActivation.create({
      data: {
        organizationId: o.id,
        status: 'ACTIVE',
        connectionId: conn.id,
        connectionGeneration: conn.generation,
        fortnoxDatabaseNumber: databasnummer,
        fortnoxOrgNumber: o.orgnr,
        financialYearId: 2026,
        financialYearFrom: new Date('2026-01-01T00:00:00Z'),
        financialYearTo: new Date('2026-12-31T00:00:00Z'),
        voucherSeries: 'E',
        financialYearAccountingMethod: 'ACCRUAL',
        mappingSha256: sha,
        openingPackageId: paket.id,
        fortnoxReadRunId: 'syntetisk-lasning',
        consequencesText: 'syntetisk konsekvenstext',
        consequencesSha256: 'b'.repeat(64),
        approvedById: o.anv.OWNER,
      },
    })
    return { conn, paket, a, databasnummer }
  }

  const valj = (o: Org, activationId: string, roll: Roll = 'OWNER') =>
    http(
      o,
      'POST',
      '/integrations/fortnox/customer-activation/ledger-owner',
      { activationId },
      roll,
    )

  async function fortnoxVald(o: Org) {
    const f = await aktiv(o)
    const r = await valj(o, f.a.id)
    expect(r.statusCode).toBe(200)
    return f
  }

  /** Allt som en nekad handling inte får ha rört. */
  async function rader(orgId: string) {
    const [ver, seq, lev, bokslut, period] = await Promise.all([
      prisma.journalEntry.count({ where: { organizationId: orgId } }),
      prisma.journalEntrySequence.findMany({
        where: { organizationId: orgId },
        select: { lastNumber: true },
      }),
      prisma.supplierInvoice.count({ where: { organizationId: orgId } }),
      prisma.fiscalYearClose.count({ where: { organizationId: orgId } }),
      prisma.accountingPeriodEvent.count({ where: { organizationId: orgId } }),
    ])
    return { ver, nummer: seq.reduce((s, r) => s + r.lastNumber, 0), lev, bokslut, period }
  }

  const verifikat = (beskrivning: string) => ({
    date: '2026-03-10',
    description: beskrivning,
    lines: [
      { accountNumber: 6110, debit: 100 },
      { accountNumber: 1930, credit: 100 },
    ],
  })
  const utgift = {
    date: '2026-03-11',
    description: 'syntetisk utgift',
    amount: 250,
    accountNumber: 6110,
    vatTreatment: 'INGEN_MOMS',
  }
  const levfaktura = {
    supplierName: 'Syntetisk Leverantör AB',
    description: 'syntetisk reparation',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    expenseAccount: 6110,
    amount: 1000,
    vatRate: 0,
    vatTreatment: 'INGEN_MOMS',
  }

  function nekadHttp(r: { statusCode: number; body: string }) {
    expect(r.statusCode).toBe(409)
    const b = JSON.parse(r.body) as { error?: { code?: string; message?: string } }
    expect(b.error?.message ?? r.body).toMatch(/Fortnox som huvudbok/)
  }

  // ── F1 ──────────────────────────────────────────────────────────────────────
  describe('F1: standard EVENO — oförändrat beteende', () => {
    it('ny organisation är EVENO; fria vägar fungerar som förut', async () => {
      const o = await nyOrg()
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })
      expect(org.ledgerOwner).toBe('EVENO')
      expect(org.ledgerOwnerActivationId).toBeNull()

      const v = await http(
        o,
        'POST',
        '/accounting/journal-entries',
        verifikat('F1 fritt'),
        'ACCOUNTANT',
      )
      expect(v.statusCode).toBe(201)
      expect((await http(o, 'POST', '/accounting/expenses', utgift, 'ACCOUNTANT')).statusCode).toBe(
        201,
      )
      const lf = await http(o, 'POST', '/accounting/supplier-invoices', levfaktura, 'ACCOUNTANT')
      expect(lf.statusCode).toBe(201)
      const id = (JSON.parse(v.body) as { data: { id: string } }).data.id
      const rt = await http(
        o,
        'POST',
        `/accounting/journal/${id}/reverse`,
        { reason: 'F1 rättelse av syntetiskt verifikat' },
        'ACCOUNTANT',
      )
      expect(rt.statusCode).toBe(201)

      const las = await http(o, 'GET', '/accounting/ledger-owner', undefined, 'ACCOUNTANT')
      expect(JSON.parse(las.body).data).toMatchObject({ agare: 'EVENO', skal: null })
    })
  })

  // ── F2 / F3 / F10 / F11 ──────────────────────────────────────────────────────
  describe('F2: kontrollerat val', () => {
    it('bara OWNER; kräver aktiv aktivering med rätt id; binder företaget; andra valet nekas', async () => {
      const o = await nyOrg()
      const annan = await nyOrg()
      // Ingen aktivering alls.
      const utan = await valj(o, randomUUID())
      expect(utan.statusCode).toBe(409)
      expect(utan.body).toMatch(/Ingen aktiv kundaktivering/)

      const f = await aktiv(o)
      const fa = await aktiv(annan)
      for (const roll of ['ADMIN', 'ACCOUNTANT', 'MANAGER'] as Roll[])
        expect((await valj(o, f.a.id, roll)).statusCode).toBe(403)
      expect((await valj(o, randomUUID())).statusCode).toBe(409)
      // Annan organisations aktivering.
      expect((await valj(o, fa.a.id)).statusCode).toBe(409)
      // Ogiltigt id (DTO).
      expect((await valj(o, 'inte-ett-id')).statusCode).toBe(400)
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })).ledgerOwner,
      ).toBe('EVENO')

      const ok = await valj(o, f.a.id)
      expect(ok.statusCode).toBe(200)
      const rad = await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })
      expect(rad).toMatchObject({
        ledgerOwner: 'FORTNOX',
        ledgerOwnerActivationId: f.a.id,
        ledgerOwnerFortnoxDatabaseNumber: f.databasnummer,
        ledgerOwnerFortnoxOrgNumber: o.orgnr,
        ledgerOwnerSetById: o.anv.OWNER,
      })
      const igen = await valj(o, f.a.id)
      expect(igen.statusCode).toBe(409)
      expect(igen.body).toMatch(/redan vald/)

      // F3: den andra organisationen är orörd och skriver fritt.
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: annan.id } })).ledgerOwner,
      ).toBe('EVENO')
      expect(
        (
          await http(
            annan,
            'POST',
            '/accounting/journal-entries',
            verifikat('F3 annan org'),
            'ACCOUNTANT',
          )
        ).statusCode,
      ).toBe(201)
    })

    it('F10: generell PATCH av organisationen kan inte sätta huvudboken', async () => {
      const o = await nyOrg()
      const r = await http(o, 'PATCH', '/organizations/me', { ledgerOwner: 'FORTNOX' })
      expect(r.statusCode).toBe(400)
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })).ledgerOwner,
      ).toBe('EVENO')
    })

    it('F11: en öppen leverantörsfaktura (även efter ångrad betalning) nekar valet', async () => {
      const o = await nyOrg()
      const f = await aktiv(o)
      const lf = await http(o, 'POST', '/accounting/supplier-invoices', levfaktura, 'ACCOUNTANT')
      const fid = (JSON.parse(lf.body) as { data: { id: string } }).data.id
      const n1 = await valj(o, f.a.id)
      expect(n1.statusCode).toBe(409)
      expect(n1.body).toMatch(/1 öppna leverantörsfakturor/)

      // Betald → tillåtet läge; ångrad betalning → OPEN igen → nekas igen.
      const betald = await http(
        o,
        'POST',
        `/accounting/supplier-invoices/${fid}/pay`,
        { paidDate: '2026-03-20' },
        'ACCOUNTANT',
      )
      expect([200, 201]).toContain(betald.statusCode)
      const det = await leverantor.details(fid, o.id)
      const led = det as unknown as { betalningar?: Array<{ journalEntry: { id: string } }> }
      const betalningsId =
        led.betalningar?.[0]?.journalEntry.id ??
        (
          await prisma.journalEntry.findFirstOrThrow({
            where: {
              organizationId: o.id,
              source: 'SUPPLIER_INVOICE',
              sourceId: { startsWith: 'supplier-invoice-payment:' },
            },
          })
        ).id
      const angra = await http(
        o,
        'POST',
        `/accounting/supplier-invoices/${fid}/payments/${betalningsId}/undo`,
        { reason: 'syntetisk ångring F11' },
        'ACCOUNTANT',
      )
      expect([200, 201]).toContain(angra.statusCode)
      expect(
        (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: fid } })).paidAt,
      ).toBeNull()
      expect((await valj(o, f.a.id)).statusCode).toBe(409)

      // Makulerad → inga öppna → valet går igenom.
      expect([200, 201]).toContain(
        (await http(o, 'POST', `/accounting/supplier-invoices/${fid}/cancel`, {}, 'ACCOUNTANT'))
          .statusCode,
      )
      expect((await valj(o, f.a.id)).statusCode).toBe(200)
    })
  })

  // ── F4 / F4b ─────────────────────────────────────────────────────────────────
  describe('F4: FORTNOX nekar fria handlingar i HTTP och AI utan sidoeffekter', () => {
    it('HTTP: fritt verifikat, utgift, leverantörsfaktura, rättelse och årsbokslut → 409', async () => {
      const o = await nyOrg()
      // Ett verifikat från EVENO-tiden att försöka rätta efteråt.
      const v = await http(
        o,
        'POST',
        '/accounting/journal-entries',
        verifikat('före valet'),
        'ACCOUNTANT',
      )
      const id = (JSON.parse(v.body) as { data: { id: string } }).data.id
      await fortnoxVald(o)

      const fore = await rader(o.id)
      // KUNDEFFEKTEN först (inga nya rader), därefter svaret — så att en saknad spärr visar sig
      // som det verifikat/den faktura som skapades, inte bara som en annan statuskod.
      for (const [url, body, roll] of [
        ['/accounting/journal-entries', verifikat('F4 fritt'), 'ACCOUNTANT'],
        ['/accounting/expenses', utgift, 'OWNER'],
        ['/accounting/supplier-invoices', levfaktura, 'ACCOUNTANT'],
        [`/accounting/journal/${id}/reverse`, { reason: 'F4 rättelse ska nekas' }, 'ACCOUNTANT'],
      ] as const) {
        const r = await http(o, 'POST', url, body, roll)
        expect({ url, ...(await rader(o.id)) }).toEqual({ url, ...fore })
        nekadHttp(r)
      }
      for (let m = 1; m <= 11; m += 1)
        await prisma.accountingPeriodEvent.create({
          data: {
            organizationId: o.id,
            year: 2026,
            month: m,
            seq: 1,
            type: 'CLOSED',
            actorType: 'SYSTEM',
          },
        })
      const forePeriod = await rader(o.id)
      await expect(
        perioder.closeFiscalYear(o.id, 2026, new Date('2027-02-15T09:00:00Z'), {
          actorRole: 'ADMIN',
          actorUserId: o.anv.ADMIN,
        }),
      ).rejects.toMatchObject({ response: { code: EXTERN_HUVUDBOK } })
      expect(await rader(o.id)).toEqual(forePeriod)
      expect({ ...(await rader(o.id)), period: fore.period }).toEqual(fore)

      const las = await http(o, 'GET', '/accounting/ledger-owner', undefined, 'ACCOUNTANT')
      expect(JSON.parse(las.body).data).toMatchObject({ agare: 'FORTNOX' })
      expect(JSON.parse(las.body).data.skal).toMatch(/Fortnox som huvudbok/)
    })

    it('F4b: executeTool nekar create_journal_entry och record_expense efter bekräftelse; close_period tillåts', async () => {
      const o = await nyOrg()
      await fortnoxVald(o)
      const fore = await rader(o.id)
      const principal = { kind: 'USER' as const, id: o.anv.OWNER }
      const bevis = { actionProof: { claimed: true } } as never

      for (const [verktyg, indata] of [
        ['create_journal_entry', verifikat('AI F4b')],
        [
          'record_expense',
          {
            date: '2026-03-12',
            description: 'AI-utgift',
            amount: 300,
            accountNumber: 6110,
            vatTreatment: 'INGEN_MOMS',
          },
        ],
      ] as const) {
        const res = await executor
          .executeTool(verktyg, indata as Record<string, unknown>, o.id, principal, 'OWNER', bevis)
          .catch((e: Error) => ({ success: false, message: e.message }))
        // Kundeffekten först: inget verifikat, inget nummer — sedan svarsflaggan.
        expect({ verktyg, ...(await rader(o.id)) }).toEqual({ verktyg, ...fore })
        expect(res.success).toBe(false)
        expect(
          String(
            (res as { message?: string; error?: string }).message ??
              (res as { error?: string }).error,
          ),
        ).toMatch(/Fortnox som huvudbok/)
      }
      expect(await rader(o.id)).toEqual(fore)
      // Ingen exekveringsrad står som lyckad för de nekade verktygen.
      const lyckade = await prisma.aiToolExecution.count({
        where: {
          organizationId: o.id,
          toolName: { in: ['create_journal_entry', 'record_expense'] },
          success: true,
        },
      })
      expect(lyckade).toBe(0)

      // Månadsstängning = operativ periodspärr (BP-1): samma policy som HTTP, tillåten.
      const stang = await executor.executeTool(
        'close_period',
        { year: 2026, month: 1 },
        o.id,
        principal,
        'OWNER',
        bevis,
      )
      expect(stang.success).toBe(true)
      expect(
        await prisma.accountingPeriodEvent.count({
          where: { organizationId: o.id, type: 'CLOSED' },
        }),
      ).toBe(1)
    })

    // F-161-1: leverantörsfakturor som redan var PAID/CANCELLED vid valet. 409 ska komma FÖRE
    // affärsregeln, och inget fält, ingen justering, inget verifikat eller nummer får ändras.
    it('F4c: ångrad betalning, momsjustering, betalning och makulering på befintliga fakturor → 409 utan effekt', async () => {
      const o = await nyOrg()
      const id = async (r: { body: string }) =>
        (JSON.parse(r.body) as { data: { id: string } }).data.id
      const betald = await id(
        await http(o, 'POST', '/accounting/supplier-invoices', levfaktura, 'ACCOUNTANT'),
      )
      const p = await http(
        o,
        'POST',
        `/accounting/supplier-invoices/${betald}/pay`,
        { paidDate: '2026-03-20' },
        'ACCOUNTANT',
      )
      expect([200, 201]).toContain(p.statusCode)
      const makulerad = await id(
        await http(o, 'POST', '/accounting/supplier-invoices', levfaktura, 'ACCOUNTANT'),
      )
      const c = await http(
        o,
        'POST',
        `/accounting/supplier-invoices/${makulerad}/cancel`,
        {},
        'ACCOUNTANT',
      )
      expect([200, 201]).toContain(c.statusCode)
      const betalning = await prisma.journalEntry.findFirstOrThrow({
        where: {
          organizationId: o.id,
          source: 'SUPPLIER_INVOICE',
          sourceId: { startsWith: 'supplier-invoice-payment:' },
        },
      })
      await fortnoxVald(o)

      const fakturor = () =>
        prisma.supplierInvoice.findMany({
          where: { organizationId: o.id },
          orderBy: { id: 'asc' },
          select: { id: true, paidAt: true, cancelledAt: true, vatAmount: true },
        })
      const justeringar = () =>
        prisma.supplierInvoiceVatAdjustment.count({ where: { organizationId: o.id } })
      const fore = {
        rader: await rader(o.id),
        fakturor: await fakturor(),
        justeringar: await justeringar(),
      }

      for (const [url, body] of [
        [
          `/accounting/supplier-invoices/${betald}/payments/${betalning.id}/undo`,
          { reason: 'F4c ångring ska nekas' },
        ],
        [
          `/accounting/supplier-invoices/${betald}/vat-adjustments`,
          {
            till: 'HELT_AVDRAG',
            date: '2026-03-25',
            reason: 'F4c justering ska nekas',
            clientKey: `f4c-${randomUUID()}`,
          },
        ],
        [`/accounting/supplier-invoices/${betald}/pay`, { paidDate: '2026-03-26' }],
        [`/accounting/supplier-invoices/${makulerad}/cancel`, {}],
        [`/accounting/supplier-invoices/${makulerad}/pay`, { paidDate: '2026-03-26' }],
      ] as const) {
        const r = await http(o, 'POST', url, body, 'ACCOUNTANT')
        // Kundeffekten först: fakturans fält, justeringar, verifikat och nummer.
        expect({
          url,
          rader: await rader(o.id),
          fakturor: await fakturor(),
          justeringar: await justeringar(),
        }).toEqual({ url, ...fore })
        nekadHttp(r)
      }
      expect(fore.fakturor.find((f) => f.id === betald)!.paidAt).not.toBeNull()
      expect(fore.fakturor.find((f) => f.id === makulerad)!.cancelledAt).not.toBeNull()
    })

    // F-161-2: AI:s ångra av ett fritt verifikat. Den deklarerade ångra-vägen för
    // create_journal_entry/record_expense (effect-idempotency, supportsUndo) är
    // AccountingService.reverseJournalEntry; den nås också via HTTP-rättelsen i gränssnittet.
    it('F4d: ångra av ett AI-skapat verifikat via den deklarerade vägen nekas utan ny rättelse', async () => {
      const o = await nyOrg()
      const principal = { kind: 'USER' as const, id: o.anv.OWNER }
      const skapat = await executor.executeTool(
        'create_journal_entry',
        verifikat('AI före valet'),
        o.id,
        principal,
        'OWNER',
        { actionProof: { claimed: true } } as never,
      )
      expect(skapat.success).toBe(true)
      const ai = await prisma.journalEntry.findFirstOrThrow({
        where: { organizationId: o.id, description: 'AI före valet' },
      })
      await fortnoxVald(o)

      for (const verktyg of ['create_journal_entry', 'record_expense']) {
        const undo = EFFECT_DECLARATIONS[verktyg]!.supportsUndo
        expect(undo).toMatchObject({
          kind: 'VÄG',
          fil: 'accounting/accounting.service.ts',
          symbol: 'reverseJournalEntry',
        })
      }
      const symbol = (
        EFFECT_DECLARATIONS['create_journal_entry']!.supportsUndo as { symbol: string }
      ).symbol
      const fore = await rader(o.id)
      const utfall = await (
        accounting as unknown as Record<string, (p: unknown) => Promise<unknown>>
      )
        [symbol]!.call(accounting, {
          entryId: ai.id,
          organizationId: o.id,
          actorRole: 'ACCOUNTANT',
          actorUserId: o.anv.ACCOUNTANT,
          reason: 'F4d ångra AI-verifikat ska nekas',
        })
        .then(
          () => 'lyckades',
          (e: unknown) => e,
        )
      expect(await rader(o.id)).toEqual(fore)
      expect(
        await prisma.journalEntry.count({
          where: { organizationId: o.id, reversalOfEntryId: ai.id },
        }),
      ).toBe(0)
      expect(utfall).toBeInstanceOf(ConflictException)
      expect((utfall as ConflictException).getResponse()).toMatchObject({ code: EXTERN_HUVUDBOK })

      // Samma ångra via gränssnittets HTTP-rättelse: nekad, inget falskt lyckat svar.
      const r = await http(
        o,
        'POST',
        `/accounting/journal/${ai.id}/reverse`,
        { reason: 'F4d ångra via HTTP ska nekas' },
        'ACCOUNTANT',
      )
      expect(await rader(o.id)).toEqual(fore)
      nekadHttp(r)
      expect(JSON.parse(r.body).success).toBe(false)
    })

    it('delegerad väg: verktygen är fortfarande EJ_ALLOWLISTAD (ingen ny rättighet)', () => {
      for (const t of ['create_journal_entry', 'record_expense', 'close_period']) {
        const d = prövaDelegerbarhet(t)
        expect(d).toMatchObject({ delegerbar: false, skäl: 'EJ_ALLOWLISTAD' })
      }
    })
  })

  // ── F5 ──────────────────────────────────────────────────────────────────────
  describe('F5: domänflöden fungerar under FORTNOX', () => {
    it('avi, betalning, depositionsavi och källbunden rättelse bokförs', async () => {
      const o = await nyOrg()
      await fortnoxVald(o)
      const prop = await prisma.property.create({
        data: {
          organizationId: o.id,
          name: 'P',
          propertyDesignation: 'X 1:154',
          type: 'RESIDENTIAL',
          street: 'a',
          city: 'b',
          postalCode: '11111',
          totalArea: 100,
        },
      })
      const unit = await prisma.unit.create({
        data: {
          propertyId: prop.id,
          name: 'U',
          unitNumber: '1',
          type: 'APARTMENT',
          area: 50,
          monthlyRent: 8000,
        },
      })
      const tenant = await prisma.tenant.create({
        data: {
          organizationId: o.id,
          type: 'INDIVIDUAL',
          firstName: 'Hyres',
          lastName: 'Gäst',
          email: `hb154-t-${randomUUID().slice(0, 8)}@example.invalid`,
        },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: o.id,
          unitId: unit.id,
          tenantId: tenant.id,
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00Z'),
          tenancyStartDate: new Date('2026-01-01T00:00:00Z'),
          activatedAt: new Date('2026-01-01T00:00:00Z'),
          monthlyRent: 8000,
          depositAmount: 8000,
        },
      })
      const noticeId = randomUUID()
      const avi = await accounting.createJournalEntryForRentNotice(
        {
          id: noticeId,
          noticeNumber: 'A-154',
          leaseId: lease.id,
          type: 'RENT',
          amount: 8000,
          vatAmount: 0,
          totalAmount: 8000,
          year: 2026,
          month: 3,
        },
        o.id,
        null,
      )
      expect(avi).not.toBeNull()
      const betalning = await accounting.createJournalEntryForRentNoticePayment(
        { id: noticeId, noticeNumber: 'A-154', type: 'RENT' },
        { id: randomUUID(), date: new Date('2026-03-05T00:00:00Z'), amount: 8000 as never },
        o.id,
        null,
        undefined,
        randomUUID(),
      )
      expect(betalning).not.toBeNull()
      const dep = await accounting.createJournalEntryForDepositInvoice(
        randomUUID(),
        o.id,
        8000,
        'D-154',
        new Date('2026-03-01T00:00:00Z'),
        null,
      )
      expect(dep).not.toBeNull()
      // Källbunden rättelse: avin krediteras genom sin domänväg (inte reverseJournalEntry).
      await accounting.reverseJournalEntryForRentNotice(noticeId, o.id, null)
      const rattelse = await prisma.journalEntry.count({
        where: { organizationId: o.id, reversalOfEntryId: (avi as { id: string }).id },
      })
      expect(rattelse).toBe(1)
    })
  })

  // ── F6 / F6b ─────────────────────────────────────────────────────────────────
  describe('F6: anslutning och aktivering ändrar inte valet', () => {
    it('AUTH_LOST, DISCONNECTED, REVOKED, SUPERSEDED och ny generation: FORTNOX kvar, spärrarna gäller', async () => {
      const o = await nyOrg()
      const f = await fortnoxVald(o)
      for (const status of ['AUTH_LOST', 'DISCONNECTED', 'ACTIVE'] as const) {
        await prisma.fortnoxConnection.update({
          where: { id: f.conn.id },
          data: { status, generation: { increment: 1 } },
        })
        nekadHttp(
          await http(
            o,
            'POST',
            '/accounting/journal-entries',
            verifikat(`F6 ${status}`),
            'ACCOUNTANT',
          ),
        )
      }
      for (const status of ['REVOKED', 'SUPERSEDED'] as const) {
        await prisma.fortnoxCustomerActivation.update({ where: { id: f.a.id }, data: { status } })
        nekadHttp(await http(o, 'POST', '/accounting/expenses', utgift, 'ACCOUNTANT'))
      }
      const rad = await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })
      expect(rad).toMatchObject({
        ledgerOwner: 'FORTNOX',
        ledgerOwnerActivationId: f.a.id,
        ledgerOwnerFortnoxDatabaseNumber: f.databasnummer,
      })
      // En ny aktivering kan inte göra ett nytt val (inget byte).
      await prisma.fortnoxCustomerActivation.update({
        where: { id: f.a.id },
        data: { status: 'ACTIVE' },
      })
      expect((await valj(o, f.a.id)).statusCode).toBe(409)
    })

    it('F6b: annat databasnummer eller orgnr efter valet → sändningens prövning och godkännandet nekas', async () => {
      const o = await nyOrg()
      const f = await fortnoxVald(o)
      // Utgångsläge: allt stämmer.
      expect((await provaAktivering(prisma, o.id, null)).ok).toBe(true)

      // Annat databasnummer: anslutning OCH aktivering pekar dit (kringgår connectionens egen spärr).
      await prisma.fortnoxConnection.update({
        where: { id: f.conn.id },
        data: { fortnoxDatabaseNumber: f.databasnummer + 1 },
      })
      await prisma.fortnoxCustomerActivation.update({
        where: { id: f.a.id },
        data: { fortnoxDatabaseNumber: f.databasnummer + 1 },
      })
      const db = await provaAktivering(prisma, o.id, null)
      expect(db.ok).toBe(false)
      expect((db as { skal: string }).skal).toMatch(/valdes som huvudbok/)
      const status = await aktivering.status(o.id, null)
      expect(status.forslag.hinder.join(' ')).toMatch(/valdes som huvudbok/)

      // Tillbaka till rätt databas men annat orgnr.
      const annatOrgnr = `55${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
      await prisma.organization.update({ where: { id: o.id }, data: { orgNumber: annatOrgnr } })
      await prisma.fortnoxConnection.update({
        where: { id: f.conn.id },
        data: { fortnoxDatabaseNumber: f.databasnummer, fortnoxOrgNumber: annatOrgnr },
      })
      await prisma.fortnoxCustomerActivation.update({
        where: { id: f.a.id },
        data: { fortnoxDatabaseNumber: f.databasnummer, fortnoxOrgNumber: annatOrgnr },
      })
      const orgnr = await provaAktivering(prisma, o.id, null)
      expect(orgnr.ok).toBe(false)
      expect((orgnr as { skal: string }).skal).toMatch(
        /organisationsnummer är ett annat än det som valdes/,
      )
      // send()-vägens prövning ogiltigförklarar beständigt — inget kan skickas.
      const send = await prisma.$transaction((tx) =>
        provaOchOgiltigforklara(tx, o.id, {
          financialYearId: 2026,
          voucherSeries: 'E',
          transactionDate: '2026-03-01',
          accountingMethod: 'ACCRUAL',
        }),
      )
      expect(send.ok).toBe(false)
      expect(
        (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: f.a.id } }))
          .status,
      ).toBe('SUPERSEDED')
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: o.id } }))
          .ledgerOwnerFortnoxOrgNumber,
      ).toBe(o.orgnr)
    })
  })

  // ── F7 ──────────────────────────────────────────────────────────────────────
  describe('F7: samma lås i val och skrivning — deterministisk barriär', () => {
    const vantarPaLas = async (monster: string) => {
      for (let i = 0; i < 200; i += 1) {
        const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${monster}`
        if (Number(r[0]!.n) > 0) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`väntade aldrig på lås: ${monster}`)
    }
    const barriar = () => {
      let släpp!: () => void
      const p = new Promise<void>((r) => (släpp = r))
      return { p, släpp }
    }

    it('(a) skrivningen först: valet väntar, skrivningen committar, valet lyckas därefter', async () => {
      const o = await nyOrg()
      const f = await aktiv(o)
      const b = barriar()
      let iSkrivning!: () => void
      const inne = new Promise<void>((r) => (iSkrivning = r))
      const skriv = accounting.createManualJournalEntry({
        organizationId: o.id,
        date: new Date('2026-03-15T00:00:00Z'),
        description: 'F7a skrivning först',
        lines: [
          { accountNumber: 6110, debit: 10 },
          { accountNumber: 1930, credit: 10 },
        ],
        idempotencyKey: `f7a:${randomUUID()}`,
        createdById: o.anv.ACCOUNTANT,
        efterSkrivning: async () => {
          iSkrivning()
          await b.p
        },
      } as never)
      let val: Promise<unknown> | null = null
      try {
        await inne
        val = aktivering.valjFortnoxSomHuvudbok(
          o.id,
          { sub: o.anv.OWNER, role: 'OWNER' },
          { activationId: f.a.id },
        )
        await vantarPaLas('%FOR UPDATE%')
      } finally {
        // Släpp ALLTID barriären, även när en kontroll ovan kastat — annars hålls låset och
        // sviten hänger (FEEDBACK-159).
        b.släpp()
      }
      await expect(skriv).resolves.toMatchObject({ description: 'F7a skrivning först' })
      await expect(val).resolves.toMatchObject({ agare: 'FORTNOX' })
    })

    it('(b) valets lås först: skrivningen väntar och nekas därefter utan sidoeffekt', async () => {
      const o = await nyOrg()
      const f = await aktiv(o)
      const fore = await rader(o.id)
      const b = barriar()
      let haller!: () => void
      const låst = new Promise<void>((r) => (haller = r))
      // Samma kritiska sektion som valjFortnoxSomHuvudbok: FOR UPDATE på organisationen och
      // därefter skrivning av valet — hållen öppen av barriären.
      const val = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${o.id} FOR UPDATE`
          await tx.organization.update({
            where: { id: o.id },
            data: {
              ledgerOwner: 'FORTNOX',
              ledgerOwnerActivationId: f.a.id,
              ledgerOwnerFortnoxDatabaseNumber: f.databasnummer,
              ledgerOwnerFortnoxOrgNumber: o.orgnr,
              ledgerOwnerSetAt: new Date(),
              ledgerOwnerSetById: o.anv.OWNER,
            },
          })
          haller()
          await b.p
        },
        { timeout: 30_000 },
      )
      let skriv: Promise<unknown> = Promise.resolve('ej startad')
      try {
        await låst
        skriv = accounting
          .createManualJournalEntry({
            organizationId: o.id,
            date: new Date('2026-03-16T00:00:00Z'),
            description: 'F7b skrivning efter valet',
            lines: [
              { accountNumber: 6110, debit: 10 },
              { accountNumber: 1930, credit: 10 },
            ],
            idempotencyKey: `f7b:${randomUUID()}`,
            createdById: o.anv.ACCOUNTANT,
          } as never)
          .then(
            () => 'lyckades',
            (e: unknown) => e,
          )
        await vantarPaLas('%FOR SHARE%')
      } finally {
        b.släpp()
        await val
      }
      const utfall = await skriv
      // Kundeffekten först, sedan undantaget.
      expect(await rader(o.id)).toEqual(fore)
      expect(utfall).toBeInstanceOf(ConflictException)
      expect((utfall as ConflictException).getResponse()).toMatchObject({ code: EXTERN_HUVUDBOK })
    })

    it('(c) två samtidiga fria skrivningar under EVENO lyckas båda (FOR SHARE blockerar inte)', async () => {
      const o = await nyOrg()
      const b = barriar()
      let forsta!: () => void
      const inne = new Promise<void>((r) => (forsta = r))
      const en = accounting.createManualJournalEntry({
        organizationId: o.id,
        date: new Date('2026-03-17T00:00:00Z'),
        description: 'F7c ett',
        lines: [
          { accountNumber: 6110, debit: 1 },
          { accountNumber: 1930, credit: 1 },
        ],
        idempotencyKey: `f7c1:${randomUUID()}`,
        createdById: o.anv.ACCOUNTANT,
        efterSkrivning: async () => {
          forsta()
          await b.p
        },
      } as never)
      let tva: ReturnType<typeof accounting.createManualJournalEntry> | null = null
      try {
        await inne
        tva = accounting.createManualJournalEntry({
          organizationId: o.id,
          date: new Date('2026-03-17T00:00:00Z'),
          description: 'F7c två',
          lines: [
            { accountNumber: 6110, debit: 2 },
            { accountNumber: 1930, credit: 2 },
          ],
          idempotencyKey: `f7c2:${randomUUID()}`,
          createdById: o.anv.ACCOUNTANT,
        } as never)
        await new Promise((r) => setTimeout(r, 300))
      } finally {
        b.släpp()
      }
      const [a, c] = await Promise.all([en, tva!])
      expect(a.verNumber).not.toBe(c.verNumber)
    })
  })
})
