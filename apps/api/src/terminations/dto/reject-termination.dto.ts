import type { SammaNycklar, RejectTerminationInput } from '@eken/shared'
import { IsOptional, IsString, MaxLength } from 'class-validator'

export class RejectTerminationDto implements RejectTerminationInput {
  // Frivillig motivering till avslag. Mejlas till hyresgästen. Persisteras inte
  // (TerminationRequest saknar kolumn för granskarens notering) — e-postloggen
  // utgör spåret. Ett persisterat reviewNote-fält kan läggas till senare om
  // revisionsbehov uppstår.
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktAvslaUppsagning: SammaNycklar<RejectTerminationDto, RejectTerminationInput> = true
void _kontraktAvslaUppsagning
