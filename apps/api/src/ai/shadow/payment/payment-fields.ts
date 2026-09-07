import { SKUGGFALT, type Skuggfalt } from '../shadow-fields'

/**
 * SKUGGAGENT 2 — "PENGAR IN". FÄLTEN SOM JÄMFÖRS MED FACIT.
 *
 * ── VARFÖR EN EGEN MÄNGD OCH INTE `SKUGGFALT` ───────────────────────────────
 *
 * `SKUGGFALT` är felanmälans tre fält (kategori, prioritet, hantverkare). De
 * här tre svarar på en annan fråga om ett annat objekt, och att vidga den
 * befintliga mängden hade varit exakt det lån CLAUDE.md varnar för: ett fält
 * som betyder "det här jämförs med facit" skulle då betyda två olika saker
 * beroende på vilken rad man tittar på, och `FRAGEBARA_NYCKLAR`,
 * delegationsförslagen och `typenFörFörslaget` härleder alla beteende ur den.
 *
 * Jämförelsehjälparna DELAS däremot (`jamforSkuggfalt`, `traffgradPerFalt` tar
 * numera en fältlista). Det är mekaniken som är gemensam, inte mängden.
 *
 * ── OCH VARFÖR FACIT ÄR HÅRDARE HÄR ÄN FÖR AGENT 1 ──────────────────────────
 *
 * Agent 1:s facit är en BEDÖMNING — kategori och prioritet går att diskutera,
 * och tre fall i mätkorpusen omprövades av just det skälet. Agent 2:s facit är
 * ett FAKTUM: en betalning hör till en avi eller inte. Det gör måttet skarpare
 * och kontamineringsrisken VÄRRE, eftersom förslaget står bredvid raden när
 * människan väljer. Samma förbehåll som i `shadow-outcome.service.ts`, med
 * större kraft — och det går fortfarande inte att avgöra ur databasen.
 */
export const SKUGGFALT_BETALNING: readonly Skuggfalt[] = [
  { nyckel: 'avi', etikett: 'Avi eller faktura' },
  { nyckel: 'belopp', etikett: 'Belopp' },
  { nyckel: 'motpart', etikett: 'Motpart' },
]

export const SKUGGFALT_BETALNING_NYCKLAR: readonly string[] = SKUGGFALT_BETALNING.map(
  (f) => f.nyckel,
)

/**
 * Skuggkällan för en bankrad.
 *
 * En sträng och ingen enum, av samma skäl som `SKUGGKALLA_FELANMALAN`: schemats
 * `sourceKind` är en `String?`, och det partiella unika indexet
 * `(organizationId, sourceKind, sourceId) WHERE shadow` bär idempotensen utan
 * att veta vilka värden som finns. En ny källa kräver därför ingen migration.
 */
export const SKUGGKALLA_BANKRAD = 'BANK_TRANSACTION'

/**
 * "Ingen avi passar." ETT VÄRDE, inte frånvaron av ett.
 *
 * `null` hade betytt "agenten svarade inte" — och `jamforSkuggfalt` räknar
 * null på någondera sidan som "räknas inte". Ett aktivt nej måste kunna vara
 * en TRÄFF: när facit säger att bankraden aldrig hörde till någon avi och
 * agenten sa samma sak, är det agentens bästa svar och ska mätas som ett.
 */
export const INGEN_AVI = 'INGEN'

/** Motparten gick inte att knyta till en hyresgäst. Samma resonemang som ovan. */
export const OKAND_MOTPART = 'OKAND'

/** Reglerar betalningen hela det utestående beloppet, eller en del av det? */
export type Beloppsutfall = 'FULL' | 'DEL'

/**
 * Fälten är TRE och de är olika mycket värda — men vikten hör hemma i läsytan
 * och i rapporten, aldrig i jämförelsen. Den här mängden säger bara VAD som
 * jämförs.
 */
export const SKUGGFALT_ALLA: readonly Skuggfalt[] = [...SKUGGFALT, ...SKUGGFALT_BETALNING]
