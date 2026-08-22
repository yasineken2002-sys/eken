jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * M2 PR 2 — en explicit men olöst OCR gissas inte på.
 *
 * En transaktion vars `rawOcr` var SATT men inte löste ut föll vidare till
 * fuzzy-matchning, som matchar på BELOPP (unik kandidat inom 1 kr, 90 dagar).
 * En betalning med en giltig men felaktig OCR kunde därför krediteras en TREDJE
 * PARTS avi.
 *
 * Det som når den tidiga returen är OCR ur ett AVSIKTSFÄLT som inte löste ut:
 * felskrivningar som klarade Luhn, OCR från en annan organisation, och gamla OCR
 * för redan reglerade avier.
 *
 * RÄTTELSE. Den här texten påstod att en enkelsiffrig felskrivning "fångas till
 * hundra procent och blir aldrig en `rawOcr`". Det gällde `isValidOcrNumber` —
 * som `extractOcr` aldrig anropade. Vad som BLIR en `rawOcr` avgörs numera av
 * PROVENIENS, inte av formen: avsiktsfält rakt igenom, prosa bara med giltig
 * kontrollsiffra. Se ocr-proveniens.ts och ocr-proveniens.spec.ts, där den
 * gränsen mäts i stället för att påstås.
 *
 * Specarna nedan matar `matchTransaction` DIREKT och prövar därför bara grinden,
 * aldrig vad som gjorde `rawOcr` satt. Just den blindheten lät den falska
 * premissen stå: ingen av grenarna nedan hade blivit röd av den.
 *
 * TVÅ AV TRE GRENAR ÄR KANARIEFÅGLAR. Den mest sannolika felskrivningen av
 * fixen är en tidig retur som fires även när `rawOcr` är null — då försvinner
 * fuzzy för de fall där den är HELT LEGITIM, och det ser rätt ut i varje test
 * som bara provar gren 3.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

const dec = (v: string | number) => new Decimal(v)

function makeService(opts: { ocrTräff?: boolean; fuzzyKandidat?: boolean } = {}) {
  const notice = {
    id: 'rn-fuzzy',
    totalAmount: dec(8_000),
    consumptionAmount: dec(0),
    miscChargeAmount: dec(0),
    reminderFeeAmount: dec(0),
    credits: [],
  }
  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    // H2 identitetsgrind (ocr-identity.ts): matchTransaction frågar numera om
    // rawOcr gör anspråk på att vara ett SYSTEMTILLDELAT OCR innan fritextgrenen
    // (Invoice.reference) får konsulteras. Grinden läser Invoice, RentNotice OCH
    // Tenant — utan tenant i attrappen kraschar den på findFirst av undefined.
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: 'rn-ocr',
        noticeNumber: 'AVI-1',
        status: 'SENT',
        collectionStage: 'NONE',
        type: 'RENT',
        totalAmount: dec(8_000),
        consumptionAmount: dec(0),
        miscChargeAmount: dec(0),
        reminderFeeAmount: dec(0),
        interestAccruedAmount: dec(0),
        credits: [],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // #518 — krediteringarna läses på samma vägar som allokeringarna.
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'rnp-1' }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
  }

  const fuzzyNotices = opts.fuzzyKandidat === false ? [] : [notice]
  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // H2 identitetsgrind (ocr-identity.ts): matchTransaction frågar numera om
    // rawOcr gör anspråk på att vara ett SYSTEMTILLDELAT OCR innan fritextgrenen
    // (Invoice.reference) får konsulteras. Grinden läser Invoice, RentNotice OCH
    // Tenant — utan tenant i attrappen kraschar den på findFirst av undefined.
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNotice: {
      // OCR-uppslaget: träff bara om ocrTräff är satt.
      findFirst: jest.fn().mockResolvedValue(opts.ocrTräff ? { id: 'rn-ocr' } : null),
      // Fuzzy-kandidater.
      findMany: jest.fn().mockResolvedValue(fuzzyNotices),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    { record: jest.fn() } as never,
    {
      createJournalEntryForRentNoticePayment: jest.fn().mockResolvedValue({ id: 'je-1' }),
    } as never,
    {} as never,
    { record: jest.fn().mockResolvedValue({}) } as never,
  )
  return { service, prisma, txMock }
}

