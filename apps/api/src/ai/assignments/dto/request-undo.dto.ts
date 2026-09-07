import { IsOptional, IsString, MaxLength } from 'class-validator'

import type { RequestUndoInput, SammaNycklar } from '@eken/shared'

/**
 * Ångra-begäran. Bara ett valfritt skäl — begäran gäller uppdraget i rutten.
 *
 * Skälet är VALFRITT här och det är ett medvetet val: `DecideAssignmentDto`
 * kräver ett skäl vid avslag, därför att skälet då är minnesmat som formar
 * nästa förslag. En ångra-begäran formar ingenting automatiskt — den är ett
 * larm till en människa — och ett tvingande fält hade gjort det svårare att
 * säga ifrån än att låta bli.
 */
export class RequestUndoDto implements RequestUndoInput {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string
}

/**
 * NYCKELPARITET mot schemat. `implements` ensamt räcker inte: en klass som
 * utelämnar ett VALFRITT fält uppfyller interfacet utan anmärkning, och just
 * det fältet blir ett 400 den dag webben börjar skicka det.
 */
const _kontrakt: SammaNycklar<RequestUndoDto, RequestUndoInput> = true
void _kontrakt
