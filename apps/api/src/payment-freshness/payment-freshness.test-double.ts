/**
 * TESTDUBBEL för `PaymentFreshnessService` — EN definition, för avstämningens
 * specar.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * G2-AVSLUT gav tjänsten två metoder som avstämningens SKRIVVÄGAR nu anropar:
 * `lasOrdningForOlostGranskning` (det exklusiva organisationslåset) och
 * `oppnaGranskningsperiod`. Följden är att specar som tidigare kunde skicka
 * `{} as never` — med kommentaren "ej använd i unmatch-vägen" — plötsligt föll
 * på `undefined is not a function`.
 *
 * Formerna som fanns: `{} as never` med kommentaren "ej använd i unmatch-vägen",
 * en `Proxy` som kastade 'freshness orört', och två olika delmängdsattrapper.
 * Var och en hade behövt sin egen lapp, och nästa spec som rör en skrivväg hade
 * behövt ännu en. Kodbasens egen läxa är att en regel som skrivs på flera
 * ställen glider isär; samma sak gäller en attrapp.
 *
 * HUR MÅNGA SPECAR DET GÄLLER STÅR INTE HÄR, med flit. Den här noten sa först
 * "fyra", vilket var sant om de fyra jag hade framför mig när jag skrev den och
 * fel så fort mängden växte — och jag sa "nio" i ett meddelande samtidigt, om
 * en TREDJE mängd (de som föll i CI, varav flera löstes på annat sätt). Tre tal
 * för vad som lät som samma sak. Funnet av terminal 1.
 *
 * Det som är kontrollerbart står i stället i filerna själva:
 *
 *     grep -rl "payment-freshness.test-double" apps/api/src --include=*.spec.ts
 *
 * En importlista går att räkna om; en siffra i ett docblock åldras tyst.
 *
 * ── VARFÖR SÖKVÄGEN OCH INTE SYMBOLNAMNET ───────────────────────────────────
 *
 * Kommandot har varit fel två gånger, åt var sitt håll, och den andra gången
 * var värre än den första.
 *
 *   grep -rl "färskhetsdubbel"          ÖVER-rapporterar: en spec som bara
 *                                        NÄMNER dubbeln i en kommentar kommer med
 *   grep -rlE "^import .*färskhetsdubbel"  UNDER-rapporterar: en FLERRADIG import
 *                                        (prettier delar raden så fort någon
 *                                        lägger till ett andra namn) matchar inte,
 *                                        eftersom symbolen inte står på
 *                                        `import`-raden
 *
 * RIKTNINGEN ÄR HELA POÄNGEN. Över-rapportering visar en fil för mycket, och
 * den som tittar på listan ser den. Under-rapportering DÖLJER en fil och listan
 * ser korrekt ut — samma asymmetri som resten av det här arbetet: den tysta
 * nollan är värre än den högljudda felträffen.
 *
 * Modulsökvägen står bara i en import, oavsett formatering. Mätt mot fyra
 * konstruerade fall (kommentar, enradig, flerradig, typ-import före) av terminal
 * 1 och kontrollerat om av mig: sökvägsvarianten är rätt i alla fyra. De tre
 * varianterna ger samma åtta filer i dag — skillnaden är bara vilket håll
 * kontrollen kan falla åt sedan.
 *
 * ── VAD DEN GÖR, OCH VAD DEN INTE PÅSTÅR ────────────────────────────────────
 *
 * Den är TILLÅTANDE: inget lås tas, ingen period öppnas, ingen avisering
 * försöks. Den svarar "ingen paus pågår" på allt.
 *
 * Den bevisar alltså INGENTING om pausen. Pausens och låsordningens beteende
 * mäts mot RIKTIGA tjänster och riktig Postgres i
 * `kravpaus-samtidighet.db.spec.ts` — det är den enda filen som får uttala sig
 * om dem. Den här dubbeln finns bara för att specar som mäter NÅGOT ANNAT inte
 * ska falla på en tjänst de inte bryr sig om.
 *
 * En kastande attrapp vore fel här: den hade gjort varje skrivväg beroende av
 * att provförfattaren känner till färskhetstjänsten.
 */
export function färskhetsdubbel(): Record<string, unknown> {
  return {
    recordImportStarted: async () => undefined,
    recordPaymentDataThrough: async () => undefined,
    assertAutomaticEffectAllowed: async () => undefined,
    assertIngenOlostIdentitetsgranskning: async () => undefined,
    raknaOlostIdentitetsgranskning: async () => 0,
    pausadeAvGranskning: async () => new Set<string>(),
    evaluateAndAlert: async () => new Set<string>(),
    // G2-AVSLUT — de två som skrivvägarna anropar.
    lasOrdningForOlostGranskning: async () => undefined,
    /** `null` = "en paus pågick redan" → ingen avisering försöks. */
    oppnaGranskningsperiod: async () => null,
    avslutaGranskningsperiodOmLost: async () => false,
    aviseraGranskningspaus: async () => ({
      period: null,
      notisSkapad: false,
      mejlKoat: false,
    }),
    sveparGranskningspauser: async () => ({ behandlade: 0 }),
  }
}
