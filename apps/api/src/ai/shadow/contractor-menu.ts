import type { MaintenanceCategory } from '@prisma/client'

/**
 * HANTVERKARMENYN — vilka agenten får föreslå, och hur de beskrivs.
 *
 * ── SAMMA LÄRDOM SOM VERKTYGSMENYN ──────────────────────────────────────────
 *
 * Verktygen stod en gång som en naken namnlista, och modellen valde
 * `create_inspection` 29 gånger mot facits 4 — den läste NAMNET. Etiketterna
 * hämtas därför ur katalogen. Ett hantverkarregister som skickas som rena UUID:n
 * har exakt samma defekt, fast värre: ett id bär ingen betydelse alls, så
 * modellen kan bara gissa eller hitta på.
 *
 * Menyn är därför `id` + en LÄSBAR etikett (namn och yrkeskategorier), och
 * enumen i schemat är id:na — modellen kan bara välja ett som finns.
 *
 * ── FILTRERAT PÅ ÄRENDETS KATEGORI ──────────────────────────────────────────
 *
 * `Contractor.categories` är samma `MaintenanceCategory` som ärendet, aldrig en
 * egen lista. Menyn är därför snittet: hantverkare som faktiskt gör den sortens
 * jobb. En rörmokare i menyn för ett elärende är inte en valmöjlighet, det är en
 * felkälla — och att låta modellen filtrera själv vore att be den om ett svar vi
 * redan har.
 *
 * ── TOMT REGISTER ÄR ETT EGET SVAR ──────────────────────────────────────────
 *
 * Har organisationen ingen hantverkare för kategorin UTELÄMNAS fältet ur
 * schemat helt. Ett tomt `enum: []` är inte tillåtet i JSON Schema, och ett
 * fritextfält hade bjudit in precis den hallucination hela konstruktionen finns
 * för att omöjliggöra. I stället får agenten FRÅGA — se `FRAGA_LAGG_TILL`.
 */
export interface Hantverkarpost {
  id: string
  name: string
  categories: MaintenanceCategory[]
}

export interface Menypost {
  id: string
  /** Vad modellen läser: namn och vad hen gör. Aldrig bara ett id. */
  etikett: string
}

/**
 * Menyn för ETT ärende: organisationens aktiva hantverkare som gör den sortens
 * jobb.
 *
 * Ren funktion, ingen databas — samma skäl som `skuggverktygForFelanmalan`: den
 * går att pröva ensam mot påhittade poster, utan en halv Nest-graf.
 */
export function hantverkarmeny(
  register: readonly Hantverkarpost[],
  kategori: MaintenanceCategory,
): Menypost[] {
  // ── `OTHER` ÄR INGEN KATEGORI, DET ÄR FRÅNVARON AV EN ──────────────────
  //
  // Ett ärende registrerat som `OTHER` betyder att portalen inte kunde
  // klassificera det — inte att ingen hantverkare gör den sortens jobb. Att
  // filtrera på det värdet ger en TOM meny, och agenten kan då aldrig tilldela
  // ett ärende vars kategori den själv är satt att avgöra.
  //
  // Uppmätt på mätkorpusen: av 29 ärenden där facit pekar ut en hantverkare är
  // SEX registrerade som `OTHER` (k01, k21, k33, k38, k49) eller
  // `COMMON_AREAS` (k15) medan facit säger PLUMBING/ELECTRICAL/FACADE. Med ett
  // filter på det registrerade värdet blir fem av dem strukturellt omöjliga —
  // och talet hade mätt portalens klassificering, inte agentens.
  //
  // Samma lärdom som prioritetsgolvet (#831): den registrerade kategorin är ett
  // PÅSTÅENDE, inte ett faktum. Vid `OTHER` visas därför hela registret, och
  // etiketterna bär yrkeskategorierna så modellen kan välja rätt.
  //
  // `COMMON_AREAS` är däremot en RIKTIG kategori — ett trapphus är inte "okänt"
  // — och filtreras som alla andra. `k15` (lysrör i tvättstugan) förblir
  // därmed omöjlig, och det är rätt: hyresvärden har registrerat ärendet som
  // gemensamt utrymme och har ingen hantverkare för det.
  const relevanta =
    kategori === 'OTHER' ? register : register.filter((h) => h.categories.includes(kategori))
  return relevanta.map((h) => ({
    id: h.id,
    // KATEGORIERNA STÅR MED även om menyn redan är filtrerad. En hantverkare
    // som gör både VVS och värme är ett annat val än en som bara gör VVS, och
    // den skillnaden ska modellen kunna läsa.
    etikett: `${h.name} (${h.categories.join(', ')})`,
  }))
}

