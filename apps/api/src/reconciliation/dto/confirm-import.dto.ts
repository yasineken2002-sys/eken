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

export class ConfirmImportDto {
  // Om frånvarande används parsedData från DRAFT som den är.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditedTransactionDto)
  transactions?: EditedTransactionDto[]
}
