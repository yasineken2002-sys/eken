import { applyDecorators } from '@nestjs/common'
import { Transform } from 'class-transformer'
import {
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator'

/**
 * ETT BOOLESKT FÄLT SOM INTE KAN LÄSA ETT NEJ SOM ETT JA.
 *
 * ── PROBLEMET, UPPMÄTT ──────────────────────────────────────────────────────
 *
 * Den globala pipen kör `transform: true` med `enableImplicitConversion: true`
 * (`VALIDATION_PIPE_OPTIONS`). class-transformer läser fältets TS-typ och kör
 * `Boolean(värdet)` INNAN någon validator ser något. Sond mot den riktiga pipen
 * och `ConfirmActionDto`, före den här dekoratorn:
 *
 *     confirmed="false"  →  true      confirmed="yes"  →  true
 *     confirmed="0"      →  true      confirmed=1      →  true
 *
 * `@IsBoolean()` prövade alltså resultatet av konverteringen, aldrig det
 * klienten skickade. Ett fält som betyder JA/NEJ blev ett fält som bara kunde
 * betyda JA — och för `confirmed` är det hyresvärdens ja till att en
 * AI-föreslagen handling ska utföras.
 *
 * ── VAD DEN ACCEPTERAR, OCH VAD DEN AVVISAR ─────────────────────────────────
 *
 *     true   false          booleaner, oförändrade
 *     "true" "false"        strängformen, som en HTTP-klient rimligen skickar
 *     allt annat            400 med ett svenskt fel som NAMNGER fältet
 *
 * Strängformen är med MED FLIT. En klient som skickar `"false"` menar NEJ, och
 * att avvisa den hade gjort det svårare att göra rätt utan att göra det svårare
 * att göra fel. Det farliga är inte att strängar förekommer — det är att de
 * tolkas av `Boolean()`, som bara känner tom och icke-tom.
 *
 * `"yes"`, `"0"`, `1` och `""` avvisas alla. De är inte booleska värden, och en
 * tolkning av dem hade varit en gissning om avsikten.
 *
 * ── VARFÖR EN DEKORATOR OCH INTE EN GLOBAL INSTÄLLNING ──────────────────────
 *
 * `enableImplicitConversion` behövs för query- och parameterbindning, där ALLT
 * anländer som sträng och `?sida=2` ska bli talet 2. Att slå av den globalt hade
 * brutit varje sådan bindning. Spärren hör därför hemma på fältet.
 *
 * ── FÖRHÅLLANDE TILL `@IngenKoercion()` ─────────────────────────────────────
 *
 * `@IngenKoercion()` läser råvärdet och lämnar det orört; för ett booleskt fält
 * betyder det att `"true"` AVVISAS. Den här är mekanismen för BOOLEANER och
 * ersätter den där. `@IngenKoercion()` finns kvar för strängfält, där frågan är
 * en annan: där ska `42` inte bli `"42"`, och det finns ingen strängform att
 * acceptera.
 */

/** `true`/`false` och deras strängformer. Allt annat passerar som det är. */
function normalisera(varde: unknown): unknown {
  if (typeof varde === 'boolean') return varde
  if (varde === 'true') return true
  if (varde === 'false') return false
  // Odefinierat lämnas orört så `@IsOptional()` fortfarande kan hoppa över
  // fältet. Ett saknat fält är inte ett felaktigt fält.
  if (varde === undefined) return undefined
  return varde
}

function beskriv(varde: unknown): string {
  if (varde === null) return 'null'
  if (typeof varde === 'string') return `strängen "${varde}"`
  if (typeof varde === 'number') return `talet ${varde}`
  if (Array.isArray(varde)) return 'en lista'
  if (typeof varde === 'object') return 'ett objekt'
  return String(varde)
}

@ValidatorConstraint({ name: 'strictBoolean', async: false })
export class StrictBooleanConstraint implements ValidatorConstraintInterface {
  validate(varde: unknown): boolean {
    return typeof varde === 'boolean'
  }

  defaultMessage(args: ValidationArguments): string {
    // FÄLTNAMNET STÅR I MEDDELANDET. Utan det får en klient med tio booleska
    // fält veta att ETT av dem är fel, men inte vilket — och felsöker då fel.
    return `${args.property} måste vara true eller false, men var ${beskriv(args.value)}`
  }
}

/**
 * Använd på VARJE booleskt DTO-fält. `check-strict-koercion.mjs` fäller ett som
 * saknar den.
 *
 * Ordningen bland fältets övriga dekoratorer saknar betydelse —
 * class-transformer kör hela sin fas före class-validator. Uppmätt; ett tidigare
 * docblock påstod motsatsen.
 */
export const StrictBoolean = (): PropertyDecorator =>
  applyDecorators(
    Transform(({ obj, key }) => normalisera((obj as Record<string, unknown>)[key])),
    Validate(StrictBooleanConstraint),
  )