const tx = (rawOcr: string | null, amount = 8_000) => ({
  id: 'tx-1',
  rawOcr,
  amount: dec(amount),
  date: new Date('2026-06-20'),
  description: '',
  reference: '',
})

describe('de tre grenarna', () => {
  it('KANARIEFÅGEL (gren 1): rawOcr = null → fuzzy körs, precis som i dag', async () => {
    // Ett enkelsiffrigt fel faller på Luhn och blir ALDRIG en rawOcr. De fallen
    // ska fortfarande beloppsmatchas — en tidig retur som fires här tar bort
    // fuzzy för dess helt legitima användning.
    const { service, prisma } = makeService({ fuzzyKandidat: true })
    const resultat = await service.matchTransaction(tx(null) as never, 'org-1')

    expect(prisma.rentNotice.findMany).toHaveBeenCalled() // fuzzy-uppslaget skedde
    expect(resultat).toBe(true)
  })

  it('KANARIEFÅGEL (gren 2): rawOcr satt OCH avin hittas → matchning, ingen tidig retur', async () => {
    const { service } = makeService({ ocrTräff: true })
    await expect(service.matchTransaction(tx('00000000019') as never, 'org-1')).resolves.toBe(true)
  })

  it('KÄRNAN (gren 3): rawOcr satt men inget uppslag löser ut → TIDIG RETUR, ingen fuzzy', async () => {
    const { service, prisma } = makeService({ ocrTräff: false, fuzzyKandidat: true })
    const resultat = await service.matchTransaction(tx('00000000019') as never, 'org-1')

    expect(resultat).toBe(false)
    // Det avgörande: fuzzy-uppslaget gjordes ALDRIG.
    expect(prisma.rentNotice.findMany).not.toHaveBeenCalled()
    expect(prisma.invoice.findMany).not.toHaveBeenCalled()
  })

  it('orsaken loggas med transaktion, org och den OCR som inte stämde', async () => {
    const { service } = makeService({ ocrTräff: false })
    const spion = jest
      .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined)

    await service.matchTransaction(tx('00000000019') as never, 'org-7')

    const rad = spion.mock.calls.map(([m]) => String(m)).find((r) => r.includes('tx-1'))
    expect(rad).toBeDefined()
    expect(rad).toContain('org-7')
    expect(rad).toContain('00000000019')
  })
})

describe('autoMatchAll räknar dem för sig', () => {
  function riggMed(utfall: Array<{ rawOcr: string | null; matchar: boolean }>) {
    const candidates = utfall.map((u, i) => ({ id: `tx-${i + 1}`, rawOcr: u.rawOcr }))
    const prisma = { bankTransaction: { findMany: jest.fn().mockResolvedValue(candidates) } }
    const service = new ReconciliationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    jest
      .spyOn(service, 'matchTransaction')
      .mockImplementation((t: { id: string }) =>
        Promise.resolve(utfall[candidates.findIndex((c) => c.id === t.id)]!.matchar),
      )
    return service
  }

  it('en olöst OCR räknas separat — och ingår fortfarande i unmatched', async () => {
    // "En ledtråd som inte stämde" är något annat än "ingen ledtråd alls", och
    // pekar på ett annat åtgärdssteg för den som granskar manuellt.
    const service = riggMed([
      { rawOcr: '00000000019', matchar: false },
      { rawOcr: null, matchar: false },
      { rawOcr: '00000000028', matchar: true },
    ])
    await expect(service.autoMatchAll('org-1')).resolves.toEqual({
      matched: 1,
      unmatched: 2,
      failed: 0,
      skippedUnresolvedOcr: 1,
    })
  })

  it('noll olösta OCR ger noll — räknaren hittar inte på', async () => {
    const service = riggMed([
      { rawOcr: null, matchar: false },
      { rawOcr: 'x', matchar: true },
    ])
    const r = await service.autoMatchAll('org-1')
    expect(r.skippedUnresolvedOcr).toBe(0)
  })
})
