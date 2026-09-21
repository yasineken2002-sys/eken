import { createHash } from 'node:crypto'

import type { Decimal } from '@prisma/client/runtime/library'

/**
 * BANKIMPORTENS TVÅ IDENTITETER (#F034b).
 *
 * Filen bär båda, därför att de besvarar två olika frågor som är lätta att
 * blanda ihop:
 *
 *   AVTRYCKET (`beräknaImportavtryck`)  "är det här SAMMA IMPORT igen?"
 *                                       → filnivå, avgörs av BankImportAttempt
 *
 *   RADIDENTITETEN (`radIdentitet*`)    "är det här SAMMA BETALNING igen?"
 *                                       → radnivå, avgörs av det partiella
 *                                         unika indexet på BankTransaction
 *
 * Två OLIKA filer kan bära samma betalning (överlappande exportperioder). Två
 * körningar av samma fil är samma import. Ett skydd som bara har den ena frågan
 * svarar fel på den andra.
 */

export type BankImportKind = 'CSV' | 'XLSX' | 'XLS' | 'BGMAX' | 'PDF_CONFIRM'

/**
 * Arrendets livslängd. En RUNNING-rad vars puls är äldre än detta har tappat
 * sitt arrende och får övertas av ett återförsök.
 *
 * ── HUR TALET HÄRLEDS, OCH VAD DET KOSTAR ───────────────────────────────────
 *
 * Bandet har två sidor. För KORT och en långsam men levande import blir
 * övertagen mitt i sig själv; för LÅNGT och en dödad process lämnar importen
 * upptagen i onödan. Pulsen (`pulsa()` under radloopen) gör den första sidan
 * ofarlig så länge körningen alls gör framsteg, så talet behöver bara täcka det
 * längsta SPRÅNGET mellan två pulser — inte hela importens längd.
 *
 * 15 minuter är valt som ett runt tal en storleksordning över det längsta
 * enskilda steget i vägen (en radmatchning med bokföring har taket 8 s,
 * `PAYMENT_TX_LIMITS.timeout`). Talet är alltså inte en mätning av en hel
 * import, och ska inte läsas som en.
 *
 * KVARSTÅENDE KOSTNAD, uttrycklig: dör processen mitt i en import möts
 * operatören av "importen pågår" i upp till 15 minuter fast ingen kör. UI:t
 * visar starttiden så väntan går att förstå i stället för att bara vara ett fel.
 */
export const IMPORT_LEASE_TTL_MS = 15 * 60 * 1000

/** Hur ofta arrendets puls uppdateras under en radloop (antal rader). */
export const IMPORT_PULSE_EVERY_ROWS = 50

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashaBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Kanonisering. JSON-array och inte en sammanfogad sträng, av ett skäl som är
 * lätt att underskatta: `'a' + '|' + 'b|c'` och `'a|b' + '|' + 'c'` ger samma
 * sträng. En avgränsare som kan förekomma I ett fält gör två olika identiteter
 * till en. `JSON.stringify` av en array är entydig.
 */
function kanonisera(delar: Array<string | null>): string {
  return JSON.stringify(delar)
}

/**
 * ── AVTRYCKET ───────────────────────────────────────────────────────────────
 *
 * `organizationId ‖ mål ‖ kind ‖ contentHash ‖ mappingHash`.
 *
 * MÅLET ÄR ORGANISATIONEN, OCH DET ÄR EN REDOVISAD GRÄNS. `BankTransaction`
 * har inget kontofält — raden hör till organisationen, inte till ett bankkonto.
 * CSV- och BgMax-vägarna tar aldrig emot ett kontonummer, och PDF-vägens
 * `BankStatementImport.accountNumber` är AI-extraherat ur utdraget, alltså inte
 * en styrd måladress. Parametern finns kvar i signaturen så att dagen då flera
 * bankkonton per organisation införs har EN plats att ändra — men i dag är
 * `mål === organizationId`, och att påstå något annat hade varit att låtsas om
 * ett skydd som inte finns.
 */
export function beräknaImportavtryck(input: {
  organizationId: string
  mål: string
  kind: BankImportKind
  contentHash: string
  mappingHash: string
}): string {
  return sha256(
    kanonisera([input.organizationId, input.mål, input.kind, input.contentHash, input.mappingHash]),
  )
}

