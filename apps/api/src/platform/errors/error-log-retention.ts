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
 */
export const RESOLVED_RETENTION_DAYS = 30

/**
 * OLÖSTA rader: **180 dagar**.
 *
 * En olöst rad kan fortfarande vara det enda spåret av ett fel som ingen hunnit
 * titta på. Ett halvår täcker en säsongsbunden bugg — hyresåret har toppar vid
 * månadsskiften, kvartal och årsskifte — så ett fel som återkommer varje
 * kvartal hinner ses två gånger innan det första exemplaret gallras.
 *
 * Längre än så tillför inte utredningsvärde: en sex månader gammal stack trace
 * pekar på kod som sannolikt inte finns kvar (204 merges till main under 30
 * dagar, mätt i #605).
 *
 * Fristen är LÄNGRE än den lösta av ett skäl som går åt fel håll för
 * dataminimering, och det är medvetet: alternativet — att gallra olösta fel
 * först — hade raderat just det som ingen ännu utrett. Motviljan mot att förlora
 * ett outrett fel väger tyngre än de extra 150 dagarnas exponering, förutsatt
 * att någon faktiskt löser rader. Gör ingen det är det inte fristen som är fel.
 */
export const UNRESOLVED_RETENTION_DAYS = 180

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
