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
  @ApiProperty({ default: 'SE' }) @IsString() @IsOptional() country?: string
}

export class CreatePropertyDto {
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
