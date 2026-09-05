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
