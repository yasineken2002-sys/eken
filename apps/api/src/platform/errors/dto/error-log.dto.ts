import { IsEnum, IsObject, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateFrontendErrorDto {
  @ApiProperty({ enum: ['CRITICAL', 'ERROR', 'WARNING'] })
  @IsEnum(['CRITICAL', 'ERROR', 'WARNING'])
  severity!: 'CRITICAL' | 'ERROR' | 'WARNING'

  @ApiProperty({ enum: ['WEB', 'PORTAL', 'ADMIN'] })
  @IsEnum(['WEB', 'PORTAL', 'ADMIN'])
  source!: 'WEB' | 'PORTAL' | 'ADMIN'

  @ApiProperty() @IsString() message!: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() stack?: string
  @ApiProperty({ required: false }) @IsObject() @IsOptional() context?: Record<string, unknown>
  @ApiProperty({ required: false }) @IsUUID() @IsOptional() organizationId?: string
}
