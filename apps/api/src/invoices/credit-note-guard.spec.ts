/**
 * #517 — VAKT: EN KREDITNOTA UTAN ORIGINAL ELLER UTAN VERIFIKAT SKA FÄLLAS.
 *
 * Två saker gör en kreditnota farlig i stället för nyttig:
 *
 *   1. Utan koppling till originalet är den ett belopp som försvinner ur
 *      skuldberäkningen utan att gå att härleda till vad som krediterades.
 *   2. Utan verifikat är intäkten kvar i huvudboken medan fordran är borta ur
 *      systemet — huvudboken och fakturaregistret säger olika saker om samma
 *      affärshändelse.
 *
 * Vakten har TRE lager, och alla tre har en kanariefågel. En vakt som inte kan
 * falla mäter ingenting: varje detektor matas därför med indata som MÅSTE ge
 * utslag, och kräver att den gör det. Bryts detektorn blir vakten röd på sin
 * egen kanariefågel innan någon hinner tro att kodbasen är ren.
 *
 * DB-LAGRET ligger utanför den här filen: migrationen
 * 20260819220000_invoice_credit_note lägger
 * `Invoice_credit_note_requires_original_chk`, som vägrar raden även för ett
 * skript som skriver förbi tjänstelagret. Den kan inte mätas här (Jest-sviten
 * kör utan databas) och verifieras i stället mot Postgres, se PR-texten.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { CreditNoteService } from './credit-note.service'
import { InvoicesService } from './invoices.service'

const SRC = join(__dirname, '..')

/** Enda filen som får skriva en kreditnota. */
const SANKTIONERAD_SKRIVARE = 'invoices/credit-note.service.ts'

function allaTsFiler(dir: string): string[] {
  const ut: string[] = []
  for (const post of readdirSync(dir)) {
    const full = join(dir, post)
    if (statSync(full).isDirectory()) {
      ut.push(...allaTsFiler(full))
      continue
    }
    if (post.endsWith('.ts') && !post.endsWith('.spec.ts')) ut.push(full)
  }
  return ut
}

/**
 * Hittar de ställen som SKAPAR en kreditnota — och bara dem.
 *
 * MATCHAR PÅ FORM, inte på en uppräkning av kända filer: varje `isCreditNote`
 * satt till `true`, oavsett var. En lista över tillåtna ställen hade behövt
 * underhållas och är samma sorts uppräkning som en literal-grep
 * (dev_svep_filandelselista).
 *
 * SVÅRIGHETEN som gör detektorn mer än en regex: en Prisma-`select` skriver
 * `isCreditNote: true` med exakt samma tecken som en `data`-skrivning gör. En
 * radbaserad sökning kan alltså inte skilja "läs fältet" från "sätt fältet" —
 * första versionen av vakten fällde de två LÄSNINGARNA i invoices.service.ts
 * och hade tvingat fram en undantagslista, alltså precis den uppräkning svepet
 * finns för att slippa.
 *
 * Lösningen är en klammerstack över filen: varje `nyckel: {` läggs på stacken
 * och plockas av vid `}`. En träff räknas bara om den inte står inuti `select`
 * eller `include`. Båda formerna prövas i kanariefågeln nedan.
 */
function skrivareAvKreditnota(innehåll: string): string[] {
  const träffar: string[] = []
  const stack: string[] = []
  const nyckelFöreKlammer = /(\w+)\s*:\s*$/

  for (let i = 0; i < innehåll.length; i++) {
    const tecken = innehåll[i]

    if (tecken === '{') {
      const före = innehåll.slice(Math.max(0, i - 40), i)
      stack.push(nyckelFöreKlammer.exec(före)?.[1] ?? 'anon')
      continue
    }
    if (tecken === '}') {
      stack.pop()
      continue
    }
    if (tecken !== 'i' || !innehåll.startsWith('isCreditNote', i)) continue

    const rest = innehåll.slice(i, i + 40)
    if (!/^isCreditNote\s*:\s*true/.test(rest)) continue
    if (stack.includes('select') || stack.includes('include')) continue

    const radStart = innehåll.lastIndexOf('\n', i) + 1
    const radSlut = innehåll.indexOf('\n', i)
    träffar.push(innehåll.slice(radStart, radSlut === -1 ? undefined : radSlut).trim())
  }
  return träffar
}