/**
 * Frågan när registret är tomt för kategorin.
 *
 * ── ETT ALTERNATIV SOM ÄR EN HANDLING, INTE ETT VÄRDE ───────────────────────
 *
 * Övriga frågor väljer mellan värden ur ett register. Den här kan inte: mängden
 * är tom, och det ÄR svaret. Alternativet pekar därför på det enda som löser
 * frågan — att lägga till en hantverkare — och läsytan gör det till en länk.
 *
 * Värdet är en SENTINEL och inget id. Ett påhittat id hade sett ut som ett val
 * och blivit en främmande nyckel som inte pekar någonstans.
 */
export const LAGG_TILL_HANTVERKARE = 'LAGG_TILL_HANTVERKARE'

/**
 * Det ANDRA alternativet, och skälet att det finns.
 *
 * En fråga med ETT alternativ är inget val — `ärGiltigFråga` kräver två till
 * fyra av just det skälet, och att göra ett undantag här hade urholkat regeln
 * för alla fält. Men undantaget behövdes aldrig: "jag gör det själv" är ett
 * riktigt svar på "vem ska göra jobbet", och det är dessutom det vanligaste
 * svaret hos en hyresvärd som förvaltar själv.
 *
 * De två alternativen leder till OLIKA saker — det ena till en ny post i
 * registret, det andra till att ärendet hanteras utan hantverkare — vilket är
 * precis vad `nytta`-fältet kräver för att frågan alls ska få ställas.
 */
export const INGEN_HANTVERKARE_BEHOVS = 'INGEN_HANTVERKARE_BEHOVS'

/**
 * Alternativen när registret är tomt. EN uppräkning, läst av både frågeregeln
 * och läsytan — två listor som ska betyda samma sak är inte en lista.
 */
export const TOMT_REGISTER_ALTERNATIV: readonly string[] = [
  LAGG_TILL_HANTVERKARE,
  INGEN_HANTVERKARE_BEHOVS,
]

/** Rutten läsytan skickar hyresvärden till. Verifierad mot `router.tsx`. */
export const HANTVERKARRUTT = '/hantverkare'

/**
 * ── GRINDEN FÖRE LAGRING ────────────────────────────────────────────────────
 *
 * Schemats `enum` gör det strukturellt omöjligt för modellen att svara ett id
 * som inte står i menyn — men den spärren bor hos LEVERANTÖREN. En modellbyte,
 * en providerväxel eller ett schema som råkar byggas utan meny tar bort den utan
 * att något blir rött här.
 *
 * Den här funktionen är den spärr som bor i VÅR kod. Den prövar exakt två saker,
 * och båda är fel som skulle skriva en främmande nyckel i kundens data:
 *
 *   1. Id:t finns i menyn — alltså i RÄTT ORGANISATION. En hantverkare från en
 *      annan kund i ett förslag är en läcka mellan kunder, och den ska stoppas
 *      innan raden skrivs, inte upptäckas efteråt.
 *   2. Menyn är byggd på ärendets kategori, så samma kontroll ger RÄTT YRKE på
 *      köpet: en rörmokare kan inte hamna på ett elärende.
 *
 * @returns id:t när det är giltigt, annars `undefined` — fältet UTELÄMNAS då.
 *   Att avvisa hela förslaget hade kastat bort en riktig kategori, prioritet och
 *   åtgärd för ett VALFRITT fälts skull.
 */
export function godkandHantverkare(
  föreslaget: unknown,
  meny: readonly Menypost[],
): string | undefined {
  if (typeof föreslaget !== 'string' || föreslaget === '') return undefined
  return meny.some((m) => m.id === föreslaget) ? föreslaget : undefined
}
