import { Type } from 'class-transformer'
import { IsInt, IsObject, IsOptional, Min, ValidateNested } from 'class-validator'

import type {
  CreateDelegationFromAssignmentInput,
  Frekvensvillkor,
  SammaNycklar,
} from '@eken/shared'

/**
 * Frekvensvillkoret. Obligatoriskt i TJÄNSTEN för `DEDUPLICERBAR`-verktyg —
 * DTO:t kan inte uttrycka "krävs bara när verktyget är av ett visst slag", och
 * en `@ValidateIf` hade flyttat regeln till en plats där bara HTTP-vägen ser den.
 */
export class FrekvensvillkorDto implements Frekvensvillkor {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxAntal!: number

  @Type(() => Number)
  @IsInt()
  @Min(1)
  periodDagar!: number
}

export class CreateFromAssignmentDto implements CreateDelegationFromAssignmentInput {
  /**
   * Valt villkor. Utelämnas det används det FÖRIFYLLDA ur förslaget.
   *
   * Otypat objekt med flit: fälten är dynamiska (`SKUGGFALT[0]` avgör typfältets
   * namn), och en klass med fasta fält hade blivit en andra uppräkning som
   * glider från `shadow-fields.ts`. Innehållet prövas i tjänsten, som bara
   * tillåter att villkoret SNÄVAS.
   */
  @IsOptional()
  @IsObject()
  villkor?: Record<string, unknown>

  @IsOptional()
  @ValidateNested()
  @Type(() => FrekvensvillkorDto)
  frekvensvillkor?: FrekvensvillkorDto
}

/**
 * KOMPILERINGSTIDENS KOPPLING till webben.
 *
 * `implements` fångar att fälten har rätt TYP; nyckelpariteten fångar att de är
 * SAMMA fält. Båda behövs — en DTO kan implementera ett interface och ändå kräva
 * ett fält webben aldrig skickar. Se `packages/shared/src/schemas/contract.ts`.
 */
const _kontrakt: SammaNycklar<CreateFromAssignmentDto, CreateDelegationFromAssignmentInput> = true
void _kontrakt
