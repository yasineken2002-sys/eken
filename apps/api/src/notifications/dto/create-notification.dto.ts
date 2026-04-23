import { IsEnum, IsString, IsOptional } from 'class-validator'
import { NotificationType } from '@prisma/client'

export class CreateNotificationDto {
  @IsEnum(NotificationType)
  type!: NotificationType

  @IsString()
  title!: string

  @IsString()
  message!: string

  @IsString()
  @IsOptional()
  link?: string
}
