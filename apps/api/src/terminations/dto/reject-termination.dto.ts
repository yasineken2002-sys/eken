import { IsOptional, IsString, MaxLength } from 'class-validator'

export class RejectTerminationDto {
  // Frivillig motivering till avslag. Mejlas till hyresgästen. Persisteras inte
  // (TerminationRequest saknar kolumn för granskarens notering) — e-postloggen
  // utgör spåret. Ett persisterat reviewNote-fält kan läggas till senare om
  // revisionsbehov uppstår.
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string
}
