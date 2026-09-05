import type { CreatePropertyInput, SammaNycklar } from '@eken/shared'
import {
  IsString,
  IsEnum,
  IsNumber,
  IsInt,
  IsOptional,
  Min,
  Max,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

class AddressDto {
  @ApiProperty() @IsString() street!: string
  @ApiProperty() @IsString() city!: string
  @ApiProperty() @IsString() postalCode!: string
  // DEFAULTEN LIGGER HÄR, inte bara i schemat. `AddressSchema.country` har
  // `.default('SE')`, så `z.infer` säger att fältet ALLTID finns efter parsning
  // — och `properties.service.ts` tar emot `CreatePropertyInput`, alltså den
  // utparsade formen. Utan initieraren nedan var det ett påstående utan täckning:
  // en kropp utan `country` gav `undefined` i en tjänst vars typ sa `string`.
  // Fältet är fortsatt VALFRITT på tråden (@IsOptional); initieraren fyller i.
  @ApiProperty({ default: 'SE' }) @IsString() @IsOptional() country: string = 'SE'
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
  @ApiProperty() @IsString() name!: string
  @ApiProperty() @IsString() propertyDesignation!: string
  @ApiProperty({ enum: ['RESIDENTIAL', 'COMMERCIAL', 'MIXED', 'INDUSTRIAL', 'LAND'] })
  @IsEnum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED', 'INDUSTRIAL', 'LAND'])
  type!: 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED' | 'INDUSTRIAL' | 'LAND'

  @ApiProperty() @ValidateNested() @Type(() => AddressDto) address!: AddressDto

  @ApiProperty() @IsNumber() @Min(1) totalArea!: number

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1800)
  @Max(new Date().getFullYear())
  @IsOptional()
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
