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
}

export class CreateTenantDto {
  @ApiProperty({ enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  firstName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  lastName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  companyName?: string

  @ApiProperty()
  @IsEmail()
  email!: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  phone?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  orgNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  street?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  city?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  postalCode?: string

  // Obligatoriskt – varje hyresgäst måste skapas i kontext av ett kontrakt.
  @ApiProperty({ type: () => CreateTenantLeaseDto })
  @IsDefined({ message: 'Kontraktsdata (lease) krävs när du skapar en hyresgäst' })
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTenantLeaseDto)
  lease!: CreateTenantLeaseDto
}