describe('#517 — vakt: bara EN väg skapar kreditnotor', () => {
  it('KANARIEFÅGEL: detektorn ger utslag på det den måste, och bara på det', () => {
    // Matas in något som MÅSTE ge utslag. Går detektorn sönder — ett ändrat
    // fältnamn, ett trasigt uttryck, en klammerstack som driver — faller den
    // här raden FÖRST, och då är svepet nedanför inte längre ett bevis på att
    // kodbasen är ren.
    expect(skrivareAvKreditnota('data: { isCreditNote: true }')).toHaveLength(1)
    expect(
      skrivareAvKreditnota(
        ['await tx.invoice.create({', '  data: {', '    isCreditNote: true,', '  },', '})'].join(
          '\n',
        ),
      ),
    ).toHaveLength(1)

    // Och den ska INTE ge utslag på en LÄSNING. Det är hela skillnaden mellan
    // den här detektorn och en radbaserad grep.
    expect(
      skrivareAvKreditnota(['select: {', '  id: true,', '  isCreditNote: true,', '},'].join('\n')),
    ).toHaveLength(0)
    expect(
      skrivareAvKreditnota(['include: {', '  isCreditNote: true,', '},'].join('\n')),
    ).toHaveLength(0)
    expect(skrivareAvKreditnota('if (invoice.isCreditNote) throw new Error()')).toHaveLength(0)
    expect(skrivareAvKreditnota('isCreditNote: false,')).toHaveLength(0)

    // Stacken måste STÄNGAS igen: en skrivning EFTER ett avslutat select-block
    // ska fortfarande fällas. Utan den här raden vore en detektor som fastnar i
    // 'select' för alltid grön på hela kodbasen.
    expect(
      skrivareAvKreditnota(
        ['select: { isCreditNote: true },', 'data: { isCreditNote: true },'].join('\n'),
      ),
    ).toHaveLength(1)
  })

  it('ingen annan produktionsfil skapar en kreditnota', () => {
    const träffar: string[] = []
    for (const fil of allaTsFiler(SRC)) {
      const relativ = fil.slice(SRC.length + 1)
      if (relativ === SANKTIONERAD_SKRIVARE) continue
      for (const rad of skrivareAvKreditnota(readFileSync(fil, 'utf8'))) {
        träffar.push(`${relativ}: ${rad}`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('den sanktionerade vägen finns kvar — svepet får inte bli tomt för att filen försvann', () => {
    // Utan den här raden vore föregående test grönt även om kreditnotan
    // slutade existera. Ett tomt svep över en tom mängd bevisar ingenting.
    const innehåll = readFileSync(join(SRC, SANKTIONERAD_SKRIVARE), 'utf8')
    expect(skrivareAvKreditnota(innehåll).length).toBeGreaterThan(0)
  })
})

describe('#517 — vakt: kreditnotan får aldrig sakna original eller verifikat', () => {
  function rigg(opts: { bokförMisslyckas?: boolean } = {}) {
    const original = {
      id: 'inv-1',
      organizationId: 'org-1',
      invoiceNumber: 'F-2026-0001',
      type: 'RENT',
      status: 'SENT',
      isCreditNote: false,
      tenantId: 't1',
      customerId: null,
      leaseId: null,
      total: new Prisma.Decimal(1_000),
      lines: [
        {
          id: 'line-1',
          description: 'Rad',
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(1_000),
          vatRate: 0,
          total: new Prisma.Decimal(1_000),
        },
      ],
      payments: [],
      creditNotes: [],
    }
    const invoiceCreate = jest.fn((arg: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'credit-1', ...arg.data, total: new Prisma.Decimal(500), lines: [] }),
    )
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoice: { findFirst: jest.fn().mockResolvedValue(original), create: invoiceCreate },
      invoiceNumberSequence: { upsert: jest.fn().mockResolvedValue({ lastNumber: 7 }) },
    }
    const createJournalEntryForCreditNote = opts.bokförMisslyckas
      ? jest.fn().mockRejectedValue(new Error('kontoplanen saknar konto'))
      : jest.fn().mockResolvedValue({ id: 'je-1' })
    const service = new CreditNoteService(
      { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { createJournalEntryForCreditNote } as never,
    )
    return { service, invoiceCreate, createJournalEntryForCreditNote }
  }

  const anrop = {
    lines: [{ invoiceLineId: 'line-1', quantity: 1, unitPrice: 500 }],
    reason: 'skäl',
  }

  it('varje skapad kreditnota bär creditedInvoiceId', async () => {
    const { service, invoiceCreate } = rigg()
    await service.createCreditNote('inv-1', 'org-1', 'user-1', anrop)

    const data = invoiceCreate.mock.calls[0]![0].data
    expect(data.isCreditNote).toBe(true)
    expect(data.creditedInvoiceId).toBe('inv-1')
  })

  it('KANARIEFÅGEL: assertionen ovan skulle fälla en kreditnota utan koppling', () => {
    // Detektorn för kravet, prövad mot ett värde som MÅSTE fällas. Utan den här
    // raden vet vi inte om `toBe('inv-1')` faktiskt diskriminerar eller om den
    // bara råkar läsa ett fält som alltid är satt.
    const utanKoppling = { isCreditNote: true, creditedInvoiceId: undefined }
    expect(() => expect(utanKoppling.creditedInvoiceId).toBe('inv-1')).toThrow()
  })

  it('faller bokföringen skapas ingen kreditnota — transaktionen rullas tillbaka', async () => {
    const { service, createJournalEntryForCreditNote } = rigg({ bokförMisslyckas: true })

    await expect(service.createCreditNote('inv-1', 'org-1', 'user-1', anrop)).rejects.toThrow(
      /kontoplanen/i,
    )
    // Anropet gjordes — det är felet som kastas vidare ut ur transaktionen, och
    // det är den propageringen som gör dokumentet omöjligt utan verifikat.
    expect(createJournalEntryForCreditNote).toHaveBeenCalledTimes(1)
  })

  it('bokföringen sker INNAN transaktionen är klar, inte efteråt', async () => {
    const { service, invoiceCreate, createJournalEntryForCreditNote } = rigg()
    await service.createCreditNote('inv-1', 'org-1', 'user-1', anrop)

    // Ordningen är beviset för atomiciteten: hade verifikatet skapats efter
    // transaktionen kunde dokumentet överleva ett fel i bokföringen.
    expect(invoiceCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      createJournalEntryForCreditNote.mock.invocationCallOrder[0]!,
    )
  })
})

describe('#517 — vakt: kopplingen mellan VOID-spärren och skuldberäkningen', () => {
  it('transitionStatus spärrar fortfarande VOID på en kreditnota', () => {
    // `CreditNoteAmount` i invoice-debt.ts saknar statusfält, och det är BARA
    // korrekt så länge en kreditnota inte kan makuleras. Försvinner spärren
    // utan att skuldberäkningen börjar filtrera på status, börjar en makulerad
    // kreditnota fortsätta dra ned fordran — ett fel åt andra hållet.
    const källa = readFileSync(join(SRC, 'invoices/invoices.service.ts'), 'utf8')
    expect(källa).toMatch(/invoice\.isCreditNote\s*&&\s*newStatus\s*===\s*'VOID'/)
  })

  it('KANARIEFÅGEL: mönstret ovan hittar inte sig självt i vilken text som helst', () => {
    expect("if (invoice.isCreditNote && newStatus === 'VOID') {").toMatch(
      /invoice\.isCreditNote\s*&&\s*newStatus\s*===\s*'VOID'/,
    )
    expect('if (invoice.isCreditNote) {').not.toMatch(
      /invoice\.isCreditNote\s*&&\s*newStatus\s*===\s*'VOID'/,
    )
  })

  it('en kreditnota går inte att betala in på — den manuella vägen spärrar', () => {
    const källa = readFileSync(join(SRC, 'invoices/invoices.service.ts'), 'utf8')
    expect(källa).toMatch(/if \(invoice\.isCreditNote\) \{[\s\S]{0,200}kan inte betalas/)
  })
})

/**
 * #517 — SYMMETRIN: BÅDA RIKTNINGARNA MÅSTE VARA SPÄRRADE.
 *
 * Den första versionen av den här ändringen spärrade att kreditera en MAKULERAD
 * faktura, men inte att MAKULERA en krediterad. Det hålet hittades i den
 * maskinella bokföringsgranskningen, och det är ett verkligt penningfel:
 *
 *   `reverseJournalEntryForInvoice` letar på `sourceId = <invoiceId>` och vänder
 *   HELA originalverifikatet. Den vet ingenting om kreditnotan, som ligger under
 *   `credit-note:<id>`. En VOID ovanpå en delkreditering reverserar därför det
 *   redan krediterade beloppet en andra gång.
 *
 * Faktura 10 000, delkrediterad 3 000, därefter makulerad:
 *
 *   1510:  D 10 000 − K 3 000 − K 10 000 = −3 000
 *   3911:  K 10 000 − D 3 000 − D 10 000 = −3 000
 *
 * En negativ kundfordran och en negativ intäkt som inte motsvarar någon
 * affärshändelse. Båda riktningarna vilar på samma fysiska begränsning — två
 * verifikat som inte känner till varandra — så båda måste stängas.
 */
describe('#517 — makulering av en KREDITERAD faktura är spärrad', () => {
  function riggVoid(creditNotes: Array<{ id: string }>) {
    const invoiceRow = {
      id: 'inv-1',
      status: 'SENT',
      invoiceNumber: 'F-2026-0001',
      isCreditNote: false,
    }
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoiceRow),
        findMany: jest.fn().mockResolvedValue(creditNotes),
        update: jest.fn().mockResolvedValue({ ...invoiceRow, status: 'VOID' }),
      },
      invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceLine: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    }
    const reverseJournalEntryForInvoice = jest.fn().mockResolvedValue(undefined)
    const service = new InvoicesService(
      { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {
        reverseJournalEntryForInvoice,
        reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
        reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return { service, reverseJournalEntryForInvoice, tx }
  }

  it('VOID på en faktura med kreditnota nekas — annars dubbelreverseras huvudboken', async () => {
    const { service, reverseJournalEntryForInvoice } = riggVoid([{ id: 'credit-1' }])

    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER'),
    ).rejects.toThrow(/kreditnota/i)

    // Det avgörande: reverseringen får ALDRIG ha körts.
    expect(reverseJournalEntryForInvoice).not.toHaveBeenCalled()
  })

  it('DISKRIMINERANDE: utan kreditnota går makuleringen igenom som förut', async () => {
    // Kontrollfallet. Faller båda samtidigt mäter testerna ingenting — då är det
    // inte kreditnotan som gör skillnaden.
    const { service, reverseJournalEntryForInvoice } = riggVoid([])

    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')
    expect(reverseJournalEntryForInvoice).toHaveBeenCalledTimes(1)
  })
})
