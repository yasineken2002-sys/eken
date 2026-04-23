import { IsInt, Min, Max } from 'class-validator'

export class GenerateNoticesDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number

  @IsInt()
  @Min(2020)
  year!: number
}
