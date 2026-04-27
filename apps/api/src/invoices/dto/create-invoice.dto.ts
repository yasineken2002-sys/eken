import {
  IsString,
  IsEnum,
  IsNumber,
  IsIn,
  IsOptional,
  IsUUID,
  IsDefined,
  IsDateString,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

export class InvoiceLineDto {
  @ApiProperty() @IsString() description!: string
  @ApiProperty() @IsNumber() quantity!: number
  @ApiProperty() @IsNumber() unitPrice!: number
  @ApiProperty({ enum: [0, 6, 12, 25] }) @IsIn([0, 6, 12, 25]) vatRate!: number
}

export class CreateInvoiceDto {
  @ApiProperty({ enum: ['RENT', 'DEPOSIT', 'SERVICE', 'UTILITY', 'OTHER'] })
  @IsEnum(['RENT', 'DEPOSIT', 'SERVICE', 'UTILITY', 'OTHER'])
  type!: 'RENT' | 'DEPOSIT' | 'SERVICE' | 'UTILITY' | 'OTHER'

  @ApiProperty({ description: 'Hyresavtal som fakturan tillhör. Hyresgäst härleds från avtalet.' })
  @IsDefined({ message: 'Hyresavtal måste anges' })
  @IsUUID('4', { message: 'leaseId måste vara ett giltigt UUID' })
  leaseId!: string

  @ApiProperty({ type: [InvoiceLineDto] })
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  @ArrayMinSize(1)
  lines!: InvoiceLineDto[]

  @ApiProperty() @IsDateString() dueDate!: string
  @ApiProperty() @IsDateString() issueDate!: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  reference?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  notes?: string
}
