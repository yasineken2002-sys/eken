import { IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ImpersonateDto {
  @ApiProperty() @IsUUID() organizationId!: string
  @ApiProperty({ required: false, description: 'Specifik user-id. Default: OWNER/ADMIN' })
  @IsUUID()
  @IsOptional()
  userId?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  reason?: string
}

export class EndImpersonationDto {
  @ApiProperty() @IsUUID() logId!: string
}
