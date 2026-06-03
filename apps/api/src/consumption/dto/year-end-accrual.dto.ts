import { IsInt, Min, Max } from 'class-validator'

export class YearEndAccrualDto {
  // Räkenskapsåret som ska periodiseras (för kalenderår = kalenderåret).
  // Accrual dateras till årets slut, reversal till nästa års första dag.
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number
}
