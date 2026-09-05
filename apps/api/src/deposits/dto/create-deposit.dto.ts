import type { CreateDepositInput, SammaNycklar } from '@eken/shared'
import { IsUUID, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements CreateDepositInput` plus paritetsraden längst ned binder formen till
// `CreateDepositSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class CreateDepositDto implements CreateDepositInput {
  @IsUUID()
  leaseId!: string

  // Frivilligt — om utelämnat används Lease.depositAmount.
  @IsNumber()
  @Min(1)
  @IsOptional()
  amount?: number

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktDeposition: SammaNycklar<CreateDepositDto, CreateDepositInput> = true
void _kontraktDeposition
