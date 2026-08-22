// I/O-kanterna måste attrappas innan ReconciliationService importeras:
// storage.service drar in @aws-sdk, vars ESM-beroende ts-jest inte kan parsa.
// Ingen av dem rör OCR-uppslaget.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import {
  harSystemtilldelatOcr,
  SYSTEM_ASSIGNED_OCR_FIELDS,
  FREE_TEXT_OCR_FIELDS,
} from './ocr-identity'

/**
 * H2 — en förhoppning får aldrig vinna över en identitet.
 *
 * Den DECISIVA mätningen ligger i bevisriggen mot riktig Postgres (se PR:n):
 * bara där syns vilket dokument som faktiskt fick pengarna. De här specarna
 * täcker grindens egen logik och den ORDNING den styr, så att regeln inte kan
 * försvinna tyst mellan två riggkörningar.
 */

const träff = { id: 'x' }

function makeDb(opts: { invoice?: unknown; rentNotice?: unknown; tenant?: unknown }) {
  return {
    invoice: { findFirst: jest.fn().mockResolvedValue(opts.invoice ?? null) },
    rentNotice: { findFirst: jest.fn().mockResolvedValue(opts.rentNotice ?? null) },
    tenant: { findFirst: jest.fn().mockResolvedValue(opts.tenant ?? null) },
  }
}

describe('harSystemtilldelatOcr — vilka fält bär en identitet', () => {
  it('fakturans egna OCR gör anspråk', async () => {
    const db = makeDb({ invoice: träff })
    await expect(harSystemtilldelatOcr(db as never, 'org-1', '00000000019')).resolves.toBe(true)
  })

  it('avins OCR gör anspråk', async () => {
    const db = makeDb({ rentNotice: träff })
    await expect(harSystemtilldelatOcr(db as never, 'org-1', '00000000019')).resolves.toBe(true)
  })

  it('HYRESGÄSTENS OCR gör anspråk även utan en enda avi', async () => {
    // RentNotice.ocrNumber är bara en KOPIA av Tenant.ocrNumber. Att fråga
    // kopian vore att lita på att den alltid hunnit skapas — en hyresgäst kan ha
    // fått sitt nummer innan första avin finns, och numret är hens ändå.
    const db = makeDb({ tenant: träff })
    await expect(harSystemtilldelatOcr(db as never, 'org-1', '00000000019')).resolves.toBe(true)
  })

  it('inget anspråk när numret inte tilldelats av systemet', async () => {
    const db = makeDb({})
    await expect(harSystemtilldelatOcr(db as never, 'org-1', '55512345678')).resolves.toBe(false)
    // Alla tre måste ha frågats innan svaret får bli nej — annars är "ingen
    // identitet" bara "jag tittade inte överallt".
    expect(db.invoice.findFirst).toHaveBeenCalledTimes(1)
    expect(db.rentNotice.findFirst).toHaveBeenCalledTimes(1)
    expect(db.tenant.findFirst).toHaveBeenCalledTimes(1)
  })

  it('frågar utan statusvillkor — ett tilldelat OCR blir aldrig ledigt igen', async () => {
    // En betald avi gör inte numret fritt för någon annans fritextfält. Hade
    // grinden statusfiltrerat hade kapningen öppnats igen så snart avin flippat.
    const db = makeDb({ rentNotice: träff })
    await harSystemtilldelatOcr(db as never, 'org-1', '00000000019')
    const args = db.rentNotice.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(args.where).toEqual({ organizationId: 'org-1', ocrNumber: '00000000019' })
    expect(args.where.status).toBeUndefined()
  })

  it('kortsluter — hittas identiteten tidigt frågas inte resten', async () => {
    const db = makeDb({ invoice: träff, rentNotice: träff, tenant: träff })
    await harSystemtilldelatOcr(db as never, 'org-1', '00000000019')
    expect(db.rentNotice.findFirst).not.toHaveBeenCalled()
    expect(db.tenant.findFirst).not.toHaveBeenCalled()
  })
})

describe('registren — klassningen är källan som CI-guarden läser', () => {
  it('Invoice.reference är klassat som FRITEXT, inte som identitet', () => {
    // Den här raden är hela defekten i komprimerad form: fältet låg i
    // OCR-uppslaget som om det vore en identitet.
    expect(FREE_TEXT_OCR_FIELDS).toContain('Invoice.reference')
    expect(SYSTEM_ASSIGNED_OCR_FIELDS).not.toContain('Invoice.reference')
  })

  it('de tre identitetsfälten är klassade som identiteter', () => {
    expect([...SYSTEM_ASSIGNED_OCR_FIELDS].sort()).toEqual([
      'Invoice.ocrNumber',
      'RentNotice.ocrNumber',
      'Tenant.ocrNumber',
    ])
  })

  it('inget fält står i BÅDA registren', () => {
    const överlapp = SYSTEM_ASSIGNED_OCR_FIELDS.filter((f) =>
      (FREE_TEXT_OCR_FIELDS as readonly string[]).includes(f),
    )
    expect(överlapp).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ORDNINGEN I matchTransaction
//
// Grinden är värdelös om den inte STYR uppslaget. Den här sviten mäter just det
// och ingenting annat: konsulteras fritextgrenen, ja eller nej.
// ─────────────────────────────────────────────────────────────────────────────

/** Where-klausulerna som skickats till invoice.findFirst, i ordning. */
const whereKlausuler = (fn: jest.Mock): Array<Record<string, unknown>> =>
  fn.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where)

function makeService(opts: { identitetFinns: boolean }) {
  const invoiceFindFirst = jest.fn().mockResolvedValue(null)
  const prisma = {
    invoice: {
      findFirst: invoiceFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: {
      // Grindens uppslag OCH kandidatuppslaget går båda till samma attrapp. De
      // skiljs åt på `orderBy`: kandidatsökningen väljer äldsta avi och bär det,
      // grinden frågar bara om numret är tilldelat och gör det inte. Låt bara
      // grinden träffa — då mäter sviten ORDNINGEN och inget annat, i stället för
      // att fortsätta in i betalningsallokeringen.
      findFirst: jest.fn(async (args: { orderBy?: unknown }) =>
        args.orderBy === undefined && opts.identitetFinns ? { id: 'rn-1' } : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb({})),
  }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { service, prisma, invoiceFindFirst }
}

const TX = {
  id: 'bt-1',
  organizationId: 'org-1',
  date: new Date('2026-09-25'),
  description: '',
  amount: new Decimal('7350'),
  rawOcr: '00000000019',
  reference: null,
  status: 'UNMATCHED',
}

describe('matchTransaction — grinden STYR fritextgrenen', () => {
  it('gör OCR:et anspråk på en identitet slås Invoice.reference ALDRIG upp', async () => {
    const { service, invoiceFindFirst } = makeService({ identitetFinns: true })
    await service.matchTransaction(TX as never, 'org-1')

    const nycklar = whereKlausuler(invoiceFindFirst)
    expect(nycklar.some((w) => 'ocrNumber' in w)).toBe(true) // identitetsgrenen kördes
    expect(nycklar.some((w) => 'reference' in w)).toBe(false) // förhoppningen tystades
  })

  it('gör det INTE anspråk slås Invoice.reference upp som förut', async () => {
    // Funktionen är underordnad, inte borttagen. Utan det här fallet hade vi
    // bara stängt av reference-matchningen och kallat det en rättelse.
    const { service, invoiceFindFirst } = makeService({ identitetFinns: false })
    await service.matchTransaction(TX as never, 'org-1')

    expect(whereKlausuler(invoiceFindFirst).some((w) => 'reference' in w)).toBe(true)
  })
})
