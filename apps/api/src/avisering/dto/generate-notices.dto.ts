import type { GenerateNoticesInput, SammaNycklar } from '@eken/shared'
import { IsInt, Min, Max } from 'class-validator'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements GenerateNoticesInput` plus paritetsraden längst ned binder formen till
// `GenerateNoticesSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class GenerateNoticesDto implements GenerateNoticesInput {
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number

  @IsInt()
  @Min(2020)
  year!: number
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktGenerering: SammaNycklar<GenerateNoticesDto, GenerateNoticesInput> = true
void _kontraktGenerering
