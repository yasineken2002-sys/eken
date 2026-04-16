import { IsUUID } from 'class-validator'

export class ManualMatchDto {
  @IsUUID()
  invoiceId!: string
}
