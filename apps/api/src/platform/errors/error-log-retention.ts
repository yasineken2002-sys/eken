/**
 * GALLRINGSFRIST FÖR `ErrorLog` — differentierad per SYFTE (#612).
 *
 * ── BESLUTET SOM FRISTEN VILAR PÅ ───────────────────────────────────────────
 *
 * `ErrorLog` är ett DRIFTVERKTYG, inte ett revisionsspår. Beslutet är taget i
 * #612 och står också i `schema.prisma` ovanför modellen.
 *
 * Skillnaden är inte akademisk. Tabellen beskrevs tidigare som ett
 * revisionsspår, och den beskrivningen bar en följd ingen hade valt: ett
 * revisionsspår sparas för alltid. Revisionsspåret i den här kodbasen är
 * `InvoiceEvent`, `AiToolExecution` och de append-only-skyddade tabellerna —
 * poster som är underlag för något. En felrad är inte underlag för något; den
 * finns för att en människa ska kunna utreda ett fel som inträffade.
 *
 * ── VARFÖR DET INTE FÅR VARA "FÖR ALLTID" ───────────────────────────────────
 *
 * `message` och `stack` är OSTRUKTURERAD fritext från kastade fel. Mätt i #612,
 * mot dev-databasen och inte resonerat:
 *
 *   • `PrismaClientValidationError.message` skriver ut HELA argumentobjektet —
 *     `email`, `personalNumber`, `phone`, `street` ordagrant (3 079 tecken i
 *     sonden).
 *   • Ett Postgres-constraintfel som passerar som P2010 bär
 *     `Failing row contains (…)` — hela raden, alla belopp, alla kolumner.
 *   • `context.ip` finns på VARJE rad från HTTP-vägen (14/14 i prod).
 *   • `context.path` bär hela URL:en, och `GET /v1/tenants?search=…` söker på
 *     namn och e-post — hyresvärdens söksträng hamnar i raden vid en 500.
 *
 * Ingen längdgräns finns: `@db.Text`, ingen `@MaxLength`, ingen trunkering.
 * "Sparas för alltid" betyder därför obegränsad persondataexponering, och det
 * var inte ett beslut någon fattade — det var en följd av ett ordval.
 *
 * ── TALEN ÄR ETT BESLUT, INTE EN SANNING ────────────────────────────────────
 *
 * Ingenting här är räkenskapsinformation, så det finns inget bevarandekrav att
 * väga emot. Talen nedan är satta av SYFTET och går att ändra — läs skälet,
 * inte bara siffran. Formen är densamma som `tool-execution-retention.ts`:
 * differentierad frist, med resonemanget i koden.
 */

/**
 * LÖSTA rader: **30 dagar**.
 *
 * `resolved` betyder att en människa har tittat på raden och stängt den.
 * Utredningen är gjord; det som återstår är en text som ingen ska läsa igen.
 * Trettio dagar räcker för att någon ska hinna ångra en förhastad
 * "markera löst" och för att en veckovis genomgång ska se historiken.
 *
 * NOTERA ATT FRISTEN VÄLJS AV NUVARANDE `resolved`, INTE AV NÅGOT SOM LÅSTES
 * VID SKRIVNINGEN. En 100 dagar gammal rad som markeras löst i dag blir
 * omedelbart gallringsbar. Det är avsiktligt och är hela poängen med att
 * differentiera: den som stänger raden säger just att den inte behövs mer.
 *
 * ── HINKEN ÄR NÅBAR — MEN BARA MANUELLT, OCH HAR ALDRIG ANVÄNTS ─────────────
 *
 * Två tal där det ena aldrig gäller vore en gallring som ser strängare ut än den
 * är. Härlett ur koden, så att talet inte står oemotsagt:
 *
 *   PlatformErrorsService.resolve()            enda skrivningen av resolved:true
 *   POST /platform/errors/:id/resolve          rutten (PlatformGuard)
 *   admin ErrorsPage.tsx — "Markera löst"      knappen, i detaljpanelen
 *
 * Kedjan är hel; hinken är alltså ingen tom mängd per konstruktion. MEN:
 *
 *   • Det finns INGEN automatisk väg. Ingen cron, ingen tjänst och ingen regel
 *     stänger en rad — bara en människa som klickar.
 *   • Prod hade 2026-09-01 noll lösta rader av fjorton, sedan nollställningen
 *     2026-07-13. Hinken har alltså aldrig använts i praktiken.
 *
 * FÖLJDEN, UTSKRIVEN: klickar ingen är den EFFEKTIVA fristen den OLÖSTA — och
 * det är därför den sänktes från 180 till 90 (2026-09-02). Talen är nu valda så
 * att BÅDA är sanna även om knappen aldrig trycks: 90 dagar är en frist jag är
 * beredd att försvara som enda verksamma frist, vilket 180 inte var. Trettio-
 * dagarshinken förblir en möjlighet, inte en verkan — men den är inte längre det
 * som avgör om gallringen betyder något.
 *
 * INGEN AUTOMATISK STÄNGNING ÄR BYGGD, och det är ett beslut och inte en lucka.
 * En cron som markerar gamla rader lösta hade gett samma effekt som en kortare
 * olöst-frist, till priset av ännu en mekanism att underhålla och ännu ett
 * tillstånd att förstå. Sänk talet i stället för att bygga maskineriet.
 */
