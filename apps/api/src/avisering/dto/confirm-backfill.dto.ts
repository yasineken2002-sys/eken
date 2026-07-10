import { IsBoolean, IsOptional } from 'class-validator'

/**
 * T1.4 PR2 — bekräftelse av efterdebitering. Bekräftelsen är den juridiskt
 * BINDANDE punkten: utan detta POST skapas ingen avi (motorn förblir preview).
 *
 * `allowBeyondWarning` = aktörens uttryckliga godkännande av månader i 12–36-
 * grinden (>12 mån bakåt = sannolikt datafel). Utan flaggan hoppas de månaderna
 * över; med flaggan skapas de och godkännandet loggas i audit-spåret.
 */
export class ConfirmBackfillDto {
  @IsOptional()
  @IsBoolean()
  allowBeyondWarning?: boolean

  /**
   * Momsdeklarations-bekräftelse (bokförings HIGH). När kontraktet avser en
   * frivilligt skattskyldig LOKAL kan efterdebiterade månader falla i en redan
   * lämnad momsperiod → rättelsedeklaration (SFL 26 kap) = människans beslut.
   * Bekräftelsen fångas som ett aktivt kryss (speglar allowBeyondWarning) och
   * loggas i audit-spåret — inte bara en passiv informationsruta.
   */
  @IsOptional()
  @IsBoolean()
  vatDeclarationAcknowledged?: boolean
}
