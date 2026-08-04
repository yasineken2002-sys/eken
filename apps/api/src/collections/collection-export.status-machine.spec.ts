/**
 * #307 PR 2b — STATUSMASKINEN GRINDAR INKASSOÖVERLÄMNINGEN.
 *
 * Inkassovägen kringgick `INVOICE_TRANSITIONS` HELT: `grep isValidTransition
 * apps/api/src/collections/` gav noll träffar, och `SENT_TO_COLLECTION` skrevs
 * från vilken status som helst utom PAID/VOID. Statusmaskinen tillät bara
 * OVERDUE → SENT_TO_COLLECTION; koden gjorde något annat, och ingenting sa
 * ifrån.
 *
 * TVÅ FRÅGOR HÅLLS ISÄR HÄR:
 *   · VILKA statusar som får lämnas över — regeln, delad mellan båda vägarna
 *     och HÄRLEDD ur statusmaskinen (`COLLECTION_SOURCE_STATUSES`).
 *   · ATT regeln utvärderas ATOMISKT med skrivningen — annars återuppstår racet
 *     #311 stängde, bara med en grind framför sig.
 *
 * De två namngivna nekandena (DRAFT och SENT) står som egna tester med
 * motiveringen utskriven — FAR:s uttryckliga krav. De är BETEENDEÄNDRINGAR mot
 * main, inte bieffekter som ska upptäckas i produktion.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { INVOICE_TRANSITIONS, isValidTransition } from '@eken/shared'
import type { InvoiceStatus } from '@eken/shared'
import { CollectionExportService, COLLECTION_SOURCE_STATUSES } from './collection-export.service'

const ORG = 'org-1'
const ALL_STATUSES = Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]

/**
 * Attrapp för den MANUELLA vägen (`markSentToCollection`). `tx` är ett EGET
 * objekt, skilt från `prisma` — läxan från #288: med `$transaction: (cb) =>
 * cb(prisma)` blir "skrevs i transaktionen" osynligt sant för allt.
 */
function makeService(
  opts: { status?: InvoiceStatus; payments?: number[]; claimCount?: number } = {},
) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'F-2026-0001',
        status: opts.status ?? 'OVERDUE',
        total: 11_000,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: jest.fn(),
    },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue((opts.payments ?? []).map((amount) => ({ amount }))),
    },
    invoiceEvent: { create: jest.fn() },
  }
  const prisma = {
    // Skulle metoden läsa betalningarna UTANFÖR transaktionen skulle den träffa
    // den här — som kastar. Det är så testet "skuldberäkningen ligger innanför
    // transaktionen" kan hävda något alls.
    invoice: { findFirst: jest.fn(), update: jest.fn() },
    invoicePayment: {
      findMany: jest.fn(() => {
        throw new Error('betalningarna lästes UTANFÖR transaktionen')
      }),
    },
    invoiceEvent: { create: jest.fn() },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const svc = new CollectionExportService(
    prisma as never,
    { reveal: jest.fn(() => null) } as never,
    {} as never,
    {} as never,
    { enqueue: jest.fn() } as never,
  )
  return { svc, prisma, tx }
}

describe('#307 PR 2b · källstatusarna kommer UR statusmaskinen', () => {
  it('COLLECTION_SOURCE_STATUSES är exakt de statusar tabellen tillåter', () => {
    // Låset som gör att listan och tabellen inte kan glida isär. Utvidgas
    // INVOICE_TRANSITIONS så att en ny status pekar mot SENT_TO_COLLECTION
    // faller det här testet — och det är rätt: att öppna inkassodörren från en
    // ny status ska vara ett medvetet beslut, inte en bieffekt.
    expect(COLLECTION_SOURCE_STATUSES).toEqual(['PARTIAL', 'OVERDUE'])
    for (const from of ALL_STATUSES) {
      expect(COLLECTION_SOURCE_STATUSES.includes(from)).toBe(
        isValidTransition(from, 'SENT_TO_COLLECTION'),
      )
    }
  })

  it('PARTIAL → SENT_TO_COLLECTION är NY i tabellen — en delbetald fordran är en fordran', () => {
    // Kanten fanns redan i koden (notIn-guarden släppte igenom PARTIAL) men
    // saknades i modellen. Alternativet — att flippa PARTIAL → OVERDUE före
    // överlämningen — hade lagt in HELA ursprungsbeloppet i dashboardens
    // "Försenat belopp", eftersom OverdueDebtService räknar Invoice-sidan som
    // `inv.total`. Se `overdueDebtService`-blocket längst ned.
    expect(isValidTransition('PARTIAL', 'SENT_TO_COLLECTION')).toBe(true)
    expect(isValidTransition('OVERDUE', 'SENT_TO_COLLECTION')).toBe(true)
  })
})

