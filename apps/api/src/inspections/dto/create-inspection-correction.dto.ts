import { IsString, MaxLength, MinLength, Matches } from 'class-validator'

import type { CreateInspectionCorrectionInput, SammaNycklar } from '@eken/shared'
import { INSPECTION_TEXT_MAX, INSPECTION_CORRECTION_REASON_MIN } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/**
 * POST /inspections/:id/rattelse
 *
 * ── VAD SOM INTE FÅR KOMMA FRÅN KLIENTEN ───────────────────────────────────
 *
 * Aktören, tidpunkten och versionsnumret. Alla tre är serverns, av exakt samma
 * skäl som `completedAt` och `signedAt` togs bort ur `UpdateInspectionDto`:
 * ett rättelsespår vars aktör och datum anroparen väljer själv är inget spår.
 * `correctedById` läses ur JWT, `correctedAt` ur serverns klocka och `version`
 * räknas ur kedjan under radlåset.
 *
 * ── `orsak` HAR ETT GOLV ───────────────────────────────────────────────────
 *
 * Fältets hela syfte är att någon i efterhand ska kunna läsa varför originalet
 * inte dög. Ett obligatoriskt fält som accepterar "x" är obligatoriskt bara på
 * pappret. Golvet är ingen garanti för en bra motivering — det är en spärr mot
 * den tomma.
 *
 * Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
 * raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
 */
export class CreateInspectionCorrectionDto implements CreateInspectionCorrectionInput {
  @IsString()
  @MinLength(INSPECTION_CORRECTION_REASON_MIN)
  @MaxLength(INSPECTION_TEXT_MAX)
  @StrictString()
  orsak!: string

  /**
   * `contentHash` ur den version anroparen läste. Obligatorisk — en spärr som
   * går att tysta genom att utelämna ett fält är ingen spärr, och samma
   * resonemang står redan vid signeringens `expectedContentHash`.
   */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'expectedContentHash måste vara en 64 tecken lång hexsträng (sha256).',
  })
  // Samma dekorator som på signeringens `expectedContentHash`. Utan den kör
  // pipen `String(värdet)` före validatorn, och `{ "a": 1 }` blir
  // "[object Object]" — en sträng som SER UT som data. Regeln är absolut och
  // har ingen baslinje; se `common/contract/strict-string.decorator`.
  @StrictString()
  expectedContentHash!: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena.
 */
const _kontraktRattelse: SammaNycklar<
  CreateInspectionCorrectionDto,
  CreateInspectionCorrectionInput
> = true
void _kontraktRattelse
