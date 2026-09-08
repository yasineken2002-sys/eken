import type { ConfirmContractRowInput, SammaNycklar } from '@eken/shared'
import { IsObject, IsOptional, IsUUID } from 'class-validator'

/**
 * Operatörens indata vid commit av EN granskad rad (PR3).
 * - unitId: vald enhet (krävs för rader som inte är AUTO_MATCHED).
 * - reviewedData: ev. redigeringar av den extraherade datan. Om-valideras i
 *   servicen (buildLeaseDtoFromScan) innan avtalet skapas — inget förlitande på
 *   att klienten skickar giltiga fält.
 */
export class ConfirmContractRowDto implements ConfirmContractRowInput {
  @IsUUID()
  @IsOptional()
  unitId?: string

  @IsObject()
  @IsOptional()
  reviewedData?: Record<string, unknown>
}

const _kontrakt: SammaNycklar<ConfirmContractRowDto, ConfirmContractRowInput> = true
void _kontrakt
