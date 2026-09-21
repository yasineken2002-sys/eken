import type {
  ConfirmImportInput,
  CreateBankAccountInput,
  EditedTransactionInput,
  SammaNycklar,
} from '@eken/shared'
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

// Bekräftelse-payload från granskningsvyn. Användaren kan ha redigerat
// rader (justerat OCR, ändrat belopp, tagit bort distraktioner) innan
// commit — vi accepterar hela arrayen och skriver om parsedData.
export class EditedTransactionDto {
  @IsString()
  @StrictString()
  date!: string // YYYY-MM-DD

  @IsString()
  @StrictString()
  description!: string

  @IsOptional()
  @IsString()
  @StrictString()
  ocr?: string | null

  @IsNumber()
  amount!: number

  @IsOptional()
  @IsBoolean()
  @StrictBoolean()
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

  // #F034c — målkontot. Valfritt i DTO:n så att felet kommer från
  // kontoupplösningen, som kan skilja "organisationen saknar konton" från
  // "du glömde välja". Se ConfirmImportSchema.
  @IsOptional()
  @IsString()
  @StrictString()
  bankAccountId?: string
}

/**
 * #F034c — lägga upp ett målkonto. Egen DTO, se `CreateBankAccountSchema`.
 *
 * ── GRÄNSERNA STÅR HÄR, INTE BARA I ZOD ────────────────────────────────────
 *
 * Första versionen hade bara `@IsString()`. `SammaNycklar`-raden nedan var
 * grön — nycklarna stämde — och paritetsPROVET fällde ändå, för det kör samma
 * ogiltiga kropp genom BÅDA sidorna och kräver samma svar.
 *
 * Utfallet: `{ zod: false, dto: true }` för `name: ''`. Zod avvisade via
 * `min(1)`, DTO:n släppte igenom. Ett konto utan namn hade alltså kunnat skapas
 * via API:t — och sedan inte gått att välja i importens kontoväljare, eftersom
 * det är NAMNET valet görs på. En rad som bara går att skapa, aldrig använda.
 *
 * Gränserna speglar nu schemat exakt: name 1–120, accountNumber max 64.
 */
export class CreateBankAccountDto implements CreateBankAccountInput {
  @IsString()
  @StrictString()
  @MinLength(1)
  @MaxLength(120)
  name!: string

  @IsOptional()
  @IsString()
  @StrictString()
  @MaxLength(64)
  accountNumber?: string
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

/** #F034c — samma paritet för målkontots DTO. */
const _kontraktBankkonto: SammaNycklar<CreateBankAccountDto, CreateBankAccountInput> = true
void _kontraktBankkonto
