/**
 * FÖR GROVT ÄR VÄRRE ÄN FÖR FINT HÄR — läs det innan du rör talet.
 *
 * ── VARFÖR INGEN INNEHÅLLSNYCKEL ────────────────────────────────────────────
 *
 * En nämnare måste kunna skilja två LEGITIMA upprepningar åt. Två felanmälningar
 * med samma rubrik på samma objekt KAN vara två verkliga fel: "Droppande kran" i
 * köket och "Droppande kran" i badrummet är samma sträng och två åtgärder. Ett
 * unikt index hade tyst kastat den andra.
 *
 * Och de två felen är inte lika stora. En SPÄRR som äter en verklig felanmälan
 * betyder att ett fel aldrig blir åtgärdat — ingen vet att det anmäldes. En
 * DUBBLETT betyder att någon läser samma sak två gånger. Därför är asymmetrin
 * inbyggd i varje val nedan: hellre en dubblett än ett tappat fel.
 *
 * ── TALET ÄR RESONERAT, INTE MÄTT — OCH DET STÅR HÄR MED FLIT ───────────────
 *
 * Storheten som skulle avgöra fönstret är "hur snabbt kan två VERKLIGA fel
 * anmälas för samma objekt". Den går inte att mäta i den här kodbasen i dag.
 * Uppmätt 2026-09-02:
 *
 *     MaintenanceTicket i produktion                          0
 *     MaintenanceTicket i dev (seed/test)                     7
 *     par med samma enhet OCH samma rubrik inom 24 h          0   (båda databaserna)
 *
 * Noll rader är inget underlag. Talet är alltså satt av resonemang, och därför
 * satt LÅGT:
 *
 *   • Det som MÅSTE fångas är ett omtag inom samma modellvarv — verktyget självt
 *     tar millisekunder (AiToolExecution p95 = 51 ms i prod), så ett upprepat
 *     anrop i samma tur ligger på ensiffriga sekunder.
 *   • Det som ALDRIG får fångas är två skilda fel. En människa som skriver två
 *     olika felanmälningar hinner inte göra det på en minut, men på fem kan hen
 *     mycket väl.
 *
 * 60 sekunder ligger en storleksordning över det första och under det andra.
 * Det är INTE härlett ur data, och den dagen produktionen har felanmälningar ska
 * talet räknas om ur dem — mät då tiden mellan par med samma (objekt, rubrik)
 * och lägg fönstret under den snabbaste verkliga.
 *
 * ── VARFÖR BARA AI-VÄGEN, INTE MaintenanceService ───────────────────────────
 *
 * Betalvägens fönster (`common/payments/duplicate-payment-window.ts`) sitter i
 * tjänsten och binder BÅDA anroparna, eftersom en dubbelsubmit från admin är
 * lika fel som en från AI:n.
 *
 * Här är det tvärtom. `MaintenanceService.create` används också av
 * hyresgästportalen, och det är just en hyresgästs andra anmälan som absolut
 * inte får ätas. Risken för ett OAVSIKTLIGT omtag bor i modellens loop, inte i
 * en människas formulär — så spärren bor där risken bor.
 */

/** Resonerat, inte mätt. Se docblocken. */
export const DUPLICATE_TICKET_WINDOW_MS = 60_000

/**
 * Rubriken jämförs normaliserad: gemener, kollapsat blanksteg, trimmad.
 *
 * Ett omtag skickar nästan samma sträng, inte exakt samma — modellen kan byta
 * versal eller lägga till ett mellanslag. Utan normalisering skulle fönstret
 * missa just det fall det finns för.
 */
export function normaliseraRubrik(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface DuplicateTicketClient {
  maintenanceTicket: {
    findMany(args: unknown): Promise<Array<{ id: string; ticketNumber: string; title: string }>>
  }
}

/**
 * Letar efter en felanmälan som med stor sannolikhet är samma handling en gång
 * till. Returnerar den, eller null.
 *
 * KASTAR INTE, och det är avsiktligt. Anroparen ska kunna svara med numret på
 * det befintliga ärendet — ett tyst hopp hade sett ut som ett lyckat skapande,
 * och det är precis den defekt som gör ett tappat fel osynligt.
 *
 * OBJEKTET ÄR ENHETEN OM DEN FINNS, ANNARS FASTIGHETEN. Två anmälningar på samma
 * fastighet men olika lägenheter är olika objekt och ska aldrig kollidera; en
 * anmälan utan enhet gäller huset som helhet.
 */
export async function hittaFärskDubblett(
  client: DuplicateTicketClient,
  args: {
    organizationId: string
    propertyId: string
    unitId?: string | undefined
    title: string
    nu?: Date
  },
): Promise<{ id: string; ticketNumber: string } | null> {
  const nu = args.nu ?? new Date()
  const sedan = new Date(nu.getTime() - DUPLICATE_TICKET_WINDOW_MS)

  // ── DATABASEN HÄMTAR KANDIDATERNA, NORMALISERINGEN AVGÖR ─────────────────
  //
  // Frågan filtrerar INTE på rubriken. Det var det första försöket
  // (`equals` + `mode: 'insensitive'`), och det föll på sitt eget prov: den
  // formen täcker skiftläge men inte INRE blanksteg, så "droppande   KRAN"
  // returnerade noll rader och JS-normaliseringen fick aldrig se dem. En
  // förbehandling som körs efter att urvalet redan gjorts kan inte bredda det.
  //
  // Kandidatmängden är dessutom liten per konstruktion: rader på ETT objekt
  // inom en minut. Att jämföra dem i JS kostar ingenting och låter EN
  // normaliseringsregel gälla — samma som i felmeddelanden och prov.
  const kandidater = await client.maintenanceTicket.findMany({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      // `null` betyder "gäller fastigheten", och är ett annat objekt än en enhet.
      unitId: args.unitId ?? null,
      createdAt: { gt: sedan },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, ticketNumber: true, title: true },
  })
  const sökt = normaliseraRubrik(args.title)
  const träff = kandidater.find((k) => normaliseraRubrik(k.title) === sökt)
  return träff ? { id: träff.id, ticketNumber: träff.ticketNumber } : null
}
