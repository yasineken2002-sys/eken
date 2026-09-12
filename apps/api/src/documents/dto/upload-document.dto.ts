import { IsString, IsOptional, IsEnum, IsUUID, MinLength } from 'class-validator'
import { DocumentCategory } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class UploadDocumentDto {
  @IsString()
  @MinLength(1)
  @StrictString()
  name!: string

  @IsString()
  @IsOptional()
  @StrictString()
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
