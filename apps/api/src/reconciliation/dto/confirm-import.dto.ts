import type { ConfirmImportInput, EditedTransactionInput, SammaNycklar } from '@eken/shared'
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

// Bekräftelse-payload från granskningsvyn. Användaren kan ha redigerat
// rader (justerat OCR, ändrat belopp, tagit bort distraktioner) innan
// commit — vi accepterar hela arrayen och skriver om parsedData.
export class EditedTransactionDto {
  @IsString()
  date!: string // YYYY-MM-DD

  @IsString()
  description!: string

  @IsOptional()
  @IsString()
  ocr?: string | null

  @IsNumber()
  amount!: number

  @IsOptional()
  @IsBoolean()
  isIncoming?: boolean
}

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements ConfirmImportInput` plus paritetsraden längst ned binder formen till
// `ConfirmImportSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class ConfirmImportDto implements ConfirmImportInput {
  // Om frånvarande används parsedData från DRAFT som den är.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditedTransactionDto)
  transactions?: EditedTransactionDto[]
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktBekraftaImport: SammaNycklar<ConfirmImportDto, ConfirmImportInput> = true
void _kontraktBekraftaImport

/** OCH RADTYPEN — se #801: toppnivåns paritet ser inte en nästlad typ. */
const _kontraktImportRad: SammaNycklar<EditedTransactionDto, EditedTransactionInput> = true
void _kontraktImportRad
