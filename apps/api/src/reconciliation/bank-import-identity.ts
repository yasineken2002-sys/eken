import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'
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
 *   RADIDENTITETEN (`filIdentitet` / `bgMaxIdentitet`)  "är det här SAMMA BETALNING igen?"
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
 * MÅLET ÄR NU BANKKONTOT (#F034c). Fram till dess var det organisationen, och
 * den gränsen stod som en uttrycklig kvarstående lucka i #F034b:s leverans —
 * två verkliga betalningar med identiska fält på OLIKA konton i samma
 * organisation var oskiljbara, och den andra räknades som dubblett.
 *
 * `mål` är ett VERIFIERAT `BankAccount.id`. Anroparen har låtit servern
 * kontrollera ägandet mot organisationen innan avtrycket räknas; den här
 * funktionen har ingen databas att fråga och kan inte göra det åt den.
 *
 * FÖLJDEN ÄR AVSIKTLIG: samma fil mot TVÅ konton är två skilda importer och
 * blockerar inte varandra. Samma fil mot SAMMA konto är en import, och det är
 * den frågan filnivåskyddet finns för att besvara.
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
// V2 SEDAN #F034c: namnrymden bumpades när MÅLKONTOT kom in i identiteten.
//
// Bumpen är inte kosmetisk. En rad som skrevs av #F034b bär en V1-hash över
// samma fält UTAN konto. Hade V2 återanvänt namnet hade två olika fältmängder
// delat namnrymd, och en V1-nyckel kunnat kollidera med en V2-nyckel som
// betyder något annat. Med bumpen är de två mängderna disjunkta, och en
// V1-rad kan aldrig av misstag läsas som en V2-rad.
//
// Följden — att en #F034b-rad inte längre får samma hash som samma betalning
// importerad i dag — är avsiktlig och ofarlig: fält-dedupens LÄSNING är kvar
// som första lager och ser dem ändå (den frågar efter fälten, inte hashen).
const NAMNRYMD_FIL = 'FIL_V2_KONTO'
const NAMNRYMD_BGMAX = 'BGMAX_V2_KONTO'

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
 * ── EN KÄLLA FÖR BÅDA LAGREN (rättar T1:s fynd F1) ──────────────────────────
 *
 * Fält-dedupens `where` och radidentitetens hash MÅSTE fråga efter samma
 * fältmängd. Första versionen skrev dem som två objektliteraler i rad på
 * anropsstället, med en kommentar om att de var lika. Terminal 1:s läsgranskning
 * pekade ut vad det betyder: *"En regel som frågar prosa i stället för kod är
 * alltid uppfylld."*
 *
 * ── FELLÄGET DE BESKREV, OCH VARFÖR DET ÄR VERKLIGT ─────────────────────────
 *
 * Läggs ett fält till i `dedup` men inte i hashen får två rader som skiljer sig
 * BARA i det fältet samma `identityKey`. Fil A lagrar den ena som `(K, 0)`.
 * Fil B bär den andra: dess räknare börjar om, så den får också `seq = 0`,
 * lager 1 räknar med det nya fältet och hittar noll — och lager 2 möter `(K, 0)`
 * som redan finns, kastar P2002, och raden räknas som DUBBLETT. En verklig,
 * skild betalning försvinner tyst. Det är exakt det felläge #F034b finns för att
 * ta bort, återinfört från andra hållet.
 *
 * Motsatt riktning är lika illa: tas ett fält BORT ur `dedup` blir lager 1
 * lösare och avvisar som dubblett innan lager 2 ens tillfrågas.
 *
 * ── LÖSNINGEN: `dedup` HÄRLEDS UR SAMMA OBJEKT SOM HASHEN ───────────────────
 *
 * Funktionerna nedan returnerar BÅDA. Det finns alltså ingen anropsplats där de
 * två kan skrivas olika, och fältmängden står på ETT ställe.
 *
 * Att de två uttrycken inuti funktionen fortfarande kan glida isär bärs av
 * `bank-import-identitet-paritet.spec.ts`, som STÖR varje fält i tur och ordning
 * och kräver att störningen syns i BÅDA — alltså en mekanisk mätning av att
 * hashens fältmängd och `where`-satsens fältmängd är samma mängd, inte ett
 * påstående om det.
 */

/**
 * MÅLKONTOT (#F034c) — det första ledet i varje radidentitet.
 *
 * Ett VERIFIERAT `BankAccount.id`. Anroparen har låtit servern kontrollera att
 * kontot tillhör organisationen; identitetsmodulen tar emot ett id och litar på
 * det, eftersom den inte har någon databas att fråga.
 *
 * ── VARFÖR KONTOT LIGGER FÖRST OCH INTE SIST ────────────────────────────────
 *
 * Bara läsbarhet i en felsökning: kanoniseringen är en JSON-array, så ordningen
 * spelar ingen roll för entydigheten. Men en hash som börjar med kontot går att
 * gruppera på i huvudet när man läser två nycklar bredvid varandra.
 */
export type Målkonto = string

/** Fälten CSV/XLSX/XLS och PDF-bekräftelsen identifierar en rad med. */
export interface FilRadFält {
  /** Verifierat BankAccount.id. Obligatoriskt — se `Målkonto`. */
  bankAccountId: Målkonto
  date: Date
  description: string
  amount: Decimal
  /** Tomt värde är ett EGET värde, aldrig en joker. Se F034. */
  reference: string | null
}

/** Fälten BgMax identifierar en rad med. */
export interface BgMaxRadFält {
  /** Verifierat BankAccount.id. Obligatoriskt — se `Målkonto`. */
  bankAccountId: Målkonto
  date: Date
  amount: Decimal
  rawOcr: string | null
}

export interface Radidentitet {
  /** Fält-dedupens `where`, utan `organizationId` (injiceras av kärnan). */
  dedup: Prisma.BankTransactionWhereInput
  /** SHA-256 över samma fält, i den form det unika indexet kan bära. */
  key: string
}

/**
 * CSV/XLSX/XLS och PDF-bekräftelsen. Fälten är EXAKT dem respektive vägs
 * fält-dedup frågade efter före #F034b — F034:s identitet, oförändrad. Inget
 * fält är tillagt och inget borttaget.
 */
export function filIdentitet(rad: FilRadFält): Radidentitet {
  return {
    dedup: {
      bankAccountId: rad.bankAccountId,
      date: rad.date,
      description: rad.description,
      amount: rad.amount,
      reference: rad.reference,
    },
    key: sha256(
      kanonisera([
        NAMNRYMD_FIL,
        rad.bankAccountId,
        datum(rad.date),
        rad.description,
        belopp(rad.amount),
        text(rad.reference),
      ]),
    ),
  }
}

/**
 * BgMax. `description` ingår INTE — den är syntetisk (`BgMax inbetalning (OCR
 * …)`) och att hålla den utanför är det som gör att samma betalning importerad
 * via både BgMax och CSV känns igen som en. `rawOcr` är en RÅ teckenposition i
 * fastformatet, inte ett härlett värde, och kan därför inte drifta mellan
 * kodversioner.
 */
export function bgMaxIdentitet(rad: BgMaxRadFält): Radidentitet {
  return {
    dedup: {
      bankAccountId: rad.bankAccountId,
      date: rad.date,
      amount: rad.amount,
      rawOcr: rad.rawOcr,
    },
    key: sha256(
      kanonisera([
        NAMNRYMD_BGMAX,
        rad.bankAccountId,
        datum(rad.date),
        belopp(rad.amount),
        text(rad.rawOcr),
      ]),
    ),
  }
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
