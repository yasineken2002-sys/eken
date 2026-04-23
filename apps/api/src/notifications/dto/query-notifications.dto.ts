import { IsOptional, IsBoolean } from 'class-validator'
import { Transform } from 'class-transformer'

export class QueryNotificationsDto {
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  unread?: boolean
}
