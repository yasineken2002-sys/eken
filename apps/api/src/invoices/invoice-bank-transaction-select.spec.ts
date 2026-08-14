/**
 * #440-RÄTTELSE — BANKKONTOTS FÄLT SKA INTE FÖLJA MED EN FAKTURA UT.
 *
 * `GET /reconciliation/transactions` grindades till ACCOUNTANT+ i #440. Grinden
 * satt rätt och var ändå verkningslös: `InvoicesService.findOne` drog in hela
 * `BankTransaction`-raden via ett bart `include`, och `GET /invoices/:id` är
 * öppen för varje roll. Samma rader — inklusive `balance`, hyresvärdens
 * kontosaldo — nåddes alltså runt grinden av en VIEWER som slog upp en faktura.
 *
 * Defektklassen: golden-filen bevakar VEM som får anropa, aldrig VAD svaret bär.
 * En korrekt satt grind kan vara verkningslös för att samma data når ut via en
 * annan resurs include. Se det uppföljande ärendet om svarsyte-inventarium.
 *
 * TESTET LÄSER KÄLLAN, INTE ETT SVAR. Samma skäl som i
 * invoice-customer-select.spec.ts: ett svarsbaserat test hade behövt en
 * attrapp-Prisma som själv låtsas respektera selecten, och därmed bara bevisat
 * att attrappen är konsekvent med sig själv.
 *
 * DEN VIKTIGA VAKTEN ÄR DEN TREDJE. De två första låser dagens skärning. Den
 * tredje partitionerar HELA `BankTransaction`-modellen mot schema.prisma: varje
 * kolumn måste stå antingen i selecten eller i `MEDVETET_UTELÄMNADE` med ett
 * skäl. Läggs en ny kolumn till modellen faller testet tills någon klassat den.
 * Utan den hade det här testet varit blint för exakt den sortens tillägg som
 * skapade läckan från början.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Importeras från sin EGNA modul, inte från invoices.service.ts: den drar in
// pdf.service → storage.service → @aws-sdk/client-s3, vars ESM-kedja ts-jest inte
// transformerar. Samma skäl som får authz-surface.ts att läsa källan statiskt.
import { SAFE_INVOICE_BANK_TRANSACTION_SELECT } from './invoice-bank-transaction-select'

const SERVICE = join(__dirname, 'invoices.service.ts')
const SCHEMA = join(__dirname, '..', '..', 'prisma', 'schema.prisma')

/** Blankar kommentarer men behåller radnumreringen. */
function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * Kolumner som MEDVETET utelämnas, med skälet. Formen är densamma som
 * MEDVETNA_UNDANTAG i invoice-customer-select.spec.ts: ett utelämnande ska vara
 * ett skrivet påstående någon kan ifrågasätta, inte en tyst frånvaro.
 */
const MEDVETET_UTELÄMNADE: Record<string, string> = {
  balance:
    'Kontosaldot vid transaktionen — organisationens likviditet. Har ingenting ' +
    'med den enskilda fakturan att göra. Den allvarligaste av dem alla.',
  matchedBy:
    'userId på den som matchade — aktörsfältet för en MANAGER+-handling, samma ' +
    'sort som #440 grindade i /reconciliation/transactions.',
  matchedAt: 'Tidsstämpel för samma matchningskörning.',
  createdAt: 'När raden importerades — importkörningens metadata, inte fakturans.',
  externalId: 'Bankens/aggregatorns transaktions-id (PSD2-källidentitet).',
  dedupKey: 'Deterministisk cross-source-nyckel — rent avstämningsmaskineri.',
  organizationId: 'Internt scopingfält utan klientanvändning.',
  status: 'Alltid MATCHED via where-klausulen — bär ingen information här.',
  invoiceId: 'FK tillbaka till fakturan man just hämtade.',
  matchedRentNoticeId: 'XOR-partnern, alltid null när invoiceId är satt.',
  reference:
    'Bankens fria referensfält. Inte känsligt, men ingen yta läser det — ' +
    'utelämnas på dataminimering.',
}

/** Skalära kolumner på en modell i schema.prisma (relationer räknas inte). */
function skaläraKolumner(modell: string): string[] {
  const src = readFileSync(SCHEMA, 'utf8')
  const start = src.indexOf(`model ${modell} {`)
  expect(start).toBeGreaterThan(-1)
  const kropp = src.slice(start, src.indexOf('\n}', start))
  const ut: string[] = []
  for (const rad of kropp.split('\n').slice(1)) {
    const t = rad.trim()
    if (t === '' || t.startsWith('//') || t.startsWith('@@')) continue
    const m = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(t)
    if (!m) continue
    const namn = m[1]
    const typ = m[2]
    const lista = m[3]
    if (namn === undefined || typ === undefined) continue
    // Relationsfält hoppas över: listor (`X[]`) och de modelltyper
    // BankTransaction pekar på. Enums (BankTransactionStatus) räknas som
    // skalära — de serialiseras och kan läcka som vilket fält som helst.
    const ärRelation = lista !== undefined || /^(Organization|Invoice|RentNotice)/.test(typ)
    if (!ärRelation) ut.push(namn)
  }
  return ut
}

describe('#440-rättelse: BankTransaction i fakturasvar', () => {
  const valda = Object.keys(SAFE_INVOICE_BANK_TRANSACTION_SELECT)

  it('selecten bär bara fält som hör till betalningen av fakturan', () => {
    expect(valda.sort()).toEqual(['amount', 'date', 'description', 'id', 'rawOcr'])
  })

  it('kontosaldot och aktörsfältet finns inte i selecten', () => {
    // Uttrycklig negativ kontroll på de två som gjorde läckan allvarlig.
    // Skulle någon återinföra dem faller testet på namnet, inte på en form.
    expect(valda).not.toContain('balance')
    expect(valda).not.toContain('matchedBy')
  })

  it('varje bankTransactions-include i tjänsten använder konstanten', () => {
    const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
    const träffar = [...src.matchAll(/bankTransactions:\s*\{([\s\S]*?)\n\s{8}\}/g)]
    // Golv: hittar regexen inga block har den slutat matcha koden, och ett
    // "inga överträdelser" hade då varit tomt-mängd-sant. Jfr #273:s rimlighetsgolv.
    expect(träffar.length).toBeGreaterThanOrEqual(2)
    for (const [block] of träffar) {
      expect(block).toContain('select: SAFE_INVOICE_BANK_TRANSACTION_SELECT')
    }
  })

  it('fakturans detaljsvar drar inte längre in händelseloggen', () => {
    // GET /invoices/:id/events är ACCOUNTANT+ sedan #440. Ett `events:`-include
    // i det öppna detaljsvaret gör den grinden verkningslös.
    const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
    expect(src).not.toMatch(/^\s*events:\s*\{/m)
  })

  it('varje kolumn på modellen är antingen vald eller medvetet utelämnad', () => {
    const kolumner = skaläraKolumner('BankTransaction')
    // Golv mot en parser som slutat hitta fält.
    expect(kolumner.length).toBeGreaterThanOrEqual(14)

    const oklassade = kolumner.filter((k) => !valda.includes(k) && !(k in MEDVETET_UTELÄMNADE))
    expect(oklassade).toEqual([])

    // Åt andra hållet: en motivering för en kolumn som inte längre finns är en
    // inaktuell text som döljer nästa riktiga fråga. Samma skäl som `declared`
    // i authz-surfacens driftkontroll.
    const föråldrade = Object.keys(MEDVETET_UTELÄMNADE).filter((k) => !kolumner.includes(k))
    expect(föråldrade).toEqual([])
  })
})
