import {
  IsEnum,
  IsString,
  IsEmail,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  IsDefined,
  IsObject,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'

// Hyresgäst kan inte längre skapas fristående – ett kontrakt mot en enhet
// är obligatoriskt. Datamodellen är: Org → Property → Unit → Lease → Tenant.
export class CreateTenantLeaseDto {
  @ApiProperty()
  @IsUUID()
  unitId!: string

  @ApiProperty()
  @IsDateString()
  startDate!: string

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  endDate?: string

  @ApiProperty()
  @IsNumber()
  @Min(0)
  monthlyRent!: number

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  depositAmount?: number

  // Övriga villkor / särskilda bestämmelser (Kontraktsmall 2.0). Visas som
  // egen § i kontraktet när satt; tom sträng innebär ingen § skapas.
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  specialTerms?: string
}

export class CreateTenantDto {
  @ApiProperty({ enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  firstName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  lastName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  companyName?: string

  @ApiProperty()
  @IsEmail()
  email!: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  phone?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  orgNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  street?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  city?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  postalCode?: string

  // Obligatoriskt – varje hyresgäst måste skapas i kontext av ett kontrakt.
  @ApiProperty({ type: () => CreateTenantLeaseDto })
  @IsDefined({ message: 'Kontraktsdata (lease) krävs när du skapar en hyresgäst' })
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTenantLeaseDto)
  lease!: CreateTenantLeaseDto
}
