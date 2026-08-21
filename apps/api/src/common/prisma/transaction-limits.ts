/**
 * TRANSAKTIONSGRÄNSERNA — regeln, inte bara talen (#488).
 *
 * Fram till nu stod samma regel på tre ställen och gällde på två: faktura- och
 * avi-vägen hade explicita 8 s / 3 s, medan bankavstämningens transaktioner
 * ärvde Prismas defaults (5 s / 2 s). Det var inte ett medvetet undantag — det
 * var att ingen skrev något.
 *
 * ── HUR TALEN HÄRLEDS ────────────────────────────────────────────────────────
 *
 * 1. MÄT vägens värsta fall mot riktig Postgres med SKARP `AccountingService`.
 *    Inte stubbad: en stubbad mätning utelämnar bokföringens rundor och
 *    underskattade med ~3x på båda betalvägarna (8,8 → 20,1 ms respektive
 *    5,7 → 16,5 ms). Det felet gjordes en gång och rättades i #288/#289.
 * 2. PROJICERA produktion = uppmätt × 10. Varje tur-och-retur går över nät i
 *    stället för loopback.
 * 3. `timeout` = minsta runda värde som ligger en storleksordning över det
 *    projicerade värsta fallet OCH klart under det som en människa läser som en
 *    hängning. Det är ett BAND, inte en multiplikator.
 * 4. `maxWait` = 3 s, oberoende av vägens körtid. Det är inte en funktion av
 *    medianen alls, utan ett omdöme om systemhälsa: är poolen slut så länge är
 *    det ett systemfel som ska synas, inte köas.
 *
 * ── VARFÖR BAND OCH INTE MULTIPLIKATOR ───────────────────────────────────────
 *
 * Ingen multiplikator producerar 8 000 för alla tre vägarna:
 *
 *   markAsPaid            projicerat värsta 356 ms →  8000/356 = 22,5x
 *   markAsPaidManually    projicerat värsta 830 ms →  8000/830 =  9,6x
 *   bankmatchningen       projicerat värsta 215 ms →  8000/215 = 37,2x
 *
 * Det beror inte på slarv utan på att 8 s inte är härlett ur någon ENSKILD vägs
 * tid. Det är det minsta runda talet i bandet mellan "en storleksordning över
 * det projicerade värsta fallet" (hundratals ms) och "det här ser ut som en
 * hängning" (tiotals sekunder). Vägarnas medianer skiljer sig med en faktor
 * två; bandet spänner en tiopotens. Skillnaden är brus inuti bandet.
 *
 * En regel formulerad som band förklarar varför SAMMA tal är rätt för vägar med
 * olika medianer — vilket en multiplikator inte kan. Skrivs multiplikatorn ned i
 * stället får nästa väg ett annat tal av fel skäl.
 *
 * ── RIKTNINGEN ÄR ATT LOSSA, INTE ATT STRAMA ─────────────────────────────────
 *
 * Prismas defaults (5 s / 2 s) är STRIKTARE än 8 s / 3 s. Att tillämpa regeln på
 * bankmatchningen gör den alltså mer tillåtande, inte mindre. Skälet står i de
 * ursprungliga kommentarerna: att avbryta en betalning som nästan är klar kostar
 * mer än att vänta en stund till. Ingen väg blir hårdare bevakad — bara likadant
 * bevakad.
 *
 * ── OM DU VILL ÄNDRA TALEN ───────────────────────────────────────────────────
 *
 * Höj för att en MÄTNING säger det, inte för att något tajmade ut. Ett timeout
 * som växer varje gång det slår är inget skydd — det är en eftergift som gör
 * nästa hängning längre. Mät om vägen enligt punkt 1–3 ovan och skriv siffran
 * här, med datum och vad som mättes.
 *
 * ── maxWait OCH POOLEN ───────────────────────────────────────────────────────
 *
 * `maxWait` är bindande bara om anslutningspoolen är mindre än antalet samtidiga
 * transaktioner. Prod sätter ingen `connection_limit` (varken i `DATABASE_URL`
 * eller i `PrismaService`), så Prisma använder sin default
 * `num_physical_cpus × 2 + 1`. Containern rapporterar `nproc = 48` (mätt
 * 2026-08-21 via `railway ssh`), alltså en pool på ~97 — inte de ~17 som #488
 * antog utifrån en gissning om 8 vCPU.
 *
 * RESERVATION: `nproc` visar vad containern SER, inte nödvändigtvis den
 * cgroup-kvot den får köra på. Men Prismas detektering läser samma källa, så
 * talen följs åt: `maxWait` är inte den bindande gränsen åt något håll. Skulle
 * poolen någon gång sättas explicit och lågt behöver punkt 4 omprövas.
 */

/** Prismas egna defaults, uttryckta så att de går att jämföra mot. */
export const PRISMA_DEFAULT_TX_LIMITS = { timeout: 5_000, maxWait: 2_000 } as const

/**
 * PENGAVÄGAR: radlås → läs → allokera → uppdatera status → skriv verifikat.
 *
 * Används av faktura-betalning, avi-betalning och bankavstämningens matchning —
 * tre vägar som gör samma sorts arbete och därför ska ha samma band. Se
 * härledningen ovan innan du rör talen.
 */
export const PAYMENT_TX_LIMITS = { timeout: 8_000, maxWait: 3_000 } as const

export type TransactionLimits = typeof PAYMENT_TX_LIMITS | typeof PRISMA_DEFAULT_TX_LIMITS
