import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

const INVOICE_TYPES = ['PLAN_FEE', 'AI_CREDITS', 'OTHER'] as const
const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PENDING', 'PAID', 'OVERDUE', 'VOID'] as const
const PAYMENT_METHODS = ['BANKGIRO', 'SWISH', 'MANUAL'] as const

export class CreatePlatformInvoiceDto {
  @ApiProperty() @IsUUID() organizationId!: string

  @ApiProperty({ enum: INVOICE_TYPES })
  @IsEnum(INVOICE_TYPES)
  type!: (typeof INVOICE_TYPES)[number]

  @ApiProperty({ description: 'Belopp exkl moms i SEK' })
  @IsNumber()
  @Min(0.01)
  amountNetSek!: number

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  dueDate?: string

  @ApiProperty({ required: false }) @IsString() @IsOptional() description?: string
  @ApiProperty({ required: false }) @IsDateString() @IsOptional() planPeriodStart?: string
  @ApiProperty({ required: false }) @IsDateString() @IsOptional() planPeriodEnd?: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() notes?: string
}

export class UpdatePlatformInvoiceDto {
  @ApiProperty({ required: false, enum: INVOICE_TYPES })
  @IsEnum(INVOICE_TYPES)
  @IsOptional()
  type?: (typeof INVOICE_TYPES)[number]

  @ApiProperty({ required: false }) @IsNumber() @Min(0.01) @IsOptional() amountNetSek?: number
  @ApiProperty({ required: false }) @IsDateString() @IsOptional() dueDate?: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() description?: string
  @ApiProperty({ required: false }) @IsDateString() @IsOptional() planPeriodStart?: string
  @ApiProperty({ required: false }) @IsDateString() @IsOptional() planPeriodEnd?: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() notes?: string
}

export class UpdatePlatformInvoiceStatusDto {
  @ApiProperty({ enum: INVOICE_STATUSES })
  @IsEnum(INVOICE_STATUSES)
  status!: (typeof INVOICE_STATUSES)[number]
}

export class MarkPaidDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  paymentMethod!: (typeof PAYMENT_METHODS)[number]

  @ApiProperty({ required: false })
  @IsDateString()
  @IsOptional()
  paidAt?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  paymentReference?: string
}