describe('#307 PR 2b · exportvägen nekar de otillåtna källstatusarna', () => {
  // Exportvägen delar regel med den manuella vägen; här testas den via
  // markSentToCollection, som når samma `transitionBlockReason`. Att
  // exportvägens updateMany bär SAMMA tillåtlista hävdas i
  // collection-export.claim.spec.ts.

  it('DRAFT → SENT_TO_COLLECTION NEKAS — fakturan har aldrig nått mottagaren', async () => {
    // MOTIVERINGEN, utskriven: ett utkast är inte utställt. Gäldenären har
    // aldrig fått något krav, har därför inte kunnat betala, och kan omöjligen
    // vara i dröjsmål. Att lämna över det till ett inkassobolag vore ett krav
    // på en fordran mottagaren inte vet om — Inkassolagen 4 § (god inkassosed)
    // kräver att kravet avser en riktig, förfallen fordran.
    //
    // Före PR 2b gick det igenom: `notIn ['PAID','VOID','SENT_TO_COLLECTION']`
    // släppte DRAFT rakt in i claimen.
    const { svc, tx } = makeService({ status: 'DRAFT' })

    await expect(svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)).rejects.toThrow(
      /UTKAST/i,
    )

    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('SENT → SENT_TO_COLLECTION NEKAS — fakturan är inte markerad förfallen', async () => {
    // MOTIVERINGEN, utskriven: SENT betyder utställd men inte förfallen.
    // `markOverdueInvoices` (cron 09:00) flippar SENT → OVERDUE när
    // förfallodagen passerat, och kravtrappan — vänlig påminnelse, formell
    // påminnelse, redo för inkasso — löper först därefter. Att lämna över en
    // SENT-faktura hoppar över hela trappan och kräver in en skuld som ännu
    // inte är i dröjsmål.
    //
    // EFTERSLÄPNINGEN ÄR AVSIKTLIG OCH KONSEKVENT. Mellan förfallodagen och
    // 09:00 nästa dag står fakturan kvar på SENT och kan alltså inte
    // exporteras. Påminnelsecronen har exakt samma eftersläpning — den läser
    // också bara `status: 'OVERDUE'`. Att lägga in en egen dueDate-kontroll
    // HÄR hade gjort inkassovägen mer aggressiv än påminnelsevägen, vilket är
    // fel håll för den mest bindande handlingen i kedjan.
    const { svc, tx } = makeService({ status: 'SENT' })

    await expect(svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)).rejects.toThrow(
      /inte markerad som förfallen/i,
    )

    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    ['DRAFT' as const, /UTKAST/i],
    ['SENT' as const, /förfallen/i],
    ['PAID' as const, /betald eller makulerad/i],
    ['VOID' as const, /betald eller makulerad/i],
    ['SENT_TO_COLLECTION' as const, /redan överlämnad/i],
  ])(
    '%s får ett EGET, begripligt skäl — inte "ogiltig statusövergång"',
    async (status, mönster) => {
      // Verdiktet kommer ur statusmaskinen; orden väljs per status. En operatör
      // som klickar en knapp som inte gör något ska få veta VAD som fattas.
      const { svc } = makeService({ status })
      const err = await svc
        .markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BadRequestException)
      expect((err as Error).message).toMatch(mönster)
    },
  )

  it.each(COLLECTION_SOURCE_STATUSES)('%s går IGENOM — oförändrat beteende', async (status) => {
    // Negativkontrollens andra halva, inbakad: grinden får inte fälla de två
    // statusar som ska släppas. OVERDUE är main:s beteende; PARTIAL är den nya
    // kanten.
    const { svc, tx } = makeService({ status })

    await expect(
      svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER),
    ).resolves.toEqual({ id: 'inv-1', status: 'SENT_TO_COLLECTION' })

    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoiceEvent.create).toHaveBeenCalledTimes(1)
  })

  it('en ANDRA manuell markering skriver INGEN andra DEBT_COLLECTION-post', async () => {
    // Före PR 2b föll SENT_TO_COLLECTION rakt igenom PAID/VOID-kontrollen:
    // statusen skrevs om, `sentToCollectionAt` flyttades fram och en ANDRA
    // permanent post lades i en append-only-logg (BFL 5 kap 6–9 §) för en och
    // samma överlämning. Till skillnad från exportvägarna är det här ingen
    // omkörning som ska läka något — den manuella vägen har inget underlag att
    // fylla i.
    const { svc, tx } = makeService({ status: 'SENT_TO_COLLECTION' })

    await expect(svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)).rejects.toThrow(
      /redan överlämnad/i,
    )

    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
  })
})

