import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator'

export class ApproveTerminationDto {
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
