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
import { VAT_RATES } from '@eken/shared'

/**
 * Kroppen till POST /accounting/expenses — människans väg till en bokförd
 * utgift, motsvarigheten till AI-verktyget `record_expense`.
 *
 * `amount` är BRUTTO, alltså det som lämnar bankkontot och det som står på
 * kvittot. Momsen bryts UT ur beloppet i `byggUtgiftsrader`, den läggs inte
 * till. Fältet heter därför inte `net`, och riktningen står utskriven både här
 * och där — den omvända tolkningen ger ett verifikat som BALANSERAR men bokför
 * fel summa på banken, vilket varken balansgrinden eller ett radprov kan se.
 *
 * `vatRate` är momsSATSEN ur `VAT_RATES` (@eken/shared) och används för att
 * RÄKNA FRAM momsbeloppet i gränssnittet. Det som KONTERAS är `vatAmount`;
 * avrundningen ska ske på ett ställe, hos den som har kvittot.
 *
 * SATSEN LAGRAS INTE, och det står här för att fältet annars ser ut att göra
 * mer än det gör: den valideras mot `VAT_RATES` och kastas sedan. Det är en
 * sanity-check på klientens räkning, inte ett spår. Ingen bokföringsuppgift går
 * förlorad — satsen är härledbar ur `vatAmount / (amount - vatAmount)` — men
 * den som söker efter "vilken momssats angavs" hittar den inte som ett fält.
 * Att skriva in satsen i momsradens text vore billigt, men skulle göra AI-vägens
 * och människovägens verifikattexter olika: verktyget får bara ett belopp.
 */
export class CreateExpenseDto {
  @IsISO8601({}, { message: 'Datum måste anges som ÅÅÅÅ-MM-DD' })
  date!: string

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange vad utgiften avser' })
  @MinLength(3, { message: 'Beskrivningen måste vara minst 3 tecken' })
  @MaxLength(300, { message: 'Beskrivningen får vara högst 300 tecken' })
  description!: string

  /** Leverantör/motpart. Skrivs in i verifikatets beskrivning, inte i en relation. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'Leverantörsnamnet får vara högst 200 tecken' })
  supplier?: string

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Beloppet anges med högst två decimaler' })
  @Min(0.01, { message: 'Beloppet måste vara större än noll' })
  amount!: number

  @IsOptional()
  @IsIn(VAT_RATES as unknown as number[], {
    message: `Momssatsen måste vara en av ${VAT_RATES.join(', ')} procent`,
  })
  vatRate?: number

  /** Momsbeloppet i kronor. Måste rymmas i `amount` — det är brutto. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Momsbeloppet anges med högst två decimaler' })
  @Min(0, { message: 'Momsbeloppet kan inte vara negativt' })
  vatAmount?: number

  @IsInt({ message: 'Kontonummer måste vara ett heltal' })
  @Min(1000, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  @Max(8999, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  accountNumber!: number

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'Idempotensnyckeln får vara högst 120 tecken' })
  idempotencyKey?: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string
}
