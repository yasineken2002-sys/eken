import type { Prisma } from '@prisma/client'

/**
 * OLÖST IDENTITETSGRANSKNING — EN definition, på ett ställe.
 *
 * ── VARFÖR EN EGEN FIL ──────────────────────────────────────────────────────
 *
 * Villkoret läses av tre olika lager: den centrala effektspärren i
 * `PaymentFreshnessService`, fakturans påminnelsecron i `NotificationsModule`,
 * och avstämningens egen operatörsvy. Skrevs det på tre ställen vore det tre
 * villkor som kan glida isär — och kodbasens egen läxa är att två kopior av en
 * regel divergerar tyst (`TENANT_CREDENTIAL_KEYS`, #453).
 *
 * Filen bär BARA en konstant och en typimport. Den drar alltså ingen tjänst in
 * i någon annan modul och kan inte skapa en modulcykel: färskhetstjänsten
 * importerar ett villkor, inte avstämningen.
 *
 * ── VAD VILLKORET ÄR, OCH VARFÖR PRECIS DET ─────────────────────────────────
 *
 *     identityReviewAt IS NOT NULL  AND  status = 'UNMATCHED'
 *
 * `identityReviewAt` ensam räcker INTE. Markeringen nollställs aldrig — den
 * säger vad IMPORTEN visste, och det ändras inte av att någon senare avgjorde
 * frågan (#F034c). Ett villkor på bara markeringen hade därför pausat
 * organisationen för evigt efter den första oavgjorda raden, och en paus som
 * aldrig kan släppa är inte en paus utan ett haveri.
 *
 * Statusen är det som bär SVARET. Verifierat mot samtliga skrivningar av
 * `BankTransaction.status` i `apps/api/src` — `reconciliation.service.ts` är
 * enda filen som skriver modellen:
 *
 *   skapad granskningsrad          → UNMATCHED   OLÖST (ingången)
 *   applyMatchToInvoice            → MATCHED     löst
 *   depositionsmatchning           → MATCHED     löst
 *   avimatchning                   → MATCHED     löst
 *   manualMatch                    → MATCHED     löst — människans ena utgång
 *   ignoreTransaction              → IGNORED     löst — människans andra utgång
 *   unmatchTransaction             → UNMATCHED   OLÖST IGEN, se nedan
 *
 * ── AVMATCHNING ÅTERÖPPNAR PAUSEN, OCH DET ÄR AVSIKTLIGT ────────────────────
 *
 * En granskningsrad som matchats manuellt och sedan avmatchats går tillbaka
 * till `UNMATCHED` med markeringen kvar, och räknas då som olöst igen.
 *
 * Det följer av definitionen, och det är rätt av två skäl. Det varsamma:
 * avmatchningen tar tillbaka människans svar, och raden är åter en oallokerad
 * betalning vars identitet aldrig fastställdes.
 *
 * Det bärande är strukturellt (terminal 1): hade avmatchning INTE återöppnat
 * pausen vore avmatchning en TYST FÖRBIGÅNG — matcha fel med flit, ångra dig,
 * och pausen är hävd utan att identiteten avgjorts. Den här riktningen är
 * alltså den enda som inte öppnar ett hål i spärren.
 *
 * Inget dödläge: raden har fortfarande båda utgångarna kvar.
 */
export const OLOST_IDENTITETSGRANSKNING = {
  identityReviewAt: { not: null },
  status: 'UNMATCHED',
} as const satisfies Prisma.BankTransactionWhereInput

/** Samma villkor, scopat till en organisation. */
export function olostGranskningForOrg(organizationId: string): Prisma.BankTransactionWhereInput {
  return { organizationId, ...OLOST_IDENTITETSGRANSKNING }
}
