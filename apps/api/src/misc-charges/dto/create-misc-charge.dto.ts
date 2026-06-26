import { IsDateString, IsEnum, IsNumber, IsString, IsUUID, MaxLength, Min } from 'class-validator'
import { MiscChargeSource } from '@prisma/client'

// Speglar CreateMiscChargeSchema i @eken/shared (PR 1). Belopp anges NETTO
// (netAmount) — moms snapshotas i servicen (EXEMPT v1, momsbeslutet dokumenterat
// i PR 2), därför ingår inga vat*-fält här. sourceRefId = ärendets id när
// sourceType = MAINTENANCE_TICKET.
export class CreateMiscChargeDto {
  @IsUUID()
  leaseId!: string

  @IsUUID()
  tenantId!: string

  @IsEnum(MiscChargeSource)
  sourceType!: MiscChargeSource

  @IsString()
  @MaxLength(64)
  sourceRefId!: string

  @IsString()
  @MaxLength(500)
  description!: string

  // När skadan/förlusten konstaterades — styr bokföringsdatum (PR 2).
  @IsDateString()
  incidentDate!: string

  @IsNumber()
  @Min(0)
  netAmount!: number
}
