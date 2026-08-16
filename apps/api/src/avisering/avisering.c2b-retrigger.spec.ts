/**
 * T5 C2b (#58) — manuell retrigger av aktiveringens avier.
 *
 * Aktiveringen köar `create-initial-notices`. Fallerar KÖANDET (Redis nere)
 * blir avierna aldrig av och hyresgästen faktureras aldrig — C2a larmar, men
 * det fanns ingen åtgärd: motorn hade exakt en anropare (workern). Den här
 * svitens fokus är att den nya åtgärden inte kan kosta pengar två gånger.
 *
 * 🔴 HUVUDBEVISET (B): retrigger på ett FÖRNYAT avtal får ALDRIG skapa en andra
 * depositionsavi eller en andra Deposit. Ett successor-lease har nytt leaseId
 * (så motorns P2002-idempotens biter inte), ärvd depositAmount och en deposition
 * som re-pekats hit (T1.3) — en blind `skipDeposit:false` hade alltså krävt
 * hyresgästen på deposition en gång till och bokfört 1510/2890 igen.
 *
 * Testerna kör MOTORN PÅ RIKTIGT (createInitialNoticesForLease), inte en mock —
 * Fas A-läxan: en mockad motor hade svarat "ja visst" på precis det scenario vi
 * försöker utesluta. Prisma-attrappen upprätthåller den verkliga unika nyckeln
 * @@unique(leaseId, year, month, type) och kastar P2002 som Prisma gör.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }))

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import * as Sentry from '@sentry/nestjs'
import { AviseringService } from './avisering.service'

let __seq = 0

const captureException = Sentry.captureException as jest.MockedFunction<
  typeof Sentry.captureException
>

interface LeaseSeed {
  id: string
  status?: string
  /** Sätts < startDate för att göra leaset till en successor (T1.3b-markören). */
  tenancyStartDate?: string
  depositAmount?: number
  organizationId?: string
}

interface NoticeRow {
  id: string
  organizationId: string
  leaseId: string
  tenantId: string
  noticeNumber: string
  year: number
  month: number
  type: 'RENT' | 'DEPOSIT'
  totalAmount: number
  sentAt: Date | null
  status: string
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.19.0',
    meta: { target: ['leaseId', 'year', 'month', 'type'] },
  })
}

