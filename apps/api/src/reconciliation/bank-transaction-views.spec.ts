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
import {
  SAFE_INVOICE_BANK_TRANSACTION_SELECT,
  RECONCILIATION_TRANSACTION_FIELDS,
} from './bank-transaction-views'
import { partitioneraKolumner } from '../common/testing/column-partition'

const INVOICES = join(__dirname, '..', 'invoices', 'invoices.service.ts')

/** Blankar kommentarer men behåller radnumreringen. */
function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * Kolumner som utelämnas ur SAMTLIGA svarsformer, med skälet.
 *
 * BETYDELSEN SKÄRPTES när partitionen bröts ut (#445). Kartan skrevs för #444,
 * när modellen bara hade EN form, och blandade då två slags utelämnanden: fält
 * som aldrig ska ut (`balance`, `matchedBy`) och fält som bara var ointressanta
 * i fakturakontexten (`status`, `reference`, `invoiceId`, `matchedAt` …).
 *
 * När form 2 tillkom bar den flera av den andra sorten — helt legitimt — och den
 * gamla bespoke-kontrollen såg det inte, eftersom den bara jämförde kartan mot
 * form 1. Den delade partitionen fällde det direkt: sex fält stod i BÅDA
 * mängderna, alltså var kartan ingen partition längre.
 *
 * Nu betyder den EN sak: aldrig ut, i någon form. Per-form-motiveringarna bor i
 * modulens doc, där de hör hemma — de är påståenden om vyerna, inte om modellen.
 */
/**
 * Delmängden av utelämnandena som hör till BANKKONTOT och därför inte får bära
 * ut i NÅGON vy — till skillnad från t.ex. `status` eller `invoiceId`, som är
 * ointressanta i fakturakontexten men bärande i avstämningsvyn.
 */
const BANKKONTOTS_FÄLT: string[] = ['balance', 'matchedBy', 'externalId', 'dedupKey']

const MEDVETET_UTELÄMNADE: Record<string, string> = {
  actorKind:
    'Intern proveniens (G1 steg 3): vem som SKAPADE raden — människa, agent ' +
    'eller system. Den frågan besvaras i historiken, inte i en fakturarad och ' +
    'inte i avstämningsvyn. Att skicka med den hade dessutom exponerat vilka ' +
    'poster AI:n rört för varje läsare av fakturasvaret, vilket är en annan ' +
    'grind än den här filens.',
  balance:
    'Kontosaldot vid transaktionen — organisationens likviditet. Har ingenting ' +
    'med vare sig en enskild faktura eller avstämningsarbetet att göra.',
  matchedBy:
    'userId på den som matchade — aktörsfältet för en MANAGER+-handling, samma ' +
    'sort som #440 grindade i /reconciliation/transactions.',
  externalId: 'Bankens/aggregatorns transaktions-id (PSD2-källidentitet).',
  dedupKey: 'Deterministisk cross-source-nyckel — rent avstämningsmaskineri.',
  organizationId: 'Internt scopingfält utan klientanvändning.',
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
    const src = utanKommentarer(readFileSync(INVOICES, 'utf8'))
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
    const src = utanKommentarer(readFileSync(INVOICES, 'utf8'))
    expect(src).not.toMatch(/^\s*events:\s*\{/m)
  })

  it('varje kolumn på modellen är klassad mot BÅDA svarsformerna', () => {
    // Delad partition (#445-utbrytningen), med TVÅ burna listor: form 1
    // (fakturakontexten, en Prisma-select) och form 2 (avstämningsvyn, en
    // handprojicering). En kolumn räknas som klassad om NÅGON form bär den —
    // att en kolumn står i form 2 men inte i form 1 är legitimt och beskrivet i
    // modulens doc. En ny kolumn blir röd EN gång och tvingar fram ett beslut
    // för båda formerna samtidigt.
    const formTvå = [...RECONCILIATION_TRANSACTION_FIELDS] as string[]
    const r = partitioneraKolumner({
      modell: 'BankTransaction',
      burna: [valda, formTvå],
      utelämnade: MEDVETET_UTELÄMNADE,
      golv: 14,
    })
    expect(r.oklassade).toEqual([])
    expect(r.föråldrade).toEqual([])
    expect(r.iBåda).toEqual([])
    // KANARIEFÅGEL — villkor 2 för utbrytningen (#445).
    //
    // Utan den här är en trasig hjälpare TYST: returnerar `partitioneraKolumner`
    // alltid tomma mängder passerar varje konsument, även med en verklig
    // överträdelse i schemat. Uppmätt under utbrytningen — en bruten hjälpare
    // plus en oklassad kolumn gav grönt på alla fyra.
    //
    // Kontrollen matar in en partition som MÅSTE ge utslag och kräver att den
    // gör det. En regression i hjälparen blir därmed röd på fyra ställen i
    // stället för noll, vilket var hela villkoret utbrytningen vilade på.
    expect(
      partitioneraKolumner({ modell: 'BankTransaction', burna: [[]], utelämnade: {}, golv: 1 })
        .oklassade.length,
    ).toBeGreaterThan(0)

    // MODELLSPECIFIK, stannar här: form 2 får inte bära något ur bankkontots
    // fält. Den grinden gäller alla vyer, inte bara fakturakontexten — och den
    // är ett påstående om DEN HÄR modellens semantik, inte om partitionsformen.
    // Hjälparen ska inte lära sig den; då blir konfigurationen logik.
    const formTvåBärBankfält = formTvå.filter((k) => BANKKONTOTS_FÄLT.includes(k))
    expect(formTvåBärBankfält).toEqual([])
  })
})
