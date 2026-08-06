/**
 * #352 PR 2 — DEPOSITIONER SVEPS INTE MED I EN INKASSO-BATCH.
 *
 * FAR: att lämna en fordran till inkasso är bindande, och för en deposition är
 * konsekvenserna annorlunda än för hyra — hyresgästen bor kvar, relationen
 * pågår. Det ska vara ett uttryckligt mänskligt beslut PER FALL.
 *
 * Invändningen gäller verktygets NATUR, inte listans längd: bulk-vägen är byggd
 * för att svepa, och en operatör som bockar "markera alla" har inte tagit
 * ställning till just den depositionen.
 *
 * VAD SOM FINNS KVAR — poängen, inte en lucka:
 *   • `POST /collections/export/:invoiceId` (enskild, namngiven faktura)
 *   • `POST /collections/mark-sent/:invoiceId`
 *   • AI-verktygen `export_for_collection` / `mark_sent_to_collection`, som
 *     redan kräver DUBBELBEKRÄFTELSE (verifierat i ai-assistant.service.ts) och
 *     går genom exakt samma `exportForInvoice`/`claimForExport` som HTTP-vägen.
 *     Det finns ingen bulk-variant på AI-sidan.
 *
 * Skillnaden är att stänga en GENVÄG, inte att ta bort en MÖJLIGHET.
 *
 * ── STEG 5 INGÅR INTE, OCH DET ÄR MÄTT ────────────────────────────────────
 *
 * Planen var att också spärra cronens `markReadyForCollection`. Det gick inte:
 * grenarna är en if/continue-kedja, så en spärrad deposition faller ner i steg 4
 * och får FORMELL PÅMINNELSE MED AVGIFT (3593) i stället för en avgiftsfri
 * inkasso-markering. Se kommentaren i `payment-reminder.service.ts`. Steg 5
 * kräver att steg 4 stängs samtidigt — alltså PR 1b, som väntar på juridik.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { CollectionExportService } from './collection-export.service'

type Row = { id: string; invoiceNumber: string; type: string; status: string }

/**
 * ATTRAPPGRÄNSEN ÄR UTTALAD, INTE EN OLYCKA.
 *
 * Första versionen av den här filen lät `exportBulk` krascha och påstod i en
 * kommentar att kastet kom från storage/zip-attrapperna. Det var fel — mätt av
 * code-reviewer-granskningen: kastet kom från `buildPdfHtml`, som läser
 * `invoice.paymentReminders` på en stubbe som inte hade fältet. Testerna var
 * gröna av rätt skäl men med fel förklaring, och den sortens kommentar leder
 * nästa felsökare åt fel håll.
 *
 * Nu stubbas de privata hjälparna EXPLICIT så att `exportBulk` kan köra klart.
 * Då mäts inte bara vilka fakturor som claimas, utan också vad som faktiskt
 * hamnar i `skipped` — den enda plats i kodbasen som fångar en framtida
 * refaktorering av den texten.
 */
function makeService(rows: Row[]) {
  const claimed: string[] = []
  const svc = new CollectionExportService(
    {
      // `exportForInvoice` skriver `collectionExportKey` direkt efter uppladdning
      // (utanför transaktionen); bulk-vägen gör samma sak inuti en. Båda behöver
      // finnas för att vägarna ska kunna köras klart.
      invoice: { update: jest.fn() },
      $transaction: jest.fn(async (fn: unknown) =>
        typeof fn === 'function'
          ? (fn as (tx: unknown) => unknown)({ invoice: { update: jest.fn() } })
          : undefined,
      ),
    } as never,
    { reveal: jest.fn(() => null) } as never,
    { generateFromHtml: jest.fn(async () => Buffer.from('pdf')) } as never,
    { uploadFile: jest.fn(async () => 'https://example.invalid/fil') } as never,
    { enqueue: jest.fn() } as never,
  )
  const s = svc as unknown as {
    loadInvoice: (id: string, org: string) => Promise<Row>
    claimForExport: (...a: unknown[]) => Promise<void>
    outstandingFor: (inv: Row) => unknown
    buildPdfHtml: (inv: Row) => Promise<string>
    buildCsv: (invs: Row[]) => string
  }
  s.loadInvoice = jest.fn(async (id: string) => rows.find((r) => r.id === id)!)
  s.claimForExport = jest.fn(async (id: unknown) => {
    claimed.push(String(id))
  })
  s.outstandingFor = () => ({ outstanding: { toNumber: () => 1000 } })
  s.buildPdfHtml = async () => '<html></html>'
  s.buildCsv = () => 'csv'
  return { svc, claimed }
}

