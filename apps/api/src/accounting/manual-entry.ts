/**
 * KONTERINGEN FÖR ETT MANUELLT VERIFIKAT OCH EN UTGIFT — EN GÅNG, INTE TVÅ.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `create_journal_entry` och `record_expense` var två av sju AI-verktyg utan
 * mänsklig väg (`tool-human-path.baseline.json`): AI:n kunde bokföra en
 * verifikation som hyresvärden inte kunde bokföra själv. Delmängdsregeln säger
 * att människan ska kunna minst lika mycket — inte att koden ska dupliceras.
 *
 * Den naiva lagningen är en andra implementation bakom en ny endpoint. Den hade
 * varit fel av ett skäl som är mätbart och inte principiellt: kontovalen
 * (1930/2641), momsdelningen och balanskravet hade då stått på TVÅ ställen, och
 * två uppräkningar som ska vara lika är inte en uppräkning. Den dag någon byter
 * bankkonto eller momskonto i den ena hade AI-vägen och människovägen bokfört
 * OLIKA — och ingenting hade blivit rött.
 *
 * Funktionerna här är därför RENA: de tar kontoplanen som en uppslagning och
 * returnerar antingen rader eller ett fel. Både `AccountingService`
 * (människovägen) och `ToolExecutorService` (AI-vägen) bygger sina rader genom
 * dem.
 *
 * ── KONTERINGEN ÄR DELAD. SKRIVNINGEN ÄR DET INTE. ──────────────────────────
 *
 *     kontering (konton, moms, balans)   DELAD — de här funktionerna
 *     skrivning (nummer, idempotens)     DELAD — createNumberedEntry
 *
 * BÅDA raderna är delade sedan #790. Stycket här sa fram till dess att
 * skrivningen var två vägar, med varningen att "en NY spärr i
 * `createNumberedEntry` skulle bara gälla den ena". Den varningen gällde, och
 * den är nu inlöst: AI-vägens egen `$transaction` är BORTTAGEN, och båda
 * vägarna går ut i `createNumberedEntry` — som äger balansgrinden (C1),
 * org-scopingen av idempotensnyckeln (C0), det gap-fria numret och
 * race-återhämtningen vid P2002.
 *
 * AI-vägen skickar med en `efterSkrivning`-hook som skriver utförandespåret i
 * samma transaktion som effekten (G0).
 *
 * ── VAD SOM MEDVETET INTE DELAS ─────────────────────────────────────────────
 *
 * `source` och `sourceId`. AI-vägen skriver `source: 'AI'` med en nyckel härledd
 * ur åtgärdens innehåll (`aiJournalSourceId`), människovägen `source: 'MANUAL'`
 * med sin egen. Det är AVSIKTLIGT två namnrymder: idempotensen gäller per
 * `(org, source, sourceId)`, så en hyresvärd som medvetet bokför samma belopp
 * som AI:n nyss bokförde ska få ett EGET verifikat — inte tystas bort som en
 * dubblett av något hen inte gjorde. Att slå ihop namnrymderna hade gjort en
 * spärr mot dubbletter till en spärr mot riktigt arbete.
 *
 * ── VAD FILEN INTE KAN SE ───────────────────────────────────────────────────
 *
 * Att båda vägarna faktiskt ANROPAR den. Det ägs av `check-tool-human-path.mjs`
 * (R5b) för människovägens existens, och av `manual-entry.spec.ts` som matar in
 * samma indata i båda riktningarna och kräver identiska rader.
 */

/** Uppslagning kontonummer → kontots id, byggd av anroparen ur kontoplanen. */
export type Kontouppslag = ReadonlyMap<number, string>

/**
 * Kontoplanen som nummer → id.
 *
 * REN funktion, inte en tjänstemetod. Den formen är vald med flit: en metod på
 * `AccountingService` hade gjort tjänsten till ett BEROENDE för AI-vägen, och
 * det beroendet mättes — tre specrigg:ar som bygger `ToolExecutorService` med
 * attrapper föll på `kontouppslag is not a function`. Ett delat regelverk ska
 * inte kosta en ny DI-kant; funktionen tar därför raderna och båda vägarna
 * hämtar dem själva.
 */
export function kontouppslagAv(
  konton: ReadonlyArray<{ id: string; number: number }>,
): Kontouppslag {
  return new Map(konton.map((k) => [k.number, k.id]))
}

export interface Verifikatrad {
  accountId: string
  debit?: number
  credit?: number
  description?: string
}

/** Indata per rad i ett fritt verifikat, så som både DTO:n och verktyget ger den. */
export interface RadIndata {
  accountNumber: number
  debit?: number | undefined
  credit?: number | undefined
  description?: string | undefined
}

export type Byggutfall =
  | { ok: true; rader: Verifikatrad[]; summa: number }
  | { ok: false; fel: string }

/**
 * BALANSEN JÄMFÖRS I HELA ÖREN, INTE MED EN TOLERANS.
 *
 * Den inline-kod den här filen ersatte skrev `Math.abs(debet - kredit) > 0.01`,
 * alltså en SLACK på ett öre. Den slacken var fel, och felet syntes först när
 * ett prov skrevs på den: en obalans på exakt ett öre passerade kontrollen och
 * slogs sedan ned av `createNumberedEntry`s C1-grind, som räknar i `Decimal`
 * och har NOLL tolerans. Utfallet blev ett kastat 422 i stället för det
 * begripliga meddelandet den här funktionen finns för att ge.
 *
 * Nu jämförs beloppen som HELTAL ÖREN. Det är exakt samma granularitet som
 * kolumnernas `Decimal(10,2)`, och det är immunt mot flyttalsbruset som gjorde
 * en tolerans lockande från början (`1000 - 999.99` är `0.00999999999999`, inte
 * `0.01`). Ett öre är ett fel; en tolerans hade bara flyttat gränsen för vad som
 * får vara fel.
 */
