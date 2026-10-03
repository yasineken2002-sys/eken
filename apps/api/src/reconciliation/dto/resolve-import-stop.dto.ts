import type { ResolveImportStopInput, SammaNycklar } from '@eken/shared'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'

// IMPORTSTOPP-009: en uttrycklig upplösning kräver en motivering — den blir historik
// (vem, när, varför) på stoppet. Längden prövas också i tjänsten efter trim.
// `implements` + paritetsraden binder formen till `ResolveImportStopSchema` i @eken/shared.
export class ResolveImportStopDto implements ResolveImportStopInput {
  @StrictString()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string
}

const _kontraktImportstopp: SammaNycklar<ResolveImportStopDto, ResolveImportStopInput> = true
void _kontraktImportstopp
