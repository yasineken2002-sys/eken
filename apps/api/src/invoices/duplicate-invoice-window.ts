/**
 * FÖNSTRET MOT OAVSIKTLIGA DUBBLETTER PÅ ICKE-HYRESFAKTUROR.
 *
 * ── VARFÖR ETT FÖNSTER OCH INTE EN NYCKEL ───────────────────────────────────
 *
 * Två identiska serviceavgifter på samma avtal är i domänen två legitima krav —
 * "Reparation av lås" 1 500 kr kan gälla två lås. Ingenting i datan skiljer dem
 * åt, så en nyckel hade fabricerat en skillnad som inte finns.
 *
 * ── VARFÖR GRENEN INTE KUNDE STÅ TOM ────────────────────────────────────────
 *
 * `InvoicesService.create` bokför intäktsverifikatet i SAMMA transaktion som
 * fakturan — även för ett utkast (T5 A1, BFL 5:6). En oavsiktlig dubblett
 * dubbelbokför alltså intäkten och kundfordran. Det är inte en extra rad i en
 * lista utan ett fel i huvudboken, och det skiljer posten från
 * `create_inspection`, där ingen spärr byggdes just för att effekten är rent
 * intern.
 *
 * ── ASYMMETRIN GÅR ÅT BÅDA HÅLL, TILL SKILLNAD FRÅN FELANMÄLAN ──────────────
 *
 * För grovt = en verklig andra avgift försvinner tyst, hyresgästen
 * underdebiteras och intäkten uteblir. För fint = dubbelbokföring. Båda är
 * bokföringsfel, och ingendera riktningen är den "säkra". Därför både ett SMALT
 * fönster och ett SVAR i stället för ett tyst hopp: en verklig andra avgift ska
 * gå att skriva om.
 *
 * ── TALET ÄR RESONERAT, INTE MÄTT ───────────────────────────────────────────
 *
 * Uppmätt 2026-09-02: produktionen har NOLL fakturor. Det finns alltså ingen
 * historik att härleda ur.
 *
 *   • Det som MÅSTE fångas är ett omtag inom samma modellvarv. Verktyget självt
 *     tar millisekunder (AiToolExecution p95 = 51 ms i prod).
 *   • Det som ALDRIG får fångas är två skilda avgifter. Två avgifter med exakt
 *     samma belopp OCH samma förfallodag skrivs inte av en människa på en minut.
 *
 * 60 sekunder, samma tal som felanmälningsfönstret och av samma skäl — men det
 * är inte en kopiering: storheten är densamma (ett modellvarv mot en människas
 * skrivtakt). Den dag det finns fakturor i produktion ska talet räknas om ur
 * dem: mät tiden mellan par med samma (avtal, typ, belopp, förfallodag).
 */
export const DUBBLETT_FAKTURA_FONSTER_MS = 60_000
