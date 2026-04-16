import { IsEnum } from 'class-validator'

export class TransitionLeaseStatusDto {
  @IsEnum(['ACTIVE', 'DRAFT', 'EXPIRED', 'TERMINATED'])
  status!: string
}
