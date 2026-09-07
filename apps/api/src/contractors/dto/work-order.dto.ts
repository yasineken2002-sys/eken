import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator'

import type {
  CancelWorkOrderInput,
  SammaNycklar,
  SendWorkOrderInput,
  WorkOrderResponseInput,
} from '@eken/shared'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'

/** POST /maintenance/:id/work-orders */
export class SendWorkOrderDto implements SendWorkOrderInput {
  @IsUUID()
  contractorId!: string

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  meddelande?: string

  /**
   * HYRESVÄRDENS VAL, inte hyresgästens samtycke.
   *
   * `@IngenKoercion()` är inte pedanteri här: utan den gör pipens implicita
   * konvertering strängen `"false"` till `true`, och en klient som menade NEJ
   * hade delat hyresgästens kontaktuppgift med en utomstående. Det är den
   * farliga riktningen, och den enda anledningen att ta booleanerna först.
   */
  @IsOptional()
  @IngenKoercion()
  @IsBoolean()
  delaHyresgastKontakt?: boolean
}

/**
 * POST /work-orders/:token/respond
 *
 * PUBLIK endpoint — hantverkaren har ingen inloggning. Token i sökvägen är den
 * enda behörigheten och prövas i tjänsten: hashat uppslag, engångs, kortlivat.
 * DTO:n ser bara formen på svaret.
 */
export class WorkOrderResponseDto implements WorkOrderResponseInput {
  @IngenKoercion()
  @IsBoolean()
  accepterar!: boolean

  @IsOptional()
  @IsDateString()
  proposedAt?: string

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string
}

/** POST /work-orders/:id/cancel */
export class CancelWorkOrderDto implements CancelWorkOrderInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  skal?: string
}

const _kontraktSkicka: SammaNycklar<SendWorkOrderDto, SendWorkOrderInput> = true
const _kontraktSvar: SammaNycklar<WorkOrderResponseDto, WorkOrderResponseInput> = true
const _kontraktAvboka: SammaNycklar<CancelWorkOrderDto, CancelWorkOrderInput> = true
void _kontraktSkicka
void _kontraktSvar
void _kontraktAvboka