function ioren(v: number): number {
  return Math.round(v * 100)
}

/** Kvar för utgiftsvägens jämförelse moms ≤ belopp, där en slack är rimlig. */
const ORE = 0.01

/** Kontona utgiftsvägen konterar mot. Namngivna, inte inströdda som magiska tal. */
export const KONTO_BANK = 1930
export const KONTO_INGAENDE_MOMS = 2641

/**
 * Fritt verifikat: rad för rad mot kontoplanen, med balanskravet.
 *
 * Felmeddelandena är på svenska och SPECIFIKA — de går rakt ut i ett 400-svar
 * till hyresvärden respektive tillbaka till AI:n. "Ogiltig indata" hade tvingat
 * båda att gissa vilken rad som var fel.
 */
export function byggVerifikatrader(rader: readonly RadIndata[], konton: Kontouppslag): Byggutfall {
  if (rader.length < 2) {
    return { ok: false, fel: 'Ett verifikat behöver minst två konteringsrader.' }
  }

  const ut: Verifikatrad[] = []
  let debet = 0
  let kredit = 0

  for (const rad of rader) {
    const accountId = konton.get(rad.accountNumber)
    if (!accountId) {
      return {
        ok: false,
        fel: `BAS-konto ${rad.accountNumber} finns inte i kontoplanen. Lägg till det först eller välj ett befintligt konto.`,
      }
    }
    const d = typeof rad.debit === 'number' && rad.debit > 0 ? rad.debit : 0
    const k = typeof rad.credit === 'number' && rad.credit > 0 ? rad.credit : 0
    if (d === 0 && k === 0) {
      return { ok: false, fel: `Rad mot konto ${rad.accountNumber} saknar både debet och kredit.` }
    }
    if (d > 0 && k > 0) {
      return {
        ok: false,
        fel: `Rad mot konto ${rad.accountNumber} har både debet och kredit — använd separata rader.`,
      }
    }
    debet += d
    kredit += k
    ut.push({
      accountId,
      ...(d > 0 ? { debit: d } : {}),
      ...(k > 0 ? { credit: k } : {}),
      ...(rad.description ? { description: rad.description } : {}),
    })
  }

  if (ioren(debet) !== ioren(kredit)) {
    return {
      ok: false,
      fel: `Verifikatet balanserar inte: debet ${formatBelopp(debet)} kr, kredit ${formatBelopp(kredit)} kr.`,
    }
  }

  return { ok: true, rader: ut, summa: debet }
}

export interface UtgiftIndata {
  /** BRUTTO — det som lämnar bankkontot. Momsen ingår och bryts ut nedan. */
  belopp: number
  /** Momsbeloppet i kronor, inte satsen. 0 eller utelämnat = ingen momsrad. */
  moms?: number | undefined
  /** Kostnadskontot, t.ex. 5070 Reparationer. */
  kontonummer: number
  beskrivning: string
}

/**
 * Utgift: kostnad (netto) debet, moms debet om den finns, bank kredit (brutto).
 *
 * MOMSEN BRYTS UT UR BRUTTOBELOPPET, den läggs inte till. `belopp` är det som
 * faktiskt lämnar 1930, alltså det som står på kvittot; nettot är `belopp − moms`.
 * Den som läser koden får se det uttryckligen, för den omvända tolkningen
 * (`belopp` = netto) ger ett verifikat som balanserar men bokför fel summa på
 * banken — ett fel som varken balansgrinden eller ett radprov kan se.
 */
export function byggUtgiftsrader(indata: UtgiftIndata, konton: Kontouppslag): Byggutfall {
  const { belopp, kontonummer, beskrivning } = indata
  const moms = indata.moms ?? 0

  if (!(belopp > 0)) {
    return { ok: false, fel: 'Beloppet måste vara större än noll.' }
  }
  if (moms < 0) {
    return { ok: false, fel: 'Momsbeloppet kan inte vara negativt.' }
  }
  if (moms > belopp + ORE) {
    return {
      ok: false,
      fel: `Momsen (${formatBelopp(moms)} kr) kan inte vara större än beloppet (${formatBelopp(belopp)} kr) — beloppet ska vara inklusive moms.`,
    }
  }

  const kostnadskonto = konton.get(kontonummer)
  if (!kostnadskonto) {
    return {
      ok: false,
      fel: `Kostnadskonto ${kontonummer} finns inte. Använd t.ex. 5070 (Reparationer) eller 5080 (Försäkring).`,
    }
  }
  const bankkonto = konton.get(KONTO_BANK)
  if (!bankkonto) {
    return {
      ok: false,
      fel: `Konto ${KONTO_BANK} (Företagskonto/Bank) saknas i kontoplanen. Lägg till standardkontoplan först.`,
    }
  }

  const netto = belopp - moms
  const rader: Verifikatrad[] = [
    { accountId: kostnadskonto, debit: netto, description: beskrivning },
    { accountId: bankkonto, credit: belopp, description: 'Betalning bank' },
  ]

  if (moms > 0) {
    const momskonto = konton.get(KONTO_INGAENDE_MOMS)
    if (!momskonto) {
      return {
        ok: false,
        fel: `Konto ${KONTO_INGAENDE_MOMS} (Ingående moms) saknas — kan inte bokföra moms separat.`,
      }
    }
    rader.push({ accountId: momskonto, debit: moms, description: 'Ingående moms' })
  }

  return { ok: true, rader, summa: belopp }
}

/** Samma format som verktygets `formatAmount` — två decimaler, punkt som avgränsare. */
function formatBelopp(v: number): string {
  return v.toFixed(2)
}
