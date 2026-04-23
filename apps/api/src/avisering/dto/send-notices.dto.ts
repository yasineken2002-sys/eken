import { IsArray, IsUUID } from 'class-validator'

export class SendNoticesDto {
  @IsArray()
  @IsUUID('4', { each: true })
  noticeIds!: string[]
}
