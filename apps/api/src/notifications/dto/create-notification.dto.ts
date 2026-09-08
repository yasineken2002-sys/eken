import { IsEnum, IsString, IsOptional } from 'class-validator'
import { NotificationType } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class CreateNotificationDto {
  @IsEnum(NotificationType)
  type!: NotificationType

  @IsString()
  @StrictString()
  title!: string

  @IsString()
  @StrictString()
  message!: string

  @IsString()
  @IsOptional()
  @StrictString()
  link?: string
}
