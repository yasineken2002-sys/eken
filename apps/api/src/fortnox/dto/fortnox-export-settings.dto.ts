import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator'

import type { FortnoxExportSettingsInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

/** PUT /integrations/fortnox/export-settings. Formen bor i `fortnoxExportSettingsInputSchema`. */
export class FortnoxExportSettingsDto implements FortnoxExportSettingsInput {
  @IsOptional()
  @IsString()
  @StrictString()
  @Matches(/^[A-Za-z0-9]{1,8}$/)
  voucherSeries?: string

  @IsOptional()
  @IsBoolean()
  @StrictBoolean()
  omitDimensions?: boolean
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxExportSettingsDto, FortnoxExportSettingsInput> = true
void _kontrakt
