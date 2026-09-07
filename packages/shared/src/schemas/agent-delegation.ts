import { z } from 'zod'

/**
 * DELEGATIONENS NYTTOLASTER (G2, etapp 7).
 *
 * ── EGEN FIL, INTE EN RAD I index.ts ────────────────────────────────────────
 *
 * Scheman för olika domäner bor i samma fil i dag, och det fungerar tills två
 * strömmar redigerar den samtidigt. Den här ligger separat därför att
 * delegationen är en egen domän med egen livslängd — och för att en ny fil inte
 * kan krocka med någon annans rad.
 */

/**
 * Frekvensvillkoret: `maxAntal` per `periodDagar`.
 *
 * Obligatoriskt i TJÄNSTEN för `DEDUPLICERBAR`-verktyg, valfritt här. Schemat
 * kan inte uttrycka "krävs bara när verktyget är av ett visst slag", och att
 * lägga regeln här hade flyttat den till en plats där bara HTTP-vägen ser den.
 */
export const FrekvensvillkorSchema = z.object({
  maxAntal: z.number().int().min(1),
  periodDagar: z.number().int().min(1),
})
export type Frekvensvillkor = z.infer<typeof FrekvensvillkorSchema>

/**
 * "Gör alltid så här" — delegationen som föds ur ett godkänt förslag.
 *
 * `villkor` är ett OTYPAT objekt med flit: fältnamnen är dynamiska (typfältet
 * härleds ur `SKUGGFALT[0]` i API:t), och en fast form här hade blivit en andra
 * uppräkning som glider. Innehållet prövas i tjänsten, som bara tillåter att
 * villkoret SNÄVAS jämfört med det förifyllda.
 */
export const CreateDelegationFromAssignmentSchema = z.object({
  villkor: z.record(z.string(), z.unknown()).optional(),
  frekvensvillkor: FrekvensvillkorSchema.optional(),
})
export type CreateDelegationFromAssignmentInput = z.infer<
  typeof CreateDelegationFromAssignmentSchema
>

/**
 * Återkallandet. Skälet är FRIVILLIGT med flit.
 *
 * Ett obligatoriskt fritextfält blir "x" efter tredje gången, och då är
 * historiken sämre än om fältet varit tomt — den ser ifylld ut. Det som är
 * obligatoriskt är HÄNDELSEN, inte motiveringen.
 *
 * Taket på 500 tecken finns för att skälet renderas i en historikrad; utan tak
 * kan en inklistrad e-posttråd göra raden oläsbar för allt annat.
 */
export const RevokeDelegationSchema = z.object({
  skäl: z.string().max(500).optional(),
})
export type RevokeDelegationInput = z.infer<typeof RevokeDelegationSchema>

/**
 * SVARET PÅ EN FRÅGA FRÅN AGENTEN (etapp 8 PR 5b).
 *
 * En sträng, och mängden lagliga värden bor på frågans egen rad — schemat kan
 * inte känna dem. Formen prövas här, mängden i tjänsten.
 */
export const AnswerQuestionSchema = z.object({
  svar: z.string().min(1).max(200),
})
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionSchema>

/**
 * ÅNGRA-BEGÄRAN på en utförd åtgärd (etapp 9).
 *
 * Bara ett valfritt skäl — begäran gäller uppdraget i rutten. Skälet är
 * VALFRITT till skillnad från avslagets, som är obligatoriskt: ett avslag formar
 * nästa förslag och skälet är då minnesmat, medan en ångra-begäran är ett larm
 * till en människa. Ett tvingande fält hade gjort det svårare att säga ifrån än
 * att låta bli.
 */
export const RequestUndoSchema = z.object({
  note: z.string().max(2000).optional(),
})
export type RequestUndoInput = z.infer<typeof RequestUndoSchema>
