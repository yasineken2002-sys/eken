/**
 * T2 — FAKTURANS FÖRFALLODAG (F7) OCH BETALNINGSMÅL (F8), MOT RIKTIG DATABAS.
 *
 * ── VAD SOM PRÖVAS ──────────────────────────────────────────────────────────
 *
 * F7  `dueDate` är ett civilt datum (`@db.Date`). Fakturan förfaller när den
 *     SVENSKA kalenderdagen passerat — oberoende av serverns tidszon och av
 *     UTC-dygnet. Prövas på sekunden vid svensk midnatt, sommar/vinter och runt
 *     båda omställningsdygnen, i cronens statusflipp, i kravtrappans dagräkning
 *     och i dokumentets/mejlets utskrivna datum.
 *
 * F8  En faktura som BEGÄR betalning skickas inte, och bokförs inte som skickad,
 *     utan giltigt betalningsmål. Prövas före kön, i workern efter att målet
 *     rensats, i den manuella statusövergången, i påminnelserna (före avgift och
 *     brev) — och att kreditnota, nollsaldo och en redan skickad faktura hålls
 *     isär från det.
 *
 * ── ISOLERING ───────────────────────────────────────────────────────────────
 *
 * Ingen Resend-klient, ingen `MailService`, ingen Redis, ingen Chromium. Mejl,
 * PDF och kö är LOKALA FÅNGARE i form av arrayer; det är konstruktionen som ger
 * isoleringen, inte en ogiltig nyckel.
 *
 * ── KLOCKAN ─────────────────────────────────────────────────────────────────
 *
 * `markOverdueInvoices` och `getOverdueStatus` läser `new Date()` själva. Bara
 * `Date` fejkas (`doNotFake` på allt annat), så Prisma och Postgres går i
 * verklig tid medan tjänsten ser den valda sekunden.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('./pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, type InvoiceStatus } from '@prisma/client'

import { InvoicesService } from './invoices.service'
import { InvoiceEventsService } from './invoice-events.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PaymentReminderService } from '../notifications/payment-reminder.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { generateInvoiceHtml } from './templates/invoice-pdf.template'
import { formatDate as mejlDatum } from '../mail/templates/shared/format'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/**
 * SERVERNS TIDSZON STYRS UTIFRÅN, inte i provet. Uppmätt: `process.env.TZ = …`
 * inne i en jest-test når inte processens ICU — jest ger testet en KOPIA av
 * `process.env` — och ett prov som "byter zon" inuti mäter därför UTC och är
 * grönt av fel skäl. Hela filen körs i stället en gång per zon:
 *
 *   TZ=America/Los_Angeles T2_KRAV_TZ=America/Los_Angeles npx jest <filen>
 *   TZ=Asia/Tokyo          T2_KRAV_TZ=Asia/Tokyo          npx jest <filen>
 *
 * Kanariefågeln nedan kräver att den begärda zonen faktiskt GÄLLER.
 */
const KRAV_TZ = process.env.T2_KRAV_TZ

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
  it('KANARIEFÅGEL: den begärda server-TZ:n gäller i processen', () => {
    const zon = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (KRAV_TZ) expect(zon).toBe(KRAV_TZ)
    else expect(typeof zon).toBe('string')
  })
})

const GILTIGT = '5050-1055'
const OGILTIGT = '1234-5678'

/** Bara `Date` fejkas — timers, nextTick och I/O går i verklig tid. */
const RIKTIGA = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const
async function vid<T>(nu: Date, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({ now: nu, doNotFake: [...RIKTIGA] })
  try {
    return await fn()
  } finally {
    jest.useRealTimers()
  }
}

/**
 * Dygnsgränserna. Förfallodagen lagras som `@db.Date`; den sista sekunden är
 * 23:59:59 svensk tid SAMMA dag och den första efter är 00:00:00 nästa dag.
 */
