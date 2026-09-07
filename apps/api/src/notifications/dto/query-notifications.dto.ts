import { IsOptional, IsBoolean } from 'class-validator'

import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

export class QueryNotificationsDto {
  /**
   * `?unread=true` — en QUERY-parameter, alltså anländer värdet alltid som
   * sträng. Det är precis fallet `@StrictBoolean()` är byggd för: den läser
   * råvärdet och godtar `"true"`/`"false"`, medan `"1"` och `"yes"` ger 400.
   *
   * ── EN ÄLDRE @Transform TOGS BORT HÄR ─────────────────────────────────────
   *
   * Fältet bar tidigare `@Transform(({ value }) => value === 'true' || value
   * === true)`. Den blev DÖD när `@StrictBoolean()` lades till — dess egen
   * transform läser `obj[key]` och skriver över utfallet — men två transformer
   * på samma fält gör beteendet ORDNINGSBEROENDE, och den gamla hade tolkat
   * `"1"` som `false` i stället för att avvisa det. Att den råkade förlora var
   * inte en egenskap att lita på.
   */
  @IsOptional()
  @StrictBoolean()
  @IsBoolean()
  unread?: boolean
}
