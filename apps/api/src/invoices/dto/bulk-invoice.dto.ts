import {
  IsDateString,
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsBoolean,
  IsArray,
  IsUUID,
} from 'class-validator'

export class BulkInvoiceDto {
  @IsDateString()
  issueDate!: string

  @IsDateString()
  dueDate!: string

  @IsString()
  @IsOptional()
  description?: string

  @IsNumber()
  @Min(0)
  @IsOptional()
  vatRate?: number

  @IsBoolean()
  @IsOptional()
  sendEmail?: boolean

  @IsArray()
  @IsOptional()
  @IsUUID('4', { each: true })
  leaseIds?: string[]
}
