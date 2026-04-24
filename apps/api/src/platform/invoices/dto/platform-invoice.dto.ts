import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreatePlatformInvoiceDto {
  @ApiProperty() @IsUUID() organizationId!: string
  @ApiProperty() @IsNumber() @Min(0) amount!: number
  @ApiProperty() @IsDateString() dueDate!: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() description?: string
  @ApiProperty({ required: false, description: 'Fakturanummer (genereras automatiskt annars)' })
  @IsString()
  @IsOptional()
  invoiceNumber?: string
}

export class UpdatePlatformInvoiceStatusDto {
  @ApiProperty({ enum: ['PENDING', 'PAID', 'OVERDUE', 'VOID'] })
  @IsEnum(['PENDING', 'PAID', 'OVERDUE', 'VOID'])
  status!: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
}
