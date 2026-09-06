import type { SammaNycklar, UpdateLeaseInput } from '@eken/shared'
import { UpdateLeaseSchema } from '@eken/shared'
import { PartialType } from '@nestjs/swagger'
import { CreateLeaseDto } from './create-lease.dto'
import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'

// Korsfältsreglerna körs ur schemat — se dekoratorns egen fil. Utan den släppte
// PATCH igenom `{ indexBaseYear: 2026 }` utan indexklausul, och tjänsten sparade
// basåret (`leases.service.ts:149`).
@UppfyllerSchemat(UpdateLeaseSchema)
export class UpdateLeaseDto extends PartialType(CreateLeaseDto) {}

/**
 * NYCKELPARITET mot `UpdateLeaseSchema`. `PartialType` härleder formen ur DTO:n
 * och schemat ur `CreateLeaseBaseSchema.partial()` — två härledningar av samma
 * mängd är inte en härledning.
 */
const _kontraktUppdateraAvtal: SammaNycklar<UpdateLeaseDto, UpdateLeaseInput> = true
void _kontraktUppdateraAvtal
