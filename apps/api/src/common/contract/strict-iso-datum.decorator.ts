import { applyDecorators } from '@nestjs/common'
import {
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator'

/**
 * SAMMA DATUMKRAV SOM `IsoDatumSchema` — inte class-validators `@IsISO8601()`.
 *
 * ── VAD SOM SKILDE, UPPMÄTT ─────────────────────────────────────────────────
 *
 *     värde                   @IsISO8601   IsoDatumSchema
 *     2026                    GODTAR       avvisar        ← bara årtal
 *     2026-09                 GODTAR       avvisar        ← år och månad
 *     2026-09-07              GODTAR       GODTAR
 *     2026-09-07T12:00:00Z    GODTAR       GODTAR
 *     2026-09-07T12:00:00     GODTAR       avvisar        ← UTAN TIDSZON
 *     20260907                GODTAR       avvisar        ← basformat
 *     2026-W12                GODTAR       avvisar        ← veckoformat
 *
 * Fem former som DTO:n godtog och schemat avvisade. Det var en dokumenterad
 * avvikelse i paritetsprovet; den är nu en PARITET.
 *
 * ── VARFÖR TIDSZONEN ÄR DEN ALLVARLIGA ──────────────────────────────────────
 *
 * `"2026-09-07T12:00:00"` saknar offset. `new Date()` tolkar den i SERVERNS
 * lokaltid, som inte är kundens och inte är UTC. För ett bokföringsdatum
 * betyder det att en betalning kan hamna på fel dag — och därmed i fel period.
 * `"2026"` är uppenbart fel och upptäcks; en tidsstämpel utan zon ser rätt ut.
 *
 * ── VARFÖR EN EGEN VALIDATOR OCH INTE zod I DTO:n ───────────────────────────
 *
 * DTO:erna valideras av class-validator, schemana av Zod, och de två beskriver
 * olika saker: schemat FORMEN, dekoratorerna GRÄNSERNA. Att importera Zod hit
 * hade bytt valideringsmotor för ett fält och gjort felmeddelandet engelskt.
 * Regexen nedan uttrycker samma mängd som `z.string().date()` unionerat med
 * `z.string().datetime({ offset: true })`, och paritetsprovet kräver att de
 * svarar likadant.
 */

/** `ÅÅÅÅ-MM-DD`. Samma mängd som `z.string().date()`. */
const DATUM = /^\d{4}-\d{2}-\d{2}$/

/**
 * `ÅÅÅÅ-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`. Offset är OBLIGATORISK — det är hela
 * skillnaden mot `@IsISO8601()`.
 */
const TIDSSTAMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Finns dagen? `Date.parse` DUGER INTE — den rullar över: `2026-02-30` blir
 * 2 mars och `2025-02-29` blir 1 mars, båda utan att bli NaN. Zod avvisar dem,
 * och en decorator som godtog dem hade infört en NY avvikelse i stället för att
 * ta bort en. Uppmätt innan den här raden skrevs.
 *
 * Kontrollen är en rundtur: bygg datumet i UTC och kräv att komponenterna kommer
 * tillbaka oförändrade.
 */
function dagenFinns(ar: number, manad: number, dag: number): boolean {
  const d = new Date(Date.UTC(ar, manad - 1, dag))
  return d.getUTCFullYear() === ar && d.getUTCMonth() === manad - 1 && d.getUTCDate() === dag
}

export function arIsoDatum(varde: unknown): boolean {
  if (typeof varde !== 'string') return false
  if (!DATUM.test(varde) && !TIDSSTAMPEL.test(varde)) return false
  const [ar, manad, dag] = varde.slice(0, 10).split('-').map(Number)
  if (ar === undefined || manad === undefined || dag === undefined) return false
  if (!dagenFinns(ar, manad, dag)) return false
  // Tiden prövas av Date.parse — 25:00 finns inte, och där rullar den INTE över.
  return !Number.isNaN(Date.parse(varde))
}

@ValidatorConstraint({ name: 'strictIsoDatum', async: false })
export class StrictIsoDatumConstraint implements ValidatorConstraintInterface {
  validate(varde: unknown): boolean {
    return arIsoDatum(varde)
  }

  defaultMessage(args: ValidationArguments): string {
    return (
      `${args.property} måste vara ett datum (ÅÅÅÅ-MM-DD) eller en tidsstämpel ` +
      'med tidszon (ÅÅÅÅ-MM-DDTHH:MM:SSZ)'
    )
  }
}

export const StrictIsoDatum = (): PropertyDecorator =>
  applyDecorators(Validate(StrictIsoDatumConstraint))
