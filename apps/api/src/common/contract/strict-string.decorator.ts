import { applyDecorators } from '@nestjs/common'
import { Transform } from 'class-transformer'
import {
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator'

/**
 * ETT STRÄNGFÄLT SOM INTE TYST FÖRVANDLAR ETT OBJEKT TILL DATA.
 *
 * ── PROBLEMET, UPPMÄTT ──────────────────────────────────────────────────────
 *
 * Den globala pipen kör `enableImplicitConversion`, så class-transformer läser
 * fältets TS-typ och kör `String(värdet)` INNAN validatorn ser något. Sond mot
 * `AnswerQuestionDto.svar` genom den riktiga pipen, före den här dekoratorn:
 *
 *     svar=1234567890  →  "1234567890"        släpptes igenom
 *     svar={"a":1}     →  "[object Object]"   släpptes igenom
 *
 * `@IsString()` prövade alltså resultatet av konverteringen, aldrig det
 * klienten skickade.
 *
 * ── VARFÖR TALFALLET OCH OBJEKTFALLET ÄR OLIKA ALLVARLIGA ───────────────────
 *
 * Ett skäl som blir `"1234567890"` är fel men läsbart — någon ser det och
 * förstår. Ett objekt som blir `"[object Object]"` är värre: strängen SER UT
 * som data, passerar varje längdkontroll, och lagras. I ett fält som bär
 * identitet — orgnummer, token, kontonummer — blir den ett värde systemet
 * sedan jämför mot.
 *
 * ── VAD DEN ACCEPTERAR ──────────────────────────────────────────────────────
 *
 *     typeof värdet === 'string'    oförändrat
 *     allt annat                    400 med ett svenskt fel som NAMNGER fältet
 *
 * Till skillnad från `@StrictBoolean()` finns här ingen godtagen "strängform"
 * att översätta: en sträng ÄR redan formen. Det som skickas är antingen en
 * sträng eller något annat, och det andra är alltid ett fel hos avsändaren.
 *
 * ── EN EGEN @Transform SKYDDAR INTE — UPPMÄTT, TVÄRTEMOT VAD JAG FÖRST SKREV ─
 *
 * Här stod att en egen `@Transform` ERSÄTTER den implicita konverteringen, och
 * att trim-fälten i `accounting/dto/*` därför redan var skyddade. Det var fel.
 * Sonden, två klasser som skiljer sig på exakt en trim-transform:
 *
 *     MED trim-@Transform,  reason: 1234567890  →  ok, "1234567890"
 *     UTAN,                 reason: 1234567890  →  ok, "1234567890"
 *
 * Skälet är mekaniskt: den implicita konverteringen körs FÖRST, så `value` inne
 * i trim-transformen är redan strängen. `typeof value === 'string'` är sant,
 * trimmen returnerar den, och `@IsString()` prövar konverteringens resultat.
 * Samma fälla som den första formen av `@IngenKoercion`, en nivå upp.
 *
 * Det är därför transformen nedan läser `obj[key]` och inte `value` — och
 * därför den måste SAMSAS med en befintlig trim i stället för att ersätta den:
 *
 *     råvärdet är en sträng   →  returnera `value` (kedjans värde, ev. trimmat)
 *     råvärdet är något annat →  returnera RÅVÄRDET, så villkoret nedan fäller
 *
 * Utan den första grenen skrev dekoratorn tillbaka det otrimmade råvärdet och
 * upphävde trimmen — uppmätt som nio röda paritetsprov i `dto-contract.spec.ts`
 * ("trimmas före längdkontroll", "båda ger samma trimmade kropp").
 */

function beskriv(varde: unknown): string {
  if (varde === null) return 'null'
  if (varde === undefined) return 'inget värde'
  if (typeof varde === 'number') return `talet ${varde}`
  if (typeof varde === 'boolean') return `${varde}`
  if (Array.isArray(varde)) return 'en lista'
  if (typeof varde === 'object') return 'ett objekt'
  return String(varde)
}

@ValidatorConstraint({ name: 'strictString', async: false })
export class StrictStringConstraint implements ValidatorConstraintInterface {
  validate(varde: unknown): boolean {
    return typeof varde === 'string'
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} måste vara text, men var ${beskriv(args.value)}`
  }
}

/**
 * Använd på VARJE strängfält i en DTO — närmare bestämt varje fält som bär
 * `@IsString()`. `check-strict-koercion.mjs` fäller ett som saknar den.
 *
 * Medlemskapet är `@IsString()` och inte TS-typen `string`, och det är mätt:
 * 118 strängtypade fält bär i stället `@IsUUID`, `@IsEmail`, `@StrictIsoDatum`
 * eller `@IsBooleanString` — validatorer som alla AVVISAR `"[object Object]"`.
 * Farlig är kombinationen som SLÄPPER IGENOM den, alltså `@IsString()` med en
 * kontroll strängen klarar. En negativ kanariefågel i vakten håller mängden
 * smal; glider den till TS-typen krävs dekoratorn på 118 fält i onödan.
 *
 * Ordningen bland fältets övriga dekoratorer saknar betydelse —
 * class-transformer kör hela sin fas före class-validator. Uppmätt i #842.
 */
export const StrictString = (): PropertyDecorator =>
  applyDecorators(
    // RÅVÄRDET ur källobjektet, inte `value`: `value` är redan konverterat när
    // transformen körs. Det var felet i den första formen av @IngenKoercion.
    // Var råvärdet en sträng lämnas kedjans värde orört, så en trim-transform
    // på samma fält överlever oavsett vilken ordning de två körs i.
    Transform(({ obj, key, value }) => {
      const ravarde = (obj as Record<string, unknown>)[key]
      return typeof ravarde === 'string' ? value : ravarde
    }),
    Validate(StrictStringConstraint),
  )