describe('#315 · markSentToCollection är atomisk', () => {
  it('ALLT ligger i EN transaktion: lås, läsning, skuldgrind, claim och händelse', async () => {
    const { svc, prisma, tx } = makeService()

    await svc.markSentToCollection('inv-1', ORG, 'not', UserRole.OWNER, 'user-42')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.invoice.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.invoicePayment.findMany).toHaveBeenCalledTimes(1)
    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoiceEvent.create).toHaveBeenCalledTimes(1)
    // Ingenting gick vid sidan av transaktionsklienten (#288).
    expect(prisma.invoice.update).not.toHaveBeenCalled()
    expect(prisma.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('SKULDBERÄKNINGEN ligger INNANFÖR transaktionen och innanför låset', async () => {
    // Kravet skärptes efter PR 3: låg läsningen utanför kunde en betalning
    // landa mellan grinden och skrivningen, och grinden hade uttalat sig om ett
    // inaktuellt saldo. `prisma.invoicePayment.findMany` KASTAR i attrappen —
    // hade koden läst där hade testet fallit, inte tyst passerat.
    const { svc, prisma, tx } = makeService({ payments: [9_000] })

    await svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)

    expect(tx.invoicePayment.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled()
    // Låset togs FÖRE läsningen — annars är "innanför transaktionen" inte
    // detsamma som "samtidig med skrivningen".
    const låsOrdning = tx.$queryRaw.mock.invocationCallOrder[0]!
    expect(låsOrdning).toBeLessThan(tx.invoicePayment.findMany.mock.invocationCallOrder[0]!)
    expect(låsOrdning).toBeLessThan(tx.invoice.updateMany.mock.invocationCallOrder[0]!)
  })

  it('claimen är STATUS-GUARDAD och org-scopad — inte en blind update', async () => {
    const { svc, tx } = makeService()

    await svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)

    const arg = tx.invoice.updateMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(arg.where['id']).toBe('inv-1')
    expect(arg.where['organizationId']).toBe(ORG)
    expect(arg.where['status']).toEqual({ in: COLLECTION_SOURCE_STATUSES })
  })

  it('count === 0 → ConflictException och INGEN DEBT_COLLECTION-post', async () => {
    // Betalningen landade mellan grinden och skrivningen. PAID är terminal
    // (`INVOICE_TRANSITIONS.PAID = []`) — utan guarden hade den terminala
    // statusen skrivits över och ett permanent inkassospår lagts på en betald
    // faktura.
    const { svc, tx } = makeService({ claimCount: 0 })

    await expect(svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)).rejects.toThrow(
      ConflictException,
    )

    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('SKULDGRINDEN är kvar och ligger före claimen (#318 oförändrad)', async () => {
    const { svc, tx } = makeService({ payments: [11_000] })

    await expect(svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)).rejects.toThrow(
      /ingen kvarstående skuld/i,
    )

    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('NOTEN bärs in i remindersPausedReason — inte en generisk sträng', async () => {
    // Uttryckligt krav i #315: operatörens egen formulering är det enda som
    // säger VARFÖR påminnelserna pausades.
    const { svc, tx } = makeService()

    await svc.markSentToCollection('inv-1', ORG, 'Överlämnad via Vismas portal', UserRole.OWNER)

    const arg = tx.invoice.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(arg.data['remindersPausedReason']).toBe('Överlämnad via Vismas portal')
    expect(arg.data['remindersPaused']).toBe(true)
  })

  it('utan not används fallbacken — men aldrig i stället för en angiven not', async () => {
    const { svc, tx } = makeService()

    await svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)

    const arg = tx.invoice.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(arg.data['remindersPausedReason']).toBe('Skickad till externt inkassobolag')
  })

  it('TENANT-ISOLATION: faktura i annan org → NotFound, ingen status läcker', async () => {
    // Alla tre leden bär `organizationId` — låset, läsningen och claimen. En
    // aktör i org A som gissar ett invoiceId ur org B ska mötas av att raden
    // inte finns, INTE av ett statusspecifikt meddelande som avslöjar att den
    // gör det. `transitionBlockReason` skriver ut både fakturanummer och status,
    // så ordningen mellan org-kontrollen och statusgrinden spelar roll.
    // (Speglar rent-collection-export.service.spec.ts; efterlyst av
    // säkerhetsgranskningen av PR 2b.)
    const { svc, tx } = makeService()
    tx.invoice.findFirst.mockResolvedValue(null)

    const err = await svc
      .markSentToCollection('inv-i-annan-org', ORG, undefined, UserRole.OWNER)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as Error).message).not.toMatch(/F-2026-0001|OVERDUE|utkast|förfallen/i)
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    // Låset togs på org-scopat id — inte på id ensamt.
    const [sql, ...bindningar] = tx.$queryRaw.mock.calls[0]! as [string[], ...unknown[]]
    expect(sql.join('?')).toMatch(/"organizationId" =/)
    expect(bindningar).toEqual(['inv-i-annan-org', ORG])
  })

  it('INGEN collectionExportKey skrivs — det finns inget underlag att peka på', async () => {
    // Den manuella markeringen betyder att överlämningen skett i ett EXTERNT
    // system. En påhittad nyckel vore värre än ingen: `collectionExportKey` är
    // den auktoritativa hänvisningen till underlaget (BFL 5 kap 6 §).
    const { svc, tx } = makeService()

    await svc.markSentToCollection('inv-1', ORG, undefined, UserRole.OWNER)

    const arg = tx.invoice.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(arg.data).not.toHaveProperty('collectionExportKey')
    expect(tx.invoice.update).not.toHaveBeenCalled()
  })
})
