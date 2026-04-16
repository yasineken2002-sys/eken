import { IsString, IsOptional, IsEnum, IsUUID, MinLength } from 'class-validator'
import { DocumentCategory } from '@prisma/client'

export class UploadDocumentDto {
  @IsString()
  @MinLength(1)
  name!: string

  @IsString()
  @IsOptional()
  description?: string

  @IsEnum(DocumentCategory)
  @IsOptional()
  category?: DocumentCategory

  @IsUUID()
  @IsOptional()
  propertyId?: string

  @IsUUID()
  @IsOptional()
  unitId?: string

  @IsUUID()
  @IsOptional()
  leaseId?: string

  @IsUUID()
  @IsOptional()
  tenantId?: string
}
