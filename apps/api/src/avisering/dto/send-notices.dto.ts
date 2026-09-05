import type { SendNoticesInput, SammaNycklar } from '@eken/shared'
import { IsArray, IsUUID } from 'class-validator'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements SendNoticesInput` plus paritetsraden längst ned binder formen till
// `SendNoticesSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class SendNoticesDto implements SendNoticesInput {
  @IsArray()
  @IsUUID('4', { each: true })
  noticeIds!: string[]
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktUtskick: SammaNycklar<SendNoticesDto, SendNoticesInput> = true
void _kontraktUtskick
