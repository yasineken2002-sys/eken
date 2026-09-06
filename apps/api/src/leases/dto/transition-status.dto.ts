import type { SammaNycklar, TransitionLeaseStatusInput } from '@eken/shared'
import { IsEnum } from 'class-validator'

export class TransitionLeaseStatusDto implements TransitionLeaseStatusInput {
  // Unionen, inte `string`. Fältet var typat `string` medan `@IsEnum` grindade
  // i runtime — alltså accepterade DTO:n på TYPNIVÅ vilken sträng som helst,
  // och `implements` kunde inte se att mängden glidit från schemats.
  @IsEnum(['ACTIVE', 'DRAFT', 'EXPIRED', 'TERMINATED'])
  status!: 'ACTIVE' | 'DRAFT' | 'EXPIRED' | 'TERMINATED'
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktStatusovergang: SammaNycklar<TransitionLeaseStatusDto, TransitionLeaseStatusInput> =
  true
void _kontraktStatusovergang
