/**
 * K2 — BETALNINGSMÅL FÖRE UTSKICK.
 *
 * Kundprovet 2026-09-23 (`kundflodesprov-ed3d0ef2-20260923`) fångade tre riktiga
 * avi-PDF:er där `Organization.bankgiro` var `null` och dokumentet ändå bar
 * `TILL BANKGIRO 0000-0000` — ett betalningsmål produkten hittade på.
 * Kvitton: `pdf/mail-2-0.txt` (deposition), `pdf/mail-3-0.txt` (delmånad),
 * `pdf/mail-5-0.txt` (oktober).
 *
 * Provet nedan mäter RENDERINGEN, inte källtexten: en vakt som letar efter
 * strängen `'0000-0000'` i filen hade blivit grön av en omskrivning som
 * fortfarande skriver talet i dokumentet.
 *
 * Riggen är samma som `avisering.notice-pdf-branding.spec.ts` — `buildNoticePdfHtml`
 * är privat men ren så länge `logoStorageKey` är null, så den anropas direkt.
 */

// storage.service (AWS SDK, ESM) + pdf.service (Puppeteer) dras in vid import.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

/** Samma kända avi som brandningsprovet, så OCR-raden går att förutsäga. */
function buildNotice(overrides: Record<string, unknown> = {}) {
  return {
    type: 'RENT',
    isProrated: false,
    ocrNumber: '1234567890',
    noticeNumber: 'AVI-2026-0001',
    dueDate: new Date('2026-07-01T00:00:00Z'),
    year: 2026,
    month: 7,
    amount: 10000,
    totalAmount: 10000,
    vatAmount: 0,
    consumptionAmount: 0,
    miscChargeAmount: 0,
    reminderFeeAmount: 0,
    credits: [],
    totalDays: null,
    daysCharged: null,
    periodStart: null,
    periodEnd: null,
    isBackfill: false,
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Alva',
      lastName: 'Provperson',
      companyName: null,
      email: 'alva@eveno.test',
      phone: null,
    },
    lease: {
      monthlyRent: 10000,
      unit: {
        unitNumber: '1001',
        name: 'Provbostad 1001',
        property: { street: 'Provvägen 23', name: 'Testgården' },
      },
    },
    lines: [],
    ...overrides,
  }
}

/** Kundprovets organisation: bankgiro saknas helt. */
const ORG_UTAN_MAL = {
  name: 'Eveno Kundprov 20260923',
  street: '',
  postalCode: '',
  city: '',
  email: 'owner@eveno.test',
  bankgiro: null,
  invoiceColor: null,
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null,
}

/** Samma organisation med ett verkligt, kontrollerbart bankgiro. */
const ORG_MED_MAL = { ...ORG_UTAN_MAL, bankgiro: '5050-1055' }

function makeService() {
  const noop = {}
  return new AviseringService(
    noop as never, // prisma
    noop as never, // ocr
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    noop as never, // accounting
    noop as never, // consumption
    noop as never, // miscCharges
    { ensureDepositForNotice: jest.fn().mockResolvedValue({ created: false }) } as never,
    {} as never, // rentNoticeEvents
  )
}

async function render(
  org: Record<string, unknown>,
  noticeOverrides: Record<string, unknown> = {},
): Promise<string> {
  const service = makeService()
  return (
    service as unknown as {
      buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string>
    }
  ).buildNoticePdfHtml(buildNotice(noticeOverrides), org)
}

