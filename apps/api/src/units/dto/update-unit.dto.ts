import type { SammaNycklar, UpdateUnitInput } from '@eken/shared'
import { PartialType } from '@nestjs/swagger'
import { CreateUnitDto } from './create-unit.dto'

export class UpdateUnitDto extends PartialType(CreateUnitDto) {}

/**
 * NYCKELPARITET mot `UpdateUnitSchema`. `PartialType` härleder formen ur DTO:n
 * och schemat härleder sin ur `CreateUnitSchema.partial()` — två härledningar
 * av samma mängd är inte en härledning.
 */
const _kontraktUppdateraLagenhet: SammaNycklar<UpdateUnitDto, UpdateUnitInput> = true
void _kontraktUppdateraLagenhet