const ORG = 'org-1'
const rent = (id: string): Row => ({
  id,
  invoiceNumber: `F-${id}`,
  type: 'RENT',
  status: 'OVERDUE',
})
const deposit = (id: string): Row => ({
  id,
  invoiceNumber: `F-${id}`,
  type: 'DEPOSIT',
  status: 'OVERDUE',
})

describe('#352 PR 2 · exportBulk hoppar över depositioner', () => {
  it('depositionen NÅR ALDRIG claimen — den markeras inte SENT_TO_COLLECTION', async () => {
    // KONTROLLENS PLACERING ÄR HELA POÄNGEN. `claimForExport` skriver
    // SENT_TO_COLLECTION och pausar påminnelser. Låg kontrollen EFTER claimen
    // vore fakturan redan överlämnad i systemets ögon utan att ha kommit med i
    // ZIP:en — värre än att exportera den.
    const { svc, claimed } = makeService([rent('a'), deposit('b'), rent('c')])

    const res = await svc.exportBulk(['a', 'b', 'c'], ORG)

    expect(claimed).toEqual(['a', 'c'])
    expect(claimed).not.toContain('b')
    expect(res.count).toBe(2)
  })

  it('`skipped` bär depositionen MED skäl — och pekar på den väg som finns kvar', async () => {
    const { svc } = makeService([rent('a'), deposit('b')])

    const res = await svc.exportBulk(['a', 'b'], ORG)

    expect(res.skipped).toEqual([
      {
        invoiceNumber: 'F-b',
        reason: expect.stringContaining('Depositionsfordran kräver enskild bedömning'),
      },
    ])
    // Skälet ska hänvisa vidare, inte bara neka.
    expect(res.skipped[0]?.reason).toMatch(/enskild faktura/i)
  })

  it('hela batchen fälls INTE — hyresfakturorna går igenom', async () => {
    // NEGATIVKONTROLL i par: en spärr som stoppade hela batchen hade också gett
    // "depositionen exporterades inte", men av fel skäl.
    const { svc, claimed } = makeService([rent('a'), deposit('b')])
    const res = await svc.exportBulk(['a', 'b'], ORG)
    expect(claimed).toEqual(['a'])
    expect(res.count).toBe(1)
  })

  it('en batch med ENBART depositioner ger ett begripligt fel, inte en tom ZIP', async () => {
    const { svc, claimed } = makeService([deposit('b')])
    await expect(svc.exportBulk(['b'], ORG)).rejects.toThrow(/kunde exporteras/i)
    expect(claimed).toEqual([])
  })

  it('en batch UTAN depositioner är oförändrad', async () => {
    const { svc, claimed } = makeService([rent('a'), rent('c')])
    const res = await svc.exportBulk(['a', 'c'], ORG)
    expect(claimed).toEqual(['a', 'c'])
    expect(res.skipped).toEqual([])
  })
})

describe('#352 PR 2 · den enskilda vägen finns kvar för depositioner', () => {
  it('exportForInvoice claimar depositionen — möjligheten är INTE borttagen', async () => {
    // Spärren gäller bulk-vägen. En människa som pekar ut precis den här
    // fakturan ska fortfarande kunna lämna den till inkasso — det var FAR:s
    // uttryckliga krav, och utan det här testet kunde någon "städa" bort den
    // vägen i tron att #352 vill stoppa allt.
    const { svc, claimed } = makeService([deposit('b')])
    await svc.exportForInvoice('b', ORG)
    expect(claimed).toEqual(['b'])
  })
})
