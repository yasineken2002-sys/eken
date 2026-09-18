import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsObject, ValidateIf, ValidateNested } from 'class-validator'
import type { SammaNycklar, UpdatePropertyInput } from '@eken/shared'
import { AddressDto, CreatePropertyDto } from './create-property.dto'

/**
 * PATCH /properties/:id — partiell uppdatering.
 *
 * `PartialType` behålls: den gör varje fält valfritt OCH bevarar
 * class-validator-metadatan från `CreatePropertyDto`, så ett fält med fel VÄRDE
 * avvisas fortfarande. En handskriven klass hade tappat det.
 *
 * NYCKELPARITET mot `UpdatePropertySchema`. `PartialType` härleder formen ur
 * DTO:n och schemat härleder sin ur `CreatePropertySchema.partial()` — två
 * härledningar av samma mängd är inte en härledning, och raden nedan är det som
 * håller dem lika.
 *
 * ── VARFÖR ADRESSEN UNDANTAS OCH DEKLARERAS OM ──────────────────────────────
 *
 * `OmitType` ger en FÄRSK klass och kopierar metadatan fält för fält, så
 * `address` kommer hit UTAN `@Type(() => CreateAddressDto)` och utan dess
 * SE-initierare. Raden nedan pekar i stället på `AddressDto`, där landet är
 * valfritt. Det är hela rättningen av F-3: en PATCH som skickar en adress men
 * aldrig nämner landet ska BEVARA det lagrade landet, inte återställa det till
 * `SE`. POST:ens default är orörd — den bor på `CreateAddressDto`.
 *
 * Gatan, staden och postnumret är fortsatt OBLIGATORISKA när ett
 * `address`-objekt skickas; en halv adress är inte en adress, och det prövas i
 * `properties-http.db.spec.ts`.
 */
// Utelämnat är partiellt; explicit null är inte ett giltigt fältvärde.
const partialOptions = { skipNullProperties: false }
export class UpdatePropertyDto extends PartialType(
  OmitType(CreatePropertyDto, ['address'] as const),
  partialOptions,
) {
  @ApiProperty({ required: false, type: () => AddressDto })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto
}

const _kontraktUppdateraFastighet: SammaNycklar<UpdatePropertyDto, UpdatePropertyInput> = true
void _kontraktUppdateraFastighet
