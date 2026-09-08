import type { CreateMiscChargeInput, SammaNycklar } from '@eken/shared'
import { IsEnum, IsNumber, IsString, IsUUID, MaxLength, Min } from 'class-validator'
import { MiscChargeSource } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

// Speglar CreateMiscChargeSchema i @eken/shared (PR 1). Belopp anges NETTO
// (netAmount) — moms snapshotas i servicen (EXEMPT v1, momsbeslutet dokumenterat
// i PR 2), därför ingår inga vat*-fält här. sourceRefId = ärendets id när
// sourceType = MAINTENANCE_TICKET.
export class CreateMiscChargeDto implements CreateMiscChargeInput {
  @IsUUID()
  leaseId!: string

  @IsUUID()
  tenantId!: string

  @IsEnum(MiscChargeSource)
  sourceType!: MiscChargeSource

  @IsString()
  @MaxLength(64)
  @StrictString()
  sourceRefId!: string

  @IsString()
  @MaxLength(500)
  @StrictString()
  description!: string

  // När skadan/förlusten konstaterades — styr bokföringsdatum (PR 2).
  @StrictIsoDatum()
  incidentDate!: string

  // Min 0.01: ett nollbelopp skapar en DRAFT som aldrig kan bekräftas (confirm →
  // null vid total ≤ 0 → 422). DTO-validering är primär spärr; servicens
  // null-hantering är backstop.
  @IsNumber()
  @Min(0.01)
  netAmount!: number
}

const _kontrakt: SammaNycklar<CreateMiscChargeDto, CreateMiscChargeInput> = true
void _kontrakt
