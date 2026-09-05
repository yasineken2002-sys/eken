import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'
import { Transform } from 'class-transformer'
import type { CreateSupplierInvoiceInput, SammaNycklar } from '@eken/shared'
import { VAT_RATES } from '@eken/shared'

/**
 * Kroppen till POST /accounting/supplier-invoices.
 *
 * VÄRDE-import i controllern, aldrig `import type` — ValidationPipe läser
 * reflect-metadata i runtime.
 *
 * `amount` är BRUTTO: det som ska lämna bankkontot och det som står på fakturan.
 * `vatAmount` bryts UT ur det. Samma riktning som utgiftsvägen, och av samma
 * skäl — den omvända tolkningen ger ett verifikat som balanserar men bokför fel
 * summa på skulden.
 *
 * VALIDERINGEN HÄR ÄR BEKVÄMLIGHET. Balanskravet, kontouppslaget och
 * periodspärren sitter i tjänsten och i `createNumberedEntry`.
 */

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreateSupplierInvoiceInput` och raden längst ned kräver
// EXAKT samma nyckelmängd. Formen ägs alltså av `CreateSupplierInvoiceSchema` i
// @eken/shared, som webbens formulär validerar mot — ett fält som bara finns på
// ena sidan är ett kompileringsfel i stället för ett 400-svar i produktion.
//
// VÄRDEIMPORT av typen är inte nödvändig (det är en typ), men klassen självt
// måste fortsätta importeras som VÄRDE i controllern — `import type` raderar den
// och ValidationPipe tappar all metadata. Se CLAUDE.md:s DTO-regel.
export class CreateSupplierInvoiceDto implements CreateSupplierInvoiceInput {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange leverantörens namn' })
  @MinLength(2, { message: 'Leverantörsnamnet måste vara minst 2 tecken' })
  @MaxLength(200, { message: 'Leverantörsnamnet får vara högst 200 tecken' })
  supplierName!: string

  /** Leverantörens EGET fakturanummer. Vårt verifikationsnummer är ett annat. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60, { message: 'Fakturanumret får vara högst 60 tecken' })
  invoiceNumber?: string

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange vad fakturan avser' })
  @MinLength(3, { message: 'Beskrivningen måste vara minst 3 tecken' })
  @MaxLength(300, { message: 'Beskrivningen får vara högst 300 tecken' })
  description!: string

  @IsISO8601({}, { message: 'Fakturadatum måste anges som ÅÅÅÅ-MM-DD' })
  invoiceDate!: string

  @IsISO8601({}, { message: 'Förfallodatum måste anges som ÅÅÅÅ-MM-DD' })
  dueDate!: string

  @IsInt({ message: 'Kontonummer måste vara ett heltal' })
  @Min(1000, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  @Max(8999, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  expenseAccount!: number

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Beloppet anges med högst två decimaler' })
  @Min(0.01, { message: 'Beloppet måste vara större än noll' })
  amount!: number

  @IsIn(VAT_RATES as unknown as number[], {
    message: `Momssatsen måste vara en av ${VAT_RATES.join(', ')} procent`,
  })
  vatRate!: number

  /**
   * VALFRITT. Utelämnas det räknar SERVERN fram momsen ur `amount` och
   * `vatRate` (`vatFromGross`). Skickas det används det ändå bara efter att ha
   * stämt mot serverns egen uträkning — se `SupplierInvoiceService.create`.
   *
   * Skälet att alls ta emot det: fakturans tryckta momsbelopp kan avvika en öre
   * från formeln beroende på hur leverantören avrundat, och det är fakturan som
   * är verifikationsunderlaget.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Momsbeloppet anges med högst två decimaler' })
  @Min(0, { message: 'Momsbeloppet kan inte vara negativt' })
  vatAmount?: number

  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string
}

/** Kroppen till POST /accounting/supplier-invoices/:id/pay. */
export class PaySupplierInvoiceDto {
  /**
   * BETALNINGSDATUM — dagen pengarna lämnade kontot, inte i dag. Verifikatet
   * dateras hit, och fel datum lägger betalningen i fel period.
   */
  @IsISO8601({}, { message: 'Betalningsdatum måste anges som ÅÅÅÅ-MM-DD' })
  paidDate!: string
}

/**
 * NYCKELPARITET mot det delade schemat. Faller kompileringen här står det
 * saknade fältets namn i felmeddelandet.
 *
 * `implements` ovan räcker inte: en klass som utelämnar ett VALFRITT fält ur
 * interfacet passerar `implements` utan anmärkning. Raden nedan gör inte det.
 */
const _kontraktLeverantorsfaktura: SammaNycklar<
  CreateSupplierInvoiceDto,
  CreateSupplierInvoiceInput
> = true
void _kontraktLeverantorsfaktura
