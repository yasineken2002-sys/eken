import { PartialType } from '@nestjs/swagger'
import type { SammaNycklar, UpdatePropertyInput } from '@eken/shared'
import { CreatePropertyDto } from './create-property.dto'

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
 */
// Utelämnat är partiellt; explicit null är inte ett giltigt fältvärde.
const partialOptions = { skipNullProperties: false }
export class UpdatePropertyDto extends PartialType(CreatePropertyDto, partialOptions) {}

const _kontraktUppdateraFastighet: SammaNycklar<UpdatePropertyDto, UpdatePropertyInput> = true
void _kontraktUppdateraFastighet