const GRANSER: Array<{ namn: string; due: string; sista: string; forsta: string }> = [
  // Sommartid, UTC+2.
  {
    namn: 'sommar',
    due: '2026-07-01',
    sista: '2026-07-01T21:59:59Z',
    forsta: '2026-07-01T22:00:00Z',
  },
  // Vintertid, UTC+1.
  {
    namn: 'vinter',
    due: '2026-01-15',
    sista: '2026-01-15T22:59:59Z',
    forsta: '2026-01-15T23:00:00Z',
  },
  // Dagen före omställningen till sommartid (29 mars): midnatt är fortfarande CET.
  {
    namn: 'före vår-DST',
    due: '2026-03-28',
    sista: '2026-03-28T22:59:59Z',
    forsta: '2026-03-28T23:00:00Z',
  },
  // Omställningsdygnet (23 h): nästa midnatt är CEST.
  {
    namn: 'vår-DST-dygnet',
    due: '2026-03-29',
    sista: '2026-03-29T21:59:59Z',
    forsta: '2026-03-29T22:00:00Z',
  },
  // Omställningsdygnet till vintertid (25 h): nästa midnatt är CET.
  {
    namn: 'höst-DST-dygnet',
    due: '2026-10-25',
    sista: '2026-10-25T22:59:59Z',
    forsta: '2026-10-25T23:00:00Z',
  },
]

