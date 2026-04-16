import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator'

const UNIT_TYPES = ['APARTMENT', 'OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'] as const
const UNIT_STATUSES = ['VACANT', 'OCCUPIED', 'UNDER_RENOVATION', 'RESERVED'] as const

export class CreateUnitDto {
  @IsUUID()
  propertyId!: string

  @IsString()
  @MinLength(1)
  name!: string

  @IsString()
  @MinLength(1)
  unitNumber!: string

  @IsEnum(UNIT_TYPES)
  type!: (typeof UNIT_TYPES)[number]

  @IsEnum(UNIT_STATUSES)
  @IsOptional()
  status?: (typeof UNIT_STATUSES)[number]

  @IsNumber()
  @Min(0)
  area!: number

  @IsNumber()
  @IsOptional()
  floor?: number

  @IsNumber()
  @IsOptional()
  rooms?: number

  @IsNumber()
  @Min(0)
  monthlyRent!: number
}
