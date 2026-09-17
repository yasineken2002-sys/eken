import type { SammaNycklar, UpdateUnitInput } from '@eken/shared'
import { PartialType } from '@nestjs/swagger'
import { CreateUnitDto } from './create-unit.dto'

/**
 * ETT UTTRYCKLIGT `null` ÄR INTE ETT UTELÄMNAT FÄLT.
 *
 * `PartialType` lägger som standard `@IsOptional()` på varje fält, och den
 * hoppar över all validering för BÅDE `undefined` och `null`. Följden var mätt:
 * `PATCH {"propertyId": null, "name": "Nytt namn"}` gick förbi `@IsUUID()`,
 * förbi tjänstens jämförelse (`null != null` är falskt), sparade namnet och
 * svarade 200 med oförändrad fastighet. Klienten hade uttryckligen skickat ett
 * värde som varken är objektets fastighet eller giltigt enligt det delade
 * kontraktet, och fick ett lyckat svar.
 *
 * `skipNullProperties: false` byter den grinden mot
 * `ValidateIf((_, v) => v !== undefined)`, så `null` VALIDERAS i stället för att
 * hoppas över — och avvisas av `@IsUUID()` i pipen, alltså före controllern och
 * före varje skrivning. Utelämnat fält beter sig oförändrat.
 *
 * ── GRÄNSEN, SÅ ATT DEN INTE BLIR EN OLYCKA ─────────────────────────────────
 *
 * class-validator OCH-ar sina villkor (`ValidationExecutor.conditionalValidations`
 * reducerar med `&&`). `status`, `floor` och `rooms` bär ett EGET `@IsOptional()`
 * i `CreateUnitDto`, som ärvs hit. För dem gäller alltså fortfarande
 * "null = frånvarande", och ett `null` där förblir en tyst no-op med 200.
 *
 * Det är `CreateUnitDto`:s egen befintliga semantik för de tre fälten, inte
 * något den här raden inför, och att ändra den hade också ändrat POST. Gränsen
 * prövas uttryckligen i `unit-property-move.db.spec.ts` så att den är ett val
 * och inte en slump.
 */
/**
 * Alternativen ligger i en konstant, inte inline. `check-strict-koercion.mjs`
 * hittar klasskroppen med `class NAMN[^{]*\{` (`:166`), och den teckenklassen
 * kan inte passera ett `{`. Skrivs objektet inline blir dess egen klammer
 * "klasskroppens början", och vakten läser `skipNullProperties: false` som ett
 * booleskt DTO-fält utan `@StrictBoolean()` — en falsk positiv. Konstanten
 * flyttar klammern bort från klassraden. Inget vaktundantag behövs.
 */
const partiellaAlternativ = { skipNullProperties: false }

export class UpdateUnitDto extends PartialType(CreateUnitDto, partiellaAlternativ) {}

/**
 * NYCKELPARITET mot `UpdateUnitSchema`. `PartialType` härleder formen ur DTO:n
 * och schemat härleder sin ur `CreateUnitSchema.partial()` — två härledningar
 * av samma mängd är inte en härledning.
 */
const _kontraktUppdateraLagenhet: SammaNycklar<UpdateUnitDto, UpdateUnitInput> = true
void _kontraktUppdateraLagenhet