function makeRig(seed: LeaseSeed, opts: { withDeposit?: boolean; enqueueFails?: boolean } = {}) {
  const startDate = new Date('2026-06-15T00:00:00Z')
  const lease = {
    id: seed.id,
    organizationId: seed.organizationId ?? 'org-1',
    tenantId: 'tenant-1',
    status: seed.status ?? 'ACTIVE',
    monthlyRent: 12000,
    monthlyRentExcludingVat: false,
    depositAmount: seed.depositAmount ?? 24000,
    startDate,
    tenancyStartDate: seed.tenancyStartDate ? new Date(seed.tenancyStartDate) : startDate,
    endDate: null,
    unit: {
      type: 'APARTMENT',
      voluntaryTaxLiability: false,
      name: 'Lgh 1',
      property: { name: 'Fastigheten' },
    },
    tenant: {
      id: 'tenant-1',
      email: 'hyresgast@test.se',
      type: 'INDIVIDUAL',
      firstName: 'A',
      lastName: 'B',
    },
  }

  // In-memory-lager som upprätthåller den VERKLIGA unika nyckeln.
  const notices: NoticeRow[] = []
  const deposits: Array<{ id: string; leaseId: string }> = opts.withDeposit
    ? [{ id: 'dep-1', leaseId: lease.id }]
    : []
  let seq = 0

  const createNotice = ({ data }: { data: Record<string, unknown> }) => {
    const key = (n: { leaseId: string; year: number; month: number; type: string }) =>
      `${n.leaseId}|${n.year}|${n.month}|${n.type}`
    const row = {
      id: `rn-${++seq}`,
      sentAt: null,
      ...data,
    } as unknown as NoticeRow
    if (notices.some((n) => key(n) === key(row))) return Promise.reject(p2002())
    notices.push(row)
    return Promise.resolve({
      ...row,
      lease: { unit: lease.unit },
      tenant: lease.tenant,
    })
  }

  const prisma = {
    lease: {
      findFirst: jest.fn(({ where }: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(
          where.id === lease.id && where.organizationId === lease.organizationId ? lease : null,
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === lease.id ? lease : null),
      ),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ daysBeforeMoveInForFirstPayment: 7 }),
    },
    deposit: {
      findFirst: jest.fn(({ where }: { where: { leaseId: string } }) =>
        Promise.resolve(deposits.find((d) => d.leaseId === where.leaseId) ?? null),
      ),
    },
    // M3: avinumret allokeras ur RentNoticeNumberSequence. Räknaren gör att
    // riggen ger löpande nummer i stället för samma varje gång.
    rentNoticeNumberSequence: {
      upsert: jest.fn().mockImplementation(() => Promise.resolve({ lastNumber: ++__seq })),
    },
    rentNotice: {
      create: jest.fn(createNotice),
      findMany: jest.fn(() =>
        Promise.resolve(notices.map((n) => ({ noticeNumber: n.noticeNumber }))),
      ),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          notices.find(
            (n) =>
              (where.id === undefined || n.id === where.id) &&
              (where.leaseId === undefined || n.leaseId === where.leaseId) &&
              (where.organizationId === undefined || n.organizationId === where.organizationId) &&
              (where.type === undefined || n.type === where.type) &&
              (where.year === undefined || n.year === where.year) &&
              (where.month === undefined || n.month === where.month),
          ) ?? null,
        ),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
  }

  const deposit = { ensureDepositForNotice: jest.fn().mockResolvedValue({ id: 'dep-new' }) }
  const accounting = {
    createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }),
  }
  const pdfQueue = {
    enqueue: opts.enqueueFails
      ? jest.fn().mockRejectedValue(new Error('MaxRetriesPerRequestError'))
      : jest.fn().mockResolvedValue('job-1'),
  }
  const noop = {}

  const service = new AviseringService(
    prisma as never,
    { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') } as never,
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    pdfQueue as never,
    accounting as never,
    { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
    { attachMiscChargesToRentNotice: jest.fn().mockResolvedValue(0) } as never,
    deposit as never,
    {} as never, // rentNoticeEvents
  )

  return { service, prisma, notices, deposit, accounting, pdfQueue, lease }
}

const ADMIN = { actorRole: UserRole.ADMIN }

describe('T5 C2b · retrigger av aktiveringens avier (#58)', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('A · ACTIVE utan avier — den avsedda åtgärden', () => {
    it('skapar deposition + första hyresavi, och bokför verifikatet i SAMMA tx', async () => {
      const { service, notices, deposit, accounting, prisma } = makeRig({ id: 'lease-1' })

      const res = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)

      expect(res.deposit).not.toBeNull()
      expect(res.firstRent).not.toBeNull()
      expect(res.skippedDeposit).toBe(false)
      expect(notices.map((n) => n.type).sort()).toEqual(['DEPOSIT', 'RENT'])

      // Depositionen bokförs via deposits-modulen (1510/2890).
      expect(deposit.ensureDepositForNotice).toHaveBeenCalledTimes(1)
      // Hyresavins intäktsverifikat körs INUTI avins transaktion (A1).
      const txArg = accounting.createJournalEntryForRentNotice.mock.calls[0]![3]
      expect(txArg).toBe(prisma)
    })
  })

  describe('B · 🔴 SUCCESSION — skyddet mot dubbeldebiterad deposition', () => {
    // Ett förnyat avtal: tenancyStartDate ärvd från föregångaren (< startDate)
    // och depositionen re-pekad hit (T1.3). Motorns P2002 biter INTE — nyckeln
    // (leaseId, year, month, DEPOSIT) är ny eftersom leaseId är nytt.
    it('skapar INGEN andra depositionsavi och INGEN andra Deposit', async () => {
      const { service, notices, deposit } = makeRig(
        { id: 'lease-successor', tenancyStartDate: '2024-01-01T00:00:00Z' },
        { withDeposit: true },
      )

      const res = await service.retriggerInitialNotices('lease-successor', 'org-1', ADMIN)

      expect(res.skippedDeposit).toBe(true)
      expect(res.skipDepositReason).toBe('succession')
      expect(res.deposit).toBeNull()
      // Ingen DEPOSIT-rad skapades — bara gap-hyresavin.
      expect(notices.map((n) => n.type)).toEqual(['RENT'])
      // Och därmed ingen andra deposition bokförd (1510/2890).
      expect(deposit.ensureDepositForNotice).not.toHaveBeenCalled()
    })

    it('spärrar även när markören saknas men en Deposit redan finns', async () => {
      // Robusthet mot data där kontinuitetsmarkören inte skiljer sig (t.ex.
      // migrerad historik): depositionens existens räcker som spärr.
      const { service, notices, deposit } = makeRig({ id: 'lease-1' }, { withDeposit: true })

      const res = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)

      expect(res.skippedDeposit).toBe(true)
      expect(res.skipDepositReason).toBe('deposit-finns')
      expect(notices.map((n) => n.type)).toEqual(['RENT'])
      expect(deposit.ensureDepositForNotice).not.toHaveBeenCalled()
    })

    it('spärrar när en depositionsavi finns sedan tidigare (utan Deposit-rad)', async () => {
      const { service, notices, deposit } = makeRig({ id: 'lease-1' })
      // Simulera en depositionsavi från ett tidigare, halvfärdigt försök.
      notices.push({
        id: 'rn-old',
        organizationId: 'org-1',
        leaseId: 'lease-1',
        tenantId: 'tenant-1',
        noticeNumber: 'AVI-2026-06-0001',
        year: 2026,
        month: 6,
        type: 'DEPOSIT',
        totalAmount: 24000,
        sentAt: null,
        status: 'PENDING',
      })

      const res = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)

      expect(res.skipDepositReason).toBe('depositionsavi-finns')
      expect(notices.filter((n) => n.type === 'DEPOSIT')).toHaveLength(1)
      expect(deposit.ensureDepositForNotice).not.toHaveBeenCalled()
    })

    it('KONTRAFAKTISKT: utan spärren skapar motorn faktiskt en andra depositionsavi', async () => {
      // Visar att spärren är BÄRANDE, inte dekorativ. Samma successor-scenario,
      // men motorn anropas direkt med skipDeposit:false — precis vad en blind
      // retrigger hade gjort. P2002 räddar oss INTE: nyckeln (leaseId, year,
      // month, DEPOSIT) är ny eftersom successorn har nytt leaseId.
      const { service, notices, deposit } = makeRig(
        { id: 'lease-successor', tenancyStartDate: '2024-01-01T00:00:00Z' },
        { withDeposit: true },
      )

      await service.createInitialNoticesForLease('lease-successor', { skipDeposit: false })

      expect(notices.filter((n) => n.type === 'DEPOSIT')).toHaveLength(1) // ← dubbeldebiteringen
      expect(deposit.ensureDepositForNotice).toHaveBeenCalledTimes(1) // ← andra 1510/2890
    })

    it('klienten kan INTE styra flaggan — den härleds ur leasets tillstånd', async () => {
      // Endpointen tar inget skipDeposit-argument alls. Det här testet låser
      // signaturen: den dagen någon lägger till en klient-styrd flagga faller
      // det, och dubbeldebiteringsrisken blir synlig i review.
      const { service } = makeRig({ id: 'lease-1' }, { withDeposit: true })
      expect(service.retriggerInitialNotices).toHaveLength(2) // (leaseId, orgId) + opts default
    })
  })

  describe('C · idempotens — andra klicket', () => {
    it('andra körningen skapar inget nytt — och depositionen spärras nu av sin egen avi', async () => {
      const { service, notices, deposit } = makeRig({ id: 'lease-1' })

      const first = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)
      expect(notices).toHaveLength(2)
      deposit.ensureDepositForNotice.mockClear()

      const second = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)

      expect(notices).toHaveLength(2) // inga dubbletter
      // Andra klicket ser depositionsavin från första klicket och spärrar på
      // den — dubbelt skydd: hade spärren inte funnits hade motorns P2002
      // fångat det, men då hade vi redan hunnit be deposits-modulen bokföra.
      expect(second.skipDepositReason).toBe('depositionsavi-finns')
      expect(second.deposit).toBeNull()
      expect(deposit.ensureDepositForNotice).not.toHaveBeenCalled()
      // Hyresavin är densamma som första gången (P2002 → hämtar befintlig).
      expect(second.firstRent?.id).toBe(first.firstRent?.id)
    })

    it('en redan skickad avi mejlas inte igen (sentAt-checken i workern)', async () => {
      const { service, prisma, notices } = makeRig({ id: 'lease-1' })
      notices.push({
        id: 'rn-sent',
        organizationId: 'org-1',
        leaseId: 'lease-1',
        tenantId: 'tenant-1',
        noticeNumber: 'AVI-2026-06-0009',
        year: 2026,
        month: 6,
        type: 'RENT',
        totalAmount: 12000,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        status: 'SENT',
      })
      prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Org' })

      // Riktiga send-vägen: hoppar över tyst när avin redan är skickad.
      await service.processNoticeSendJob('org-1', 'rn-sent')

      expect(prisma.rentNotice.update).not.toHaveBeenCalled()
    })
  })

  describe('D · grindar — fail-closed', () => {
    it.each([UserRole.VIEWER, UserRole.ACCOUNTANT])(
      '%s nekas server-side och inget skapas',
      async (role) => {
        const { service, notices, prisma } = makeRig({ id: 'lease-1' })

        await expect(
          service.retriggerInitialNotices('lease-1', 'org-1', { actorRole: role }),
        ).rejects.toBeInstanceOf(ForbiddenException)

        expect(notices).toHaveLength(0)
        expect(prisma.lease.findFirst).not.toHaveBeenCalled() // nekas före all läsning
      },
    )

    it('saknad roll nekas (fail-closed, inte fail-open)', async () => {
      const { service } = makeRig({ id: 'lease-1' })
      await expect(service.retriggerInitialNotices('lease-1', 'org-1', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('DRAFT-kontrakt avvisas — avierna hör till aktiveringen', async () => {
      const { service, notices } = makeRig({ id: 'lease-1', status: 'DRAFT' })

      await expect(
        service.retriggerInitialNotices('lease-1', 'org-1', ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(notices).toHaveLength(0)
    })

    it('annan orgs kontrakt → 404, ingen läcka om att det finns', async () => {
      const { service } = makeRig({ id: 'lease-1' })

      await expect(
        service.retriggerInitialNotices('lease-1', 'annan-org', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe('E · sendNotices-läckan (samma klass som #58)', () => {
    it('kö-fel vid utskick LARMAR i stället för att sväljas tyst', async () => {
      const { service } = makeRig({ id: 'lease-1' }, { enqueueFails: true })

      const res = await service.retriggerInitialNotices('lease-1', 'org-1', ADMIN)

      // Avierna finns kvar (skapade + bokförda) — bara utskicket brast.
      expect(res.deposit).not.toBeNull()
      expect(res.firstRent).not.toBeNull()
      expect(res.mailed).toBe(false)
      // Före C2b: tyst logger.warn. Nu: ett larm per avi som inte kunde köas.
      expect(captureException).toHaveBeenCalled()
      const [, ctx] = captureException.mock.calls[0] as [Error, { tags: Record<string, string> }]
      expect(ctx.tags).toMatchObject({ queue: 'pdf', jobType: 'avisering-send', org: 'org-1' })
    })

    it('sendNotices rapporterar hur många som inte kunde köas', async () => {
      const { service } = makeRig({ id: 'lease-1' }, { enqueueFails: true })

      const res = await service.sendNotices('org-1', ['n-1', 'n-2'])

      expect(res).toEqual({ queued: 0, failed: 2, jobIds: [] })
    })
  })
})
