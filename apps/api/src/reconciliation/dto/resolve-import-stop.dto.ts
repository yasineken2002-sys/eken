import { IsString, MaxLength, MinLength } from 'class-validator'

// IMPORTSTOPP-009: en uttrycklig upplösning kräver en motivering — den blir historik
// (vem, när, varför) på stoppet. Längden prövas också i tjänsten efter trim.
export class ResolveImportStopDto {
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string
}
