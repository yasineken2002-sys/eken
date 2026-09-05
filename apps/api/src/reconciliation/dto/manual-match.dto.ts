import type { ManualMatchInput, SammaNycklar } from '@eken/shared'
import { IsUUID, IsOptional, ValidateIf } from 'class-validator'

// XOR — exakt en av invoiceId/rentNoticeId måste anges. Klassvalidering
// (gemensam) körs i service-lagret eftersom class-validator inte har en
// inbyggd "exactly one of"-dekoratör. Här markerar vi bara att fälten är
// frivilliga som UUID när satta.

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements ManualMatchInput` plus paritetsraden längst ned binder formen till
// `ManualMatchSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class ManualMatchDto implements ManualMatchInput {
  @IsOptional()
  @ValidateIf((o) => o.invoiceId !== undefined)
  @IsUUID()
  invoiceId?: string

  @IsOptional()
  @ValidateIf((o) => o.rentNoticeId !== undefined)
  @IsUUID()
  rentNoticeId?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktManuellMatchning: SammaNycklar<ManualMatchDto, ManualMatchInput> = true
void _kontraktManuellMatchning
