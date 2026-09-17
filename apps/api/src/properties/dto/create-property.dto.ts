import type { CreatePropertyInput, SammaNycklar } from '@eken/shared'
import { AddressSchema, CreatePropertySchema } from '@eken/shared'
import { IsString, IsDefined, IsObject, ValidateIf, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'
import { PropertyField } from './property-field.decorator'

/**
 * ADRESSEN UTAN LANDSDEFAULT — den formen PATCH behöver.
 *
 * `AddressSchema.country` bär `.default('SE')`, och defaulten hörde hemma på
 * SKAPANDET. Den låg tidigare som en initierare på den ENDA adressklassen, och
 * eftersom `UpdatePropertyDto` ärvde samma klass fick varje PATCH med ett
 * `address`-objekt landet ifyllt — även när kroppen aldrig nämnde det. En
 * fastighet med land `NO` blev alltså `SE` av en redigering som bara ändrade
 * staden (F056/F-3).
 *
 * Här är `country` därför VALFRITT och saknar initierare: utelämnat land når
 * tjänsten som `undefined`, och tjänstens `!== undefined`-mappning låter då det
 * lagrade värdet stå kvar. Ett EXPLICIT land följer fortsatt det delade
 * schemat — tomsträngen är kontraktsgiltig och lagras som tom sträng, `null`
 * avvisas. Tomsträngen likställs alltså INTE med frånvaro, och något nytt
 * landskrav införs inte.
 */
export class AddressDto {
  @ApiProperty()
  @IsString()
  @StrictString()
  @PropertyField(AddressSchema.shape.street)
  street!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  @PropertyField(AddressSchema.shape.city)
  city!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  @PropertyField(AddressSchema.shape.postalCode)
  postalCode!: string
  @ApiProperty({ required: false })
  @IsString()
  @ValidateIf((_object, value) => value !== undefined)
  @StrictString()
  @PropertyField(AddressSchema.shape.country)
  country?: string
}

/**
 * POST:ens adress: samma fält och samma regler, plus schemats SE-default som en
 * riktig initierare.
 *
 * DEFAULTEN LIGGER HÄR, inte bara i schemat. `AddressSchema.country` har
 * `.default('SE')`, så `z.infer` säger att fältet ALLTID finns efter parsning —
 * och `properties.service.ts` tar emot `CreatePropertyInput`, alltså den
 * utparsade formen. Utan initieraren nedan vore det ett påstående utan täckning:
 * en kropp utan `country` gav `undefined` i en tjänst vars typ sa `string`.
 * Fältet är fortsatt VALFRITT på tråden; initieraren fyller i. Null är fel.
 *
 * Att den ligger på SKAPANDETS klass och inte på den gemensamma är hela
 * skillnaden mot förut: POST behåller sin default, PATCH ärver den inte.
 */
export class CreateAddressDto extends AddressDto {
  @ApiProperty({ default: 'SE' })
  override country: string = 'SE'
}

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreatePropertyInput` och raden längst ned kräver EXAKT samma
// nyckelmängd. Formen ägs av `CreatePropertySchema` i @eken/shared, som webbens formulär
// validerar mot — ett fält som bara finns på ena sidan är ett kompileringsfel i
// stället för ett 400-svar i produktion. Mönstret är #797:s; se
// packages/shared/src/schemas/contract.ts.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern — `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class CreatePropertyDto implements CreatePropertyInput {
  @ApiProperty()
  @IsString()
  @StrictString()
  @PropertyField(CreatePropertySchema.shape.name)
  name!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  @PropertyField(CreatePropertySchema.shape.propertyDesignation)
  propertyDesignation!: string
  @ApiProperty({ enum: ['RESIDENTIAL', 'COMMERCIAL', 'MIXED', 'INDUSTRIAL', 'LAND'] })
  @PropertyField(CreatePropertySchema.shape.type)
  type!: 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED' | 'INDUSTRIAL' | 'LAND'

  @ApiProperty()
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateAddressDto)
  address!: CreateAddressDto

  @ApiProperty()
  @IngenKoercion()
  @PropertyField(CreatePropertySchema.shape.totalArea)
  totalArea!: number

  @ApiProperty({ required: false })
  @ValidateIf((_object, value) => value !== undefined)
  @IngenKoercion()
  @PropertyField(CreatePropertySchema.shape.yearBuilt)
  yearBuilt?: number
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` ovan fångar fel TYP på ett
 * fält som finns i båda; den här raden fångar ett fält som SAKNAS i den ena —
 * en klass som utelämnar ett VALFRITT fält passerar `implements` utan
 * anmärkning. Faller den står fältets namn i felmeddelandet.
 */
const _kontraktFastighet: SammaNycklar<CreatePropertyDto, CreatePropertyInput> = true
void _kontraktFastighet