export const RESOLVED_RETENTION_DAYS = 30

/**
 * OLÖSTA rader: **90 dagar**. (Sänkt från 180 den 2026-09-02.)
 *
 * En olöst rad kan fortfarande vara det enda spåret av ett fel som ingen hunnit
 * titta på, och den fristen ska därför vara längre än den lösta. Men bara
 * längre — inte obestämt lång.
 *
 * SKÄLET TILL 90, RAKT UT: en olöst felrad som ingen tittat på i tre månader
 * utreds inte. Den samlar persondata. `message` och `stack` är ostrukturerad
 * fritext som mätt i #612 kan bära e-post, personnummer, belopp och motpart —
 * så varje extra dag är exponering utan motsvarande utredningsvärde. Ett kvartal
 * räcker för att en månadsskiftes- eller kvartalsbugg ska hinna ses; det som
 * inte setts på ett kvartal kommer inte att ses.
 *
 * Att 180 var för långt är inte en åsikt om halvår, utan en följd av hur talen
 * samverkar. Den lösta hinken har ingen automatisk väg (se blocket ovanför
 * `RESOLVED_RETENTION_DAYS`), så klickar ingen är den olösta fristen den ENDA
 * verksamma — och då måste den ensam vara försvarbar. Det gjorde 180 inte, och
 * därför var 30-dagarshinken i praktiken dekoration. Med 30/90 är båda talen
 * sanna även i det fall ingen någonsin markerar en rad löst.
 *
 * Att gallra olösta SNABBARE än lösta vore fortfarande fel — det hade raderat
 * just det som ingen ännu utrett. Ordningen står kvar; det är avståndet som
 * krympt.
 */
export const UNRESOLVED_RETENTION_DAYS = 90

/**
 * Rader UTAN organisation gallras på samma villkor som alla andra.
 *
 * Det står här därför att de i dag faller utanför ALLT: den enda existerande
 * raderingsvägen är `delete-organization.ts`, som matchar på `organizationId`,
 * och en rad med `null` där matchas aldrig. En sådan rad var före den här
 * ändringen odödlig. Det är inte en liten kategori — HTTP-fel före inloggning
 * och frontend-rapporter saknar org.
 *
 * Gallringen filtrerar därför INTE på `organizationId` alls. Konstanten finns
 * inte för att styra något, utan för att det ska stå SKRIVET att utelämnandet
 * är avsiktligt och inte ett glömt villkor.
 */
export const NULL_ORG_ROWS_ARE_INCLUDED = true

export type ErrorLogRetentionBucket = 'resolved' | 'unresolved'

export const ERROR_LOG_RETENTION_BUCKETS: readonly ErrorLogRetentionBucket[] = [
  'resolved',
  'unresolved',
]

export function retentionDaysForBucket(bucket: ErrorLogRetentionBucket): number {
  switch (bucket) {
    case 'resolved':
      return RESOLVED_RETENTION_DAYS
    case 'unresolved':
      return UNRESOLVED_RETENTION_DAYS
  }
}

/**
 * Gränsen: rader äldre än den här tidpunkten faller inom hinken.
 *
 * Exporterad för att specen ska kunna räkna med SAMMA funktion som körningen.
 * En spec som räknar sin egen gräns bevisar bara att två uträkningar råkar
 * stämma överens i dag.
 */
export function cutoffFor(bucket: ErrorLogRetentionBucket, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDaysForBucket(bucket) * 24 * 60 * 60 * 1000)
}