medDb('T2 · fakturans förfallodag och betalningsmål', () => {
  let prisma: PrismaClient
  let invoices: InvoicesService
  let notifications: NotificationsService
  let reminders: PaymentReminderService
  let orgId: string
  let tenantId: string
  let annanOrgId: string
  let annanTenantId: string

  /** LOKALA FÅNGARE. */
  const mejl: Array<{ kind: string; to: string; invoiceNumber: string; bankgiro?: unknown }> = []
  const koade: Array<{ organizationId: string; invoiceId: string; actorId: string }> = []
  const pdf: string[] = []

  const satMal = (bankgiro: string | null, org = orgId) =>
    prisma.organization.update({ where: { id: org }, data: { bankgiro } })

  let nr = 0
  async function faktura(opts: {
    status?: InvoiceStatus
    total?: number
    dueDate?: string
    isCreditNote?: boolean
    org?: string
    tenant?: string
  }): Promise<string> {
    // DB-spärren `Invoice_credit_note_requires_original_chk`: en kreditnota
    // måste peka på en faktura. Originalet skapas här, orört av provet.
    const original = opts.isCreditNote
      ? await faktura({
          status: 'SENT',
          ...(opts.org ? { org: opts.org } : {}),
          ...(opts.tenant ? { tenant: opts.tenant } : {}),
        })
      : null
    nr++
    const total = new Prisma.Decimal(opts.total ?? 1000)
    const rad = await prisma.invoice.create({
      data: {
        organizationId: opts.org ?? orgId,
        tenantId: opts.tenant ?? tenantId,
        invoiceNumber: `T2-${randomUUID().slice(0, 8)}-${nr}`,
        type: 'OTHER',
        status: opts.status ?? 'DRAFT',
        subtotal: total,
        vatTotal: new Prisma.Decimal(0),
        total,
        dueDate: new Date(`${opts.dueDate ?? '2040-01-31'}T00:00:00Z`),
        issueDate: new Date('2026-01-01T00:00:00Z'),
        isCreditNote: opts.isCreditNote ?? false,
        ...(original ? { creditedInvoiceId: original } : {}),
        lines: {
          create: [{ description: 'Provrad', quantity: 1, unitPrice: total, vatRate: 0, total }],
        },
      },
      select: { id: true },
    })
    return rad.id
  }

  const rad = (id: string) =>
    prisma.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sendError: true, total: true, updatedAt: true },
    })
  const handelser = (id: string) =>
    prisma.invoiceEvent
      .findMany({ where: { invoiceId: id }, select: { type: true }, orderBy: { createdAt: 'asc' } })
      .then((r) => r.map((e) => e.type))

  async function korKon() {
    while (koade.length > 0) {
      const j = koade.shift()!
      await invoices.processInvoiceSendJob(j.invoiceId, j.organizationId, j.actorId)
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const freshness = new PaymentFreshnessService(
      prisma as never,
      { send: async () => undefined } as never,
    )
    const tyst = { log: () => undefined, warn: () => undefined, error: () => undefined }

    invoices = Object.create(InvoicesService.prototype) as InvoicesService
    Object.assign(invoices, {
      prisma,
      eventsService: new InvoiceEventsService(prisma as never),
      pdfService: {
        generateInvoicePdf: async (id: string) => {
          pdf.push(id)
          return Buffer.from('%PDF-1.4 lokal provbuffert')
        },
      },
      mailService: {
        sendInvoice: async (a: { to: string; invoiceNumber: string }) => {
          mejl.push({ kind: 'invoice', to: a.to, invoiceNumber: a.invoiceNumber })
          return 'lokalt-mejljobb'
        },
      },
      accountingService: accounting,
      notificationsService: {},
      ocrService: {},
      pdfQueue: {
        enqueue: async (j: { organizationId: string; invoiceId: string; actorId: string }) => {
          koade.push({
            organizationId: j.organizationId,
            invoiceId: j.invoiceId,
            actorId: j.actorId,
          })
          return `jobb-${koade.length}`
        },
      },
      logger: tyst,
    })

    notifications = Object.create(NotificationsService.prototype) as NotificationsService
    Object.assign(notifications, {
      prisma,
      mail: {
        sendOverdueReminder: async (a: { to: string; invoiceNumber: string }) => {
          mejl.push({ kind: 'overdue-manual', to: a.to, invoiceNumber: a.invoiceNumber })
          return 'lokalt'
        },
      },
      cronErrors: { record: async () => undefined },
      logger: tyst,
    })

    reminders = Object.create(PaymentReminderService.prototype) as PaymentReminderService
    Object.assign(reminders, {
      prisma,
      mail: {
        sendReminderFriendly: async (a: {
          to: string
          invoiceNumber: string
          bankgiro: unknown
        }) => {
          mejl.push({
            kind: 'friendly',
            to: a.to,
            invoiceNumber: a.invoiceNumber,
            bankgiro: a.bankgiro,
          })
          return 'job-friendly'
        },
        sendReminderFormal: async (a: { to: string; invoiceNumber: string; bankgiro: unknown }) => {
          mejl.push({
            kind: 'formal',
            to: a.to,
            invoiceNumber: a.invoiceNumber,
            bankgiro: a.bankgiro,
          })
          return 'job-formal'
        },
      },
      notifications: { createForAllOrgUsers: async () => undefined, create: async () => undefined },
      accounting,
      cronErrors: { record: async () => undefined },
      freshness,
      logger: tyst,
    })

    const skapaOrg = async (tag: string) => {
      const sfx = randomUUID().slice(0, 8)
      const org = await prisma.organization.create({
        data: {
          name: `t2-${tag}-${sfx}`,
          email: `t2-${tag}-${sfx}@example.invalid`,
          street: 'Gatan 1',
          city: 'Stad',
          postalCode: '11111',
          bankgiro: GILTIGT,
          remindersEnabled: true,
        },
        select: { id: true },
      })
      const t = await prisma.tenant.create({
        data: {
          organizationId: org.id,
          type: 'INDIVIDUAL',
          email: `t2-t-${tag}-${sfx}@example.invalid`,
          firstName: 'Alva',
          lastName: 'Provperson',
          personalNumberHash: `hash-${tag}-${sfx}`,
        },
        select: { id: true },
      })
      return { org: org.id, tenant: t.id }
    }
    const a = await skapaOrg('a')
    orgId = a.org
    tenantId = a.tenant
    const b = await skapaOrg('b')
    annanOrgId = b.org
    annanTenantId = b.tenant
  }, 60_000)

  beforeEach(async () => {
    mejl.length = 0
    koade.length = 0
    pdf.length = 0
    await satMal(GILTIGT)
    await satMal(GILTIGT, annanOrgId)
  })

  afterAll(async () => {
    if (!prisma) return
    for (const o of [orgId, annanOrgId].filter(Boolean)) {
      await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoice.deleteMany({ where: { organizationId: o, isCreditNote: true } })
      await prisma.invoice.deleteMany({ where: { organizationId: o } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: o } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: o } })
      await prisma.account.deleteMany({ where: { organizationId: o } })
      await prisma.tenant.deleteMany({ where: { organizationId: o } })
      await prisma.organization.deleteMany({ where: { id: o } })
    }
    await prisma.$disconnect()
  })

  // ═══ F8 · FÖRE KÖN ════════════════════════════════════════════════════════

  it.each([
    ['null', null, /saknas/],
    ['blankt', '   ', /saknas/],
    ['ogiltigt', OGILTIGT, /kontrollsiffra/],
  ])(
    'F8.1 %s mål: sendInvoiceEmail avvisar före kön — inget jobb, inget skrivet',
    async (_n, bankgiro, text) => {
      await satMal(bankgiro)
      const id = await faktura({})
      const fore = await rad(id)
      await expect(invoices.sendInvoiceEmail(id, orgId, 'aktor')).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(text),
      })
      await expect(invoices.sendInvoiceEmail(id, orgId, 'aktor')).rejects.toThrow(
        /Inställningar → Betalningsinformation/,
      )
      expect(koade).toHaveLength(0)
      expect(await rad(id)).toEqual(fore)
      expect(await handelser(id)).toEqual([])
    },
  )

  it('F8.1 POSITIV: giltigt mål → köas, workern skickar, DRAFT → SENT', async () => {
    const id = await faktura({})
    await invoices.sendInvoiceEmail(id, orgId, 'aktor')
    expect(koade).toHaveLength(1)
    await korKon()
    expect(mejl.filter((m) => m.kind === 'invoice')).toHaveLength(1)
    expect((await rad(id)).status).toBe('SENT')
    expect(await handelser(id)).toContain('SENT')
  })

  // ═══ F8 · I WORKERN, NÄR INSTÄLLNINGEN ÄNDRATS ════════════════════════════

  it('F8.2 målet rensat EFTER köandet: workern skickar inte, DRAFT kvar, sant SEND_FAILED', async () => {
    const id = await faktura({})
    await invoices.sendInvoiceEmail(id, orgId, 'aktor')
    expect(koade).toHaveLength(1)
    await satMal(null)
    await korKon()
    expect(pdf).toHaveLength(0)
    expect(mejl).toHaveLength(0)
    const r = await rad(id)
    expect(r.status).toBe('DRAFT')
    expect(r.sendError).toMatch(/[Bb]ankgiro saknas/)
    const h = await handelser(id)
    expect(h).toContain('SEND_FAILED')
    expect(h).not.toContain('SENT')
  })

  // ═══ F8 · HISTORISKT SKICKAD FAKTURA ═════════════════════════════════════

  it('F8.3 redan skickad faktura: blockerad omsändning nedgraderar inte och hittar inte på historik', async () => {
    const id = await faktura({})
    await invoices.sendInvoiceEmail(id, orgId, 'aktor')
    await korKon()
    expect((await rad(id)).status).toBe('SENT')
    const historikFore = await handelser(id)
    mejl.length = 0

    await satMal(null)
    // Före kön: avvisad, INGENTING skrivs.
    await expect(invoices.sendInvoiceEmail(id, orgId, 'aktor')).rejects.toMatchObject({
      status: 400,
    })
    expect(koade).toHaveLength(0)
    const efterApi = await rad(id)
    expect(efterApi.status).toBe('SENT')
    expect(efterApi.sendError).toBeNull()
    expect(await handelser(id)).toEqual(historikFore)

    // Ett jobb som redan låg i kön: status orörd, inget nytt SENT, inget mejl.
    koade.push({ organizationId: orgId, invoiceId: id, actorId: 'aktor' })
    await korKon()
    expect(mejl).toHaveLength(0)
    const efterWorker = await rad(id)
    expect(efterWorker.status).toBe('SENT')
    const h = await handelser(id)
    expect(h.filter((t) => t === 'SENT')).toHaveLength(
      historikFore.filter((t) => t === 'SENT').length,
    )
    // Det enda som tillkommer är det SANNA försöket.
    expect(h.slice(historikFore.length)).toEqual(['SEND_FAILED'])
  })

  // ═══ F8 · DOKUMENT SOM INTE BEGÄR BETALNING ══════════════════════════════

  it('F8.4 nollsaldo (0 kr) begär ingen betalning: skickas trots saknat mål', async () => {
    await satMal(null)
    const id = await faktura({ total: 0 })
    await invoices.sendInvoiceEmail(id, orgId, 'aktor')
    await korKon()
    expect(mejl).toHaveLength(1)
    expect((await rad(id)).status).toBe('SENT')
  })

  it('F8.4 kreditnota begär ingen betalning: skickas trots saknat mål', async () => {
    await satMal(null)
    const id = await faktura({ isCreditNote: true, total: 500 })
    await invoices.sendInvoiceEmail(id, orgId, 'aktor')
    await korKon()
    expect(mejl).toHaveLength(1)
    expect((await rad(id)).status).toBe('SENT')
  })

  // ═══ F8 · MANUELL "SKICKA FAKTURA" (DRAFT → SENT UTAN MEJL) ═══════════════

  it('F8.5 PATCH-vägen DRAFT→SENT utan mål: 400, status DRAFT, ingen händelse', async () => {
    await satMal(null)
    const id = await faktura({})
    await expect(invoices.transitionStatus(id, orgId, 'SENT', null, 'USER')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/[Bb]ankgiro/),
    })
    expect((await rad(id)).status).toBe('DRAFT')
    expect(await handelser(id)).toEqual([])
  })

  it('F8.5 POSITIV: PATCH-vägen med giltigt mål → SENT; och nollsaldo utan mål → SENT', async () => {
    const id = await faktura({})
    await invoices.transitionStatus(id, orgId, 'SENT', null, 'USER')
    expect((await rad(id)).status).toBe('SENT')
    await satMal(null)
    const noll = await faktura({ total: 0 })
    await invoices.transitionStatus(noll, orgId, 'SENT', null, 'USER')
    expect((await rad(noll)).status).toBe('SENT')
  })

  it('F8.5 VOID är ingen sändning: makulering tillåts utan mål', async () => {
    await satMal(null)
    const id = await faktura({})
    await invoices.transitionStatus(id, orgId, 'VOID', null, 'USER')
    expect((await rad(id)).status).toBe('VOID')
  })

  // ═══ F8 · TENANTGRÄNS ═════════════════════════════════════════════════════

  it('F8.6 tenantgräns: en annan orgs mål avgör inte, och främmande faktura är 404', async () => {
    await satMal(null) // org A saknar mål
    await satMal(GILTIGT, annanOrgId) // org B har
    const idA = await faktura({})
    await expect(invoices.sendInvoiceEmail(idA, orgId, 'aktor')).rejects.toMatchObject({
      status: 400,
    })
    // Org B kan inte skicka A:s faktura, oavsett sitt eget giltiga mål.
    await expect(invoices.sendInvoiceEmail(idA, annanOrgId, 'aktor')).rejects.toMatchObject({
      status: 404,
    })
    const idB = await faktura({ org: annanOrgId, tenant: annanTenantId })
    await invoices.sendInvoiceEmail(idB, annanOrgId, 'aktor')
    expect(koade).toHaveLength(1)
    expect(koade[0]!.invoiceId).toBe(idB)
  })

  // ═══ F8 · PÅMINNELSER ═════════════════════════════════════════════════════

  it('F8.7 manuell påminnelse utan mål: avvisas före brev och REMINDER_SENT', async () => {
    await satMal(null)
    const id = await faktura({ status: 'OVERDUE', dueDate: '2026-01-01' })
    await expect(notifications.sendOverdueRemindersForOrg(orgId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/[Bb]ankgiro/),
    })
    expect(mejl).toHaveLength(0)
    expect(await handelser(id)).toEqual([])
  })

  it('F8.7 POSITIV: manuell påminnelse med mål skickas', async () => {
    const id = await faktura({ status: 'OVERDUE', dueDate: '2026-01-01' })
    const svar = await notifications.sendOverdueRemindersForOrg(orgId)
    expect(svar.sent).toBeGreaterThanOrEqual(1)
    expect(mejl.some((m) => m.kind === 'overdue-manual')).toBe(true)
    expect(await handelser(id)).toContain('REMINDER_SENT')
  })

  /** Kravtrappans cron för EXAKT de här fakturorna — övriga rader i basen rörs inte i asserten. */
  const paminnelseRader = (id: string) =>
    prisma.paymentReminder.findMany({ where: { invoiceId: id }, select: { type: true } })

  it('F8.8 cron utan mål: varken vänlig eller formell påminnelse — ingen avgift, inget verifikat, inget brev', async () => {
    await satMal(null)
    const nu = new Date()
    const dag = (n: number) => new Date(nu.getTime() - n * 86_400_000).toISOString().slice(0, 10)
    const vanlig = await faktura({ status: 'OVERDUE', dueDate: dag(3) })
    const formell = await faktura({ status: 'OVERDUE', dueDate: dag(20) })
    const totalFore = (await rad(formell)).total

    await reminders.processOverdueReminders()

    for (const id of [vanlig, formell]) {
      expect(await paminnelseRader(id)).toEqual([])
      expect(await handelser(id)).toEqual([])
    }
    expect((await rad(formell)).total).toEqual(totalFore)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: `reminder-fee:${formell}` },
      }),
    ).toBe(0)
    expect(mejl.filter((m) => m.kind === 'friendly' || m.kind === 'formal')).toHaveLength(0)
  }, 60_000)

  it('F8.8 POSITIV: samma fakturor med giltigt mål får sina påminnelser', async () => {
    const nu = new Date()
    const dag = (n: number) => new Date(nu.getTime() - n * 86_400_000).toISOString().slice(0, 10)
    const vanlig = await faktura({ status: 'OVERDUE', dueDate: dag(3) })
    const formell = await faktura({ status: 'OVERDUE', dueDate: dag(20) })
    await reminders.processOverdueReminders()
    expect((await paminnelseRader(vanlig)).map((r) => r.type)).toEqual(['REMINDER_FRIENDLY'])
    expect((await paminnelseRader(formell)).map((r) => r.type)).toEqual(['REMINDER_FORMAL'])
  }, 60_000)

  // ═══ F7 · CRONENS STATUSFLIPP VID SVENSK MIDNATT ═════════════════════════

  it.each(GRANSER)(
    'F7.1 $namn: SENT → OVERDUE först när den svenska dagen passerat',
    async ({ due, sista, forsta }) => {
      const id = await faktura({ status: 'SENT', dueDate: due })
      await vid(new Date(sista), () => notifications.markOverdueInvoices())
      expect((await rad(id)).status).toBe('SENT')
      await vid(new Date(forsta), () => notifications.markOverdueInvoices())
      expect((await rad(id)).status).toBe('OVERDUE')
    },
    60_000,
  )

  it('F7.1 kreditnota flippas aldrig till OVERDUE (oförändrat villkor)', async () => {
    const id = await faktura({ status: 'SENT', dueDate: '2026-07-01', isCreditNote: true })
    await vid(new Date('2026-07-05T12:00:00Z'), () => notifications.markOverdueInvoices())
    expect((await rad(id)).status).toBe('SENT')
  })

  // ═══ F7 · KRAVTRAPPANS DAGRÄKNING ════════════════════════════════════════

  it.each([
    // [förfallodag, nu, svenska dagar]
    ['2026-07-01', '2026-07-01T21:59:59Z', 0],
    ['2026-07-01', '2026-07-01T22:00:00Z', 1],
    ['2026-01-15', '2026-01-15T23:00:00Z', 1],
    // Över vår-DST: 28 mars → 31 mars 00:00 CEST = tre svenska dagar på 71 h.
    ['2026-03-28', '2026-03-30T22:00:00Z', 3],
    // Över höst-DST: 24 okt → 26 okt 00:00 CET = två svenska dagar på 49 h.
    ['2026-10-24', '2026-10-25T23:00:00Z', 2],
  ])('F7.2 daysOverdue %s vid %s = %i svenska kalenderdagar', async (due, nu, dagar) => {
    const id = await faktura({ status: 'OVERDUE', dueDate: due })
    const lista = await vid(new Date(nu), () => reminders.getOverdueStatus(orgId))
    expect(lista.find((r) => r.id === id)?.daysOverdue).toBe(dagar)
  })

  // ═══ F7 · UTSKRIVET DATUM I DOKUMENT OCH MEJL ════════════════════════════

  it('F7.3 PDF och mejl skriver den AVTALADE förfallodagen i processens server-TZ', async () => {
    {
      const due = new Date('2026-07-01T00:00:00Z') // som Prisma returnerar ett @db.Date
      const issue = new Date('2026-06-01T00:00:00Z')
      const html = generateInvoiceHtml({
        invoice: {
          invoiceNumber: 'T2-PDF',
          type: 'OTHER',
          status: 'DRAFT',
          issueDate: issue,
          dueDate: due,
          subtotal: new Prisma.Decimal(100),
          vatTotal: new Prisma.Decimal(0),
          total: new Prisma.Decimal(100),
          ocrNumber: null,
          reference: null,
          notes: null,
          lines: [],
          tenant: {
            type: 'INDIVIDUAL',
            firstName: 'Alva',
            lastName: 'Provperson',
            companyName: null,
            email: 'a@example.invalid',
            phone: null,
            address: null,
          },
          organization: {
            name: 'T2 AB',
            orgNumber: null,
            email: null,
            street: null,
            city: null,
            postalCode: null,
            bankgiro: GILTIGT,
            logoUrl: null,
            hasFSkatt: false,
            fSkattApprovedDate: null,
            vatNumber: null,
            companyForm: null,
          },
        },
        logoBase64: null,
      } as never)
      expect(html).toContain('2026-07-01')
      expect(html).toContain('2026-06-01')
      expect(html).not.toContain('2026-06-30')
      expect(html).not.toContain('2026-05-31')
      expect(mejlDatum(due)).toBe('1 juli 2026')
    }
  })
})
