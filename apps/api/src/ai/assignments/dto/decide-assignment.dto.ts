import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

/**
 * Beslutet om ett uppdrag: ja eller nej, och vid nej ett skäl.
 *
 * Skälet är valfritt HÄR och obligatoriskt i tjänsten vid `REJECTED`. Det är
 * inte en dubblering av misstag: DTO:t kan inte uttrycka "krävs bara när fältet
 * bredvid har ett visst värde", och en `@ValidateIf` hade flyttat regeln till en
 * plats där bara HTTP-vägen ser den. Tjänsten är den enda ingången som alla
 * anropare passerar.
 */
export class DecideAssignmentDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED'

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string
}
