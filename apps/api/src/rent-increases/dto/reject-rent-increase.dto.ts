import { IsString, MaxLength, MinLength } from 'class-validator'

export class RejectRentIncreaseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  rejectionReason!: string
}
