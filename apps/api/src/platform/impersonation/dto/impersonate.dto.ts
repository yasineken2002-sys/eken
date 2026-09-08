import { IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../../common/contract/strict-string.decorator'

export class ImpersonateDto {
  @ApiProperty() @IsUUID() organizationId!: string
  @ApiProperty({ required: false, description: 'Specifik user-id. Default: OWNER/ADMIN' })
  @IsUUID()
  @IsOptional()
  userId?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  reason?: string
}

export class EndImpersonationDto {
  @ApiProperty() @IsUUID() logId!: string
}
