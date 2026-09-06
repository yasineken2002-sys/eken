import type { SammaNycklar, ApproveTerminationInput } from '@eken/shared'
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator'

export class ApproveTerminationDto implements ApproveTerminationInput {
  // Bindande slutdatum, bekräftat av hyresvärden. Utelämnas det beräknar
  // servicen ett förslag (senare av hyresgästens önskade datum och idag +
  // uppsägningstid, JB 12 kap 5 §). Hyresvärden ska normalt alltid skicka
  // ett bekräftat datum från dialogen — vi auto-applicerar aldrig enbart
  // hyresgästens önskemål.
  @IsDateString()
  @IsOptional()
  effectiveDate?: string

  @IsString()
  @IsOptional()
  @MaxLength(500)
  terminationReason?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktGodkannUppsagning: SammaNycklar<ApproveTerminationDto, ApproveTerminationInput> =
  true
void _kontraktGodkannUppsagning
