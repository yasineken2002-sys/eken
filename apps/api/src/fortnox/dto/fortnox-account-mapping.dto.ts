import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsPositive,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator'

import {
  FORTNOX_ACCOUNT_ROLES,
  FORTNOX_VAT_TREATMENTS,
  fortnoxAccountMappingApproveInputSchema,
  fortnoxAccountMappingDraftInputSchema,
  type FortnoxAccountMappingApproveInput,
  type FortnoxAccountMappingDraftInput,
  type FortnoxAccountMappingRowInput,
  type FortnoxAccountRole,
  type FortnoxVatTreatment,
  type SammaNycklar,
} from '@eken/shared'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'

/**
 * TESTKUND-008. Formen bor i `fortnoxAccountMappingDraftInputSchema`; korsfältsreglerna (rollens
 * behandling, dubbla nycklar) körs ur samma schema via @UppfyllerSchemat. Tjänsten prövar ändå
 * allt på nytt mot Evenos kontoplan och Fortnox.
 */
export class FortnoxAccountMappingRowDto implements FortnoxAccountMappingRowInput {
  @IsIn(FORTNOX_ACCOUNT_ROLES)
  role!: FortnoxAccountRole

  @IsIn(FORTNOX_VAT_TREATMENTS)
  vatTreatment!: FortnoxVatTreatment

  @IngenKoercion()
  @IsInt()
  @Min(1000)
  @Max(9999)
  sourceAccountNumber!: number

  @IngenKoercion()
  @IsInt()
  @Min(1000)
  @Max(9999)
  targetAccountNumber!: number
}

@UppfyllerSchemat(fortnoxAccountMappingDraftInputSchema)
export class FortnoxAccountMappingDraftDto implements FortnoxAccountMappingDraftInput {
  @IngenKoercion()
  @IsInt()
  @IsPositive()
  financialYearId!: number

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FortnoxAccountMappingRowDto)
  rows!: FortnoxAccountMappingRowDto[]
}

@UppfyllerSchemat(fortnoxAccountMappingApproveInputSchema)
export class FortnoxAccountMappingApproveDto implements FortnoxAccountMappingApproveInput {
  @StrictString()
  @Matches(/^[0-9a-f]{64}$/)
  contentSha256!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _rad: SammaNycklar<FortnoxAccountMappingRowDto, FortnoxAccountMappingRowInput> = true
const _utkast: SammaNycklar<FortnoxAccountMappingDraftDto, FortnoxAccountMappingDraftInput> = true
const _godkann: SammaNycklar<FortnoxAccountMappingApproveDto, FortnoxAccountMappingApproveInput> =
  true
void _rad
void _utkast
void _godkann
