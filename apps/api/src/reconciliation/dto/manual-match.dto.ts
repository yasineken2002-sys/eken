import { IsUUID, IsOptional, ValidateIf } from 'class-validator'

// XOR — exakt en av invoiceId/rentNoticeId måste anges. Klassvalidering
// (gemensam) körs i service-lagret eftersom class-validator inte har en
// inbyggd "exactly one of"-dekoratör. Här markerar vi bara att fälten är
// frivilliga som UUID när satta.
export class ManualMatchDto {
  @IsOptional()
  @ValidateIf((o) => o.invoiceId !== undefined)
  @IsUUID()
  invoiceId?: string

  @IsOptional()
  @ValidateIf((o) => o.rentNoticeId !== undefined)
  @IsUUID()
  rentNoticeId?: string
}