describe('K2 — avi-PDF:en hittar inte på ett betalningsmål', () => {
  it('org utan bankgiro: dokumentet innehåller INGEN 0000-0000', async () => {
    const html = await render(ORG_UTAN_MAL)
    expect(html).not.toContain('0000-0000')
    // Och inte som ren siffergrupp i den maskinläsbara giro-raden heller
    // (`bg.replace('-','')` gav `00000000#41#` i kundprovets kvitton).
    expect(html).not.toContain('00000000#41#')
  })

  it('org utan bankgiro: depositionsavin lika lite — samma väg, samma krav', async () => {
    const html = await render(ORG_UTAN_MAL, { type: 'DEPOSIT' })
    expect(html).not.toContain('0000-0000')
  })

  // ── B2: TEXTEN OM LEVERANS FÅR INTE HÄRLEDAS UR DAGENS MÅL ───────────────
  //
  // Granskningen av #919 (T1) fann att grenvillkoret berodde ENBART på
  // organisationens nuvarande fält. Meningen "…HAR INTE SKICKATS" skrevs därför
  // för varje avi i en org vars bankgiro just nu fattas — även en som gått ut.
  // Fyndet var källhärlett; proven nedan gör det mätbart.
  describe('B2 — vad dokumentet får säga om leverans', () => {
    const SKICKAD = { sentAt: new Date('2026-07-01T09:00:00Z'), status: 'SENT' }

    it('SKICKAD avi utan mål: säger INTE att den inte skickats', async () => {
      const html = await render(ORG_UTAN_MAL, SKICKAD)
      expect(html).not.toContain('HAR INTE SKICKATS')
      // Och den säger vad den FAKTISKT vet: kopian saknar uppgifter i dag.
      expect(html).toContain('BETALNINGSUPPGIFTER SAKNAS I DEN HÄR KOPIAN')
      expect(html).toContain('Avin har skickats till hyresgästen')
      // Inget påhittat mål, ingen maskinläsbar giro-rad.
      expect(html).not.toContain('0000-0000')
      expect(html).not.toContain('#41#')
    })

    it('OSKICKAD avi utan mål: får säga att den inte skickats', async () => {
      const html = await render(ORG_UTAN_MAL, { sentAt: null, status: 'PENDING' })
      expect(html).toContain('HAR INTE SKICKATS')
      expect(html).not.toContain('Avin har skickats')
      expect(html).not.toContain('0000-0000')
    })

    it.each([
      [
        'PAID efter utskick — sentAt står kvar',
        { sentAt: new Date('2026-07-01T09:00:00Z'), status: 'PAID' },
      ],
      [
        'CANCELLED efter utskick',
        { sentAt: new Date('2026-07-01T09:00:00Z'), status: 'CANCELLED' },
      ],
    ])('%s: ingen osann mening om utebliven leverans', async (_namn, over) => {
      const html = await render(ORG_UTAN_MAL, over)
      expect(html).not.toContain('HAR INTE SKICKATS')
      expect(html).toContain('Avin har skickats till hyresgästen')
    })

    // ── DET HÄR FALLET LÅSTE IN DEFEKTEN, OCH ÄR OMVÄNT NU ──────────────────
    //
    // Raden hette "OVERDUE utan sentAt — status ensam räcker" och krävde att
    // dokumentet INTE sa "HAR INTE SKICKATS". Den var fel: `OVERDUE` är inget
    // bevis för leverans, eftersom `checkAndMarkOverdue` flippar även `PENDING`
    // — alltså en avi som aldrig gått ut. Provet skyddade alltså det falska
    // påståendet i stället för mot det.
    //
    // Täckningen minskar inte: fallet finns kvar med motsatt krav, och
    // `b2-pending-overdue-pdf.db.spec.ts` kör dessutom hela vägen dit genom den
    // riktiga listvägen mot riktig Postgres.
    it('OVERDUE UTAN sentAt: ingen leverans har skett, och dokumentet påstår inte det', async () => {
      const html = await render(ORG_UTAN_MAL, { sentAt: null, status: 'OVERDUE' })
      expect(html).toContain('HAR INTE SKICKATS')
      expect(html).not.toContain('Avin har skickats')
      expect(html).not.toContain('0000-0000')
    })

    it('OVERDUE MED sentAt: leveransen har skett, och det syns', async () => {
      const html = await render(ORG_UTAN_MAL, {
        sentAt: new Date('2026-07-01T09:00:00Z'),
        status: 'OVERDUE',
      })
      expect(html).toContain('Avin har skickats till hyresgästen')
      expect(html).not.toContain('HAR INTE SKICKATS')
    })

    it('PENDING som aldrig skickats i en org MED mål: betalbart dokument, ingen leveransmening', async () => {
      // Positiv kontroll åt andra hållet: grenen får inte skrivas när målet finns.
      const html = await render(ORG_MED_MAL, { sentAt: null, status: 'PENDING' })
      expect(html).not.toContain('BETALNINGSUPPGIFTER SAKNAS')
      expect(html).not.toContain('HAR INTE SKICKATS')
      expect(html).toContain('5050-1055')
      expect(html).toContain('#41#')
    })

    it('B2.4 återställt mål: samma SKICKADE avi blir betalbar igen', async () => {
      const utan = await render(ORG_UTAN_MAL, SKICKAD)
      const med = await render(ORG_MED_MAL, SKICKAD)
      expect(utan).toContain('BETALNINGSUPPGIFTER SAKNAS I DEN HÄR KOPIAN')
      expect(med).not.toContain('BETALNINGSUPPGIFTER SAKNAS')
      expect(med).toContain('TILL BANKGIRO')
      expect(med).toContain('5050-1055')
      expect(med).toContain('#41#')
    })

    it('B2.7 inget måltillstånd ger ett påhittat mål', async () => {
      for (const org of [
        ORG_UTAN_MAL,
        { ...ORG_UTAN_MAL, bankgiro: '   ' },
        { ...ORG_UTAN_MAL, bankgiro: '0000-0000' },
        ORG_MED_MAL,
      ]) {
        for (const over of [SKICKAD, { sentAt: null, status: 'PENDING' }]) {
          expect(await render(org, over)).not.toContain('0000-0000')
        }
      }
    })
  })

  it('org MED giltigt bankgiro: målet står kvar i dokumentet', async () => {
    const html = await render(ORG_MED_MAL)
    expect(html).toContain('5050-1055')
    // Övre org-rutan OCH giro-slipen.
    expect(html).toContain('Bankgiro: 5050-1055')
    expect(html).toContain('TILL BANKGIRO')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  UTSKICKSGRINDEN — de VERKLIGA tjänste-/kövägarna, inte en fristående validator
// ════════════════════════════════════════════════════════════════════════════
//
// Riggen kör MOTORN PÅ RIKTIGT (`createInitialNoticesForLease` → `sendNotices` →
// `processNoticeSendJob`) mot en prisma-attrapp, och räknar mejl i en LOKAL
// FÅNGARE. Anropsräknare på `enqueue` ensamt hade inte räckt: frågan är om ett
// mejl når en hyresgäst, och det avgörs i workern på andra sidan kön.
//
// KÄND GRÄNS — attrappen utvärderar inte `where`. Att grinden läser
// organisationen ur avins EGEN `organizationId` bärs därför av org-provet nedan,
// som ger de två organisationerna olika svar från attrappen, inte av att en
// SQL-avgränsning prövats.

interface OrgSeed {
  id: string
  bankgiro: string | null
}

function makeSendRig(orgs: OrgSeed[]) {
  const startDate = new Date('2026-06-15T00:00:00Z')
  const leases = orgs.map((o) => ({
    id: `lease-${o.id}`,
    organizationId: o.id,
    tenantId: `tenant-${o.id}`,
    status: 'ACTIVE',
    monthlyRent: 12000,
    monthlyRentExcludingVat: false,
    depositAmount: 0,
    startDate,
    tenancyStartDate: startDate,
    endDate: null,
    unit: {
      type: 'APARTMENT',
      voluntaryTaxLiability: false,
      unitNumber: '1001',
      name: 'Provbostad 1001',
      property: { name: 'Testgården', street: 'Provvägen 23' },
    },
    tenant: {
      id: `tenant-${o.id}`,
      email: `hyresgast-${o.id}@eveno.test`,
      type: 'INDIVIDUAL',
      firstName: 'Alva',
      lastName: 'Provperson',
      phone: null,
      companyName: null,
    },
  }))

  const orgRows = new Map(
    orgs.map((o) => [
      o.id,
      {
        id: o.id,
        name: `Org ${o.id}`,
        street: 'Kungsgatan 2',
        postalCode: '111 22',
        city: 'Stockholm',
        email: `owner-${o.id}@eveno.test`,
        bankgiro: o.bankgiro,
        invoiceColor: null,
        brandSecondaryColor: null,
        brandFont: null,
        logoStorageKey: null,
        daysBeforeMoveInForFirstPayment: 7,
      },
    ]),
  )

  interface Row {
    id: string
    organizationId: string
    leaseId: string
    tenantId: string
    noticeNumber: string
    ocrNumber: string
    year: number
    month: number
    type: string
    amount: number
    totalAmount: number
    vatAmount: number
    consumptionAmount: number
    miscChargeAmount: number
    reminderFeeAmount: number
    dueDate: Date
    status: string
    sentAt: Date | null
    sendError: string | null
    isProrated: boolean
    isBackfill: boolean
    periodStart: Date | null
    periodEnd: Date | null
    totalDays: number | null
    daysCharged: number | null
  }
  const notices: Row[] = []
  let seq = 0
  let nrSeq = 0

  const mails: Array<{ to: string; noticeNumber: string; pdfBytes: number }> = []
  const enqueued: Array<{ organizationId: string; noticeId: string }> = []

  const prisma = {
    lease: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(leases.find((l) => l.id === where.id) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(leases.find((l) => l.id === where.id) ?? null),
      ),
    },
    organization: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(orgRows.get(where.id) ?? null),
      ),
    },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNoticeNumberSequence: {
      upsert: jest.fn().mockImplementation(() => Promise.resolve({ lastNumber: ++nrSeq })),
    },
    rentNotice: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `rn-${++seq}`,
          sentAt: null,
          sendError: null,
          status: 'PENDING',
          consumptionAmount: 0,
          miscChargeAmount: 0,
          reminderFeeAmount: 0,
          ...data,
        } as unknown as Row
        notices.push(row)
        const lease = leases.find((l) => l.id === row.leaseId)!
        return Promise.resolve({ ...row, lease: { unit: lease.unit }, tenant: lease.tenant })
      }),
      findMany: jest.fn(() =>
        Promise.resolve(notices.map((n) => ({ noticeNumber: n.noticeNumber }))),
      ),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const row = notices.find(
          (n) =>
            (where.id === undefined || n.id === where.id) &&
            (where.leaseId === undefined || n.leaseId === where.leaseId) &&
            (where.organizationId === undefined || n.organizationId === where.organizationId) &&
            (where.type === undefined || n.type === where.type) &&
            (where.year === undefined || n.year === where.year) &&
            (where.month === undefined || n.month === where.month),
        )
        if (!row) return Promise.resolve(null)
        const lease = leases.find((l) => l.id === row.leaseId)!
        return Promise.resolve({
          ...row,
          tenant: lease.tenant,
          lease: { ...lease, unit: lease.unit },
          lines: [],
          credits: [],
        })
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = notices.find((n) => n.id === where.id)
          if (row) Object.assign(row, data)
          return Promise.resolve(row ?? {})
        },
      ),
      updateMany: jest.fn(
        ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const tillatna = (where.status as { in?: string[] } | undefined)?.in
          const traffade = notices.filter(
            (n) =>
              (where.id === undefined || n.id === where.id) &&
              (where.organizationId === undefined || n.organizationId === where.organizationId) &&
              (tillatna === undefined || tillatna.includes(n.status)),
          )
          for (const r of traffade) Object.assign(r, data)
          return Promise.resolve({ count: traffade.length })
        },
      ),
    },
    $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
  }

  const mailService = {
    sendRentNotice: jest.fn((args: { to: string; noticeNumber: string; pdfBuffer: Buffer }) => {
      mails.push({
        to: args.to,
        noticeNumber: args.noticeNumber,
        pdfBytes: args.pdfBuffer.length,
      })
      return Promise.resolve('mail-job-1')
    }),
  }
  // Fångar HTML:en i stället för att rendera en riktig PDF — det är innehållet
  // provet frågar om, och Puppeteer hör inte hemma i en enhetsrigg.
  const renderadHtml: string[] = []
  const pdfService = {
    generateFromHtml: jest.fn((html: string) => {
      renderadHtml.push(html)
      return Promise.resolve(Buffer.from('%PDF-1.4 provbuffert'))
    }),
  }
  const pdfQueue = {
    enqueue: jest.fn((job: { organizationId: string; noticeId: string }) => {
      enqueued.push({ organizationId: job.organizationId, noticeId: job.noticeId })
      return Promise.resolve(`job-${enqueued.length}`)
    }),
  }

  const service = new AviseringService(
    prisma as never,
    { assignOcrToTenant: jest.fn().mockResolvedValue('00000000019') } as never,
    mailService as never,
    pdfService as never,
    {} as never, // storage
    pdfQueue as never,
    { createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
    { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
    { attachMiscChargesToRentNotice: jest.fn().mockResolvedValue(0) } as never,
    { ensureDepositForNotice: jest.fn().mockResolvedValue({ id: 'dep-1' }) } as never,
    {} as never, // rentNoticeEvents
  )

  /** Kör hela kedjan som Bull gör: köade jobb → workern. */
  async function korKon(): Promise<void> {
    while (enqueued.length > 0) {
      const job = enqueued.shift()!
      await service.processNoticeSendJob(job.organizationId, job.noticeId)
    }
  }

  return { service, prisma, notices, mails, enqueued, renderadHtml, pdfQueue, korKon, orgRows }
}

const GILTIGT = '5050-1055'

describe('K2 — aktiveringen skickar inte utan giltigt betalningsmål', () => {
  beforeEach(() => jest.clearAllMocks())

  it('SAKNAT mål: noll köade jobb, noll mejl, avin FAILED, mailed=false', async () => {
    const rig = makeSendRig([{ id: 'org-utan', bankgiro: null }])

    const res = await rig.service.createInitialNoticesForLease('lease-org-utan')

    // Avin SKAPAS — förberedandet ska fungera utan betalningsmål.
    expect(res.firstRent).not.toBeNull()
    // Men ingenting köas, och inget mejl kan därför nå någon.
    expect(rig.pdfQueue.enqueue).not.toHaveBeenCalled()
    await rig.korKon()
    expect(rig.mails).toHaveLength(0)
    // Statusen ljuger inte.
    expect(res.mailed).toBe(false)
    expect(res.blockedReason).toMatch(/[Bb]ankgiro/)
    expect(res.blockedReason).toMatch(/Inställningar/)
    const avi = rig.notices.find((n) => n.id === res.firstRent!.id)!
    expect(avi.status).toBe('FAILED')
    expect(avi.sentAt).toBeNull()
    expect(avi.sendError).toMatch(/[Bb]ankgiro/)
  })

  it('BLANKT mål behandlas som saknat — ett fält med blanktecken är inte ifyllt', async () => {
    const rig = makeSendRig([{ id: 'org-blank', bankgiro: '   ' }])
    const res = await rig.service.createInitialNoticesForLease('lease-org-blank')
    expect(rig.pdfQueue.enqueue).not.toHaveBeenCalled()
    expect(res.mailed).toBe(false)
  })

  it('KÄNT OGILTIGT mål (0000-0000) blockeras — inte bara tomt', async () => {
    const rig = makeSendRig([{ id: 'org-fejk', bankgiro: '0000-0000' }])
    const res = await rig.service.createInitialNoticesForLease('lease-org-fejk')
    expect(rig.pdfQueue.enqueue).not.toHaveBeenCalled()
    await rig.korKon()
    expect(rig.mails).toHaveLength(0)
    expect(res.mailed).toBe(false)
    expect(res.blockedReason).toMatch(/nollor/i)
  })

  it('GILTIGT mål: avin köas, workern skickar mejlet, status SENT, PDF bär målet', async () => {
    const rig = makeSendRig([{ id: 'org-med', bankgiro: GILTIGT }])

    const res = await rig.service.createInitialNoticesForLease('lease-org-med')
    expect(res.mailed).toBe(true)
    expect(res.blockedReason).toBeNull()
    expect(rig.pdfQueue.enqueue).toHaveBeenCalledTimes(1)

    await rig.korKon()

    expect(rig.mails).toHaveLength(1)
    expect(rig.mails[0]!.to).toBe('hyresgast-org-med@eveno.test')
    expect(rig.mails[0]!.pdfBytes).toBeGreaterThan(0)
    const avi = rig.notices.find((n) => n.id === res.firstRent!.id)!
    expect(avi.status).toBe('SENT')
    expect(avi.sentAt).not.toBeNull()
    // Dokumentet som faktiskt mejlades bär det giltiga målet och ingen nolla.
    expect(rig.renderadHtml).toHaveLength(1)
    expect(rig.renderadHtml[0]!).toContain(GILTIGT)
    expect(rig.renderadHtml[0]!).not.toContain('0000-0000')
  })

  it('ORG-GRÄNS: org A:s saknade mål blockerar inte org B', async () => {
    const rig = makeSendRig([
      { id: 'org-a', bankgiro: null },
      { id: 'org-b', bankgiro: GILTIGT },
    ])

    const a = await rig.service.createInitialNoticesForLease('lease-org-a')
    const b = await rig.service.createInitialNoticesForLease('lease-org-b')
    await rig.korKon()

    expect(a.mailed).toBe(false)
    expect(b.mailed).toBe(true)
    expect(rig.mails.map((m) => m.to)).toEqual(['hyresgast-org-b@eveno.test'])
  })
})

describe('K2 — grinden på andra sidan kön (workern)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('jobb som redan låg i kön när målet rensades: FAILED, INGET kast, inget mejl', async () => {
    const rig = makeSendRig([{ id: 'org-sen', bankgiro: GILTIGT }])
    const res = await rig.service.createInitialNoticesForLease('lease-org-sen')
    expect(rig.enqueued).toHaveLength(1)

    // Hyresvärden rensar bankgirot EFTER att jobbet köats.
    rig.orgRows.get('org-sen')!.bankgiro = null

    // Ett kast här hade gett fem meningslösa Bull-retries av ett fel som bara
    // hyresvärden kan rätta.
    await expect(rig.korKon()).resolves.toBeUndefined()

    expect(rig.mails).toHaveLength(0)
    const avi = rig.notices.find((n) => n.id === res.firstRent!.id)!
    expect(avi.status).toBe('FAILED')
    expect(avi.sendError).toMatch(/[Bb]ankgiro/)
  })

  it('en REDAN SKICKAD avi flippar inte till FAILED av att målet rensas efteråt', async () => {
    const rig = makeSendRig([{ id: 'org-klar', bankgiro: GILTIGT }])
    const res = await rig.service.createInitialNoticesForLease('lease-org-klar')
    await rig.korKon()
    const id = res.firstRent!.id
    expect(rig.notices.find((n) => n.id === id)!.status).toBe('SENT')

    rig.orgRows.get('org-klar')!.bankgiro = null
    const igen = await rig.service.sendNotices('org-klar', [id])

    expect(igen.blocked).toBe(1)
    expect(igen.queued).toBe(0)
    // Statusgrinden i updateMany skyddar historiken: SENT står kvar.
    expect(rig.notices.find((n) => n.id === id)!.status).toBe('SENT')
  })
})

describe('K2 — sendNotices är chokepunkten för de manuella vägarna', () => {
  beforeEach(() => jest.clearAllMocks())

  it('manuell send av flera avier: alla blockeras, blocked speglar antalet', async () => {
    const rig = makeSendRig([{ id: 'org-m', bankgiro: null }])
    await rig.service.createInitialNoticesForLease('lease-org-m')
    const ids = rig.notices.map((n) => n.id)

    const res = await rig.service.sendNotices('org-m', ids)

    expect(res.queued).toBe(0)
    expect(res.failed).toBe(0)
    expect(res.blocked).toBe(ids.length)
    expect(res.blockedReason).toMatch(/Inställningar/)
    expect(rig.pdfQueue.enqueue).not.toHaveBeenCalled()
  })

  it('tom lista rör ingenting och läser inte ens organisationen', async () => {
    const rig = makeSendRig([{ id: 'org-tom', bankgiro: null }])
    const res = await rig.service.sendNotices('org-tom', [])
    expect(res).toEqual({ queued: 0, failed: 0, jobIds: [], blocked: 0, blockedReason: null })
    expect(rig.prisma.organization.findUnique).not.toHaveBeenCalled()
  })
})