/**
 * ── RADIDENTITETEN ──────────────────────────────────────────────────────────
 *
 * NAMNRYMDEN ÄR FÄLTUPPSÄTTNINGEN, INTE FILVÄGEN. Det är ett medvetet val och
 * inte en genväg.
 *
 * CSV/XLSX/XLS och PDF-bekräftelsen dedupar redan mot VARANDRA i dag: båda
 * frågar `{date, description, amount, reference}` mot samma tabell, så en
 * betalning importerad via båda vägarna känns igen som en. Hade nyckeln burit
 * `kind` hade det cross-source-skyddet fallit bort ur det unika indexet.
 *
 * BgMax frågar en ANNAN uppsättning (`{date, amount, rawOcr}` — formatet har
 * ingen textkolumn och dess `description` är syntetisk) och får därför en egen
 * namnrymd. Det speglar basen exakt: BgMax läsning kan hitta en CSV-rad, men
 * inte tvärtom. Indexet lägger ingenting till och tar ingenting bort där.
 */
const NAMNRYMD_FIL = 'FIL_V1'
const NAMNRYMD_BGMAX = 'BGMAX_V1'

/** Tomt värde är ett EGET värde, aldrig en joker. Se F034. */
function text(v: string | null | undefined): string {
  return v ?? ''
}

function datum(d: Date): string {
  return d.toISOString()
}

function belopp(a: Decimal): string {
  return a.toFixed(2)
}

/**
 * CSV/XLSX/XLS och PDF-bekräftelsen. Fälten är EXAKT dem respektive vägs
 * fält-dedup frågar efter i dag — `reference` inkluderad, vilket var F034:s
 * rättning. Inget fält är tillagt och inget borttaget: identiteten är samma
 * fråga i en form ett DB-index kan bära.
 */
export function radIdentitetFil(rad: {
  date: Date
  description: string
  amount: Decimal
  reference: string | null
}): string {
  return sha256(
    kanonisera([
      NAMNRYMD_FIL,
      datum(rad.date),
      rad.description,
      belopp(rad.amount),
      text(rad.reference),
    ]),
  )
}

/**
 * BgMax. `description` ingår INTE — den är syntetisk (`BgMax inbetalning (OCR
 * …)`) och att hålla den utanför är det som gör att samma betalning importerad
 * via både BgMax och CSV känns igen som en. `rawOcr` är en RÅ teckenposition i
 * fastformatet, inte ett härlett värde, och kan därför inte drifta mellan
 * kodversioner.
 */
export function radIdentitetBgMax(rad: {
  date: Date
  amount: Decimal
  rawOcr: string | null
}): string {
  return sha256(kanonisera([NAMNRYMD_BGMAX, datum(rad.date), belopp(rad.amount), text(rad.rawOcr)]))
}

/**
 * FÖREKOMSTRÄKNAREN inom EN fil.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Utan den svarar varje filburen nyckel "samma betalning" om två rader som är
 * lika i allt filen bär — även när de är två verkliga betalningar. Basen räknar
 * den andra som dubblett, och de pengarna når aldrig databasen.
 *
 * ── VARFÖR DEN INTE SUMMERAR ÖVER FILER ─────────────────────────────────────
 *
 * Regeln per rad är "dubblett omm databasen redan har MINST seq+1 lagrade rader
 * med samma identitet". Antalet lagrade rader konvergerar därför mot MAX över
 * filer av "antal förekomster i den filen" — aldrig summan. En överlappande
 * annan fil med samma betalning EN gång får seq 0, ser den lagrade raden och
 * räknas som dubblett.
 *
 * ── PRIS-SIDAN, UTTRYCKLIG ──────────────────────────────────────────────────
 *
 * En fil som listar SAMMA betalning två gånger ger nu två rader där basen gav
 * en. Jag har inte kunnat konstruera ett sådant fall ur de fyra format
 * `detectBankFormat` känner igen eller ur BgMax TC 20/21 (skilda poster, inte
 * ett par för samma betalning) — men det är inte samma sak som att det inte
 * finns.
 */
export class Förekomsträknare {
  private readonly sedda = new Map<string, number>()

  /** Nästa 0-baserade förekomstnummer för identiteten i den här filen. */
  nästa(identityKey: string): number {
    const n = this.sedda.get(identityKey) ?? 0
    this.sedda.set(identityKey, n + 1)
    return n
  }
}
