import { createRequire } from 'node:module'
import { HttpStatus } from '@nestjs/common'

/**
 * BETRODDA RAMVERKSFEL — klientfel som uppstår i Fastifys parser, FÖRE rutten.
 *
 * Nest registrerar exception-filtren som Fastifys errorHandler, så ett
 * parserfel når `GlobalExceptionFilter` utan att vara ett `HttpException`.
 * Filtret gjorde då allt sådant till 500 — med CRITICAL-rad i ErrorLog och ett
 * Sentry-event — trots att felet ligger i klientens anrop (EMPTY_JSON_500).
 *
 * ── VAD SOM BETROS, OCH VARFÖR INTE MER ────────────────────────────────────
 *
 * Felets egna `statusCode` och `message` betros INTE. Vilket fel som helst kan
 * bära ett `statusCode: 400`, och ett internt fel får aldrig maskeras som ett
 * klientfel. Det som betros är IDENTITETEN: felet måste vara en instans av
 * Fastifys egen felklass, och status och text kommer ur listan nedan — aldrig
 * ur felet.
 *
 * ── KLASSEN MÅSTE VARA ADAPTERNS ───────────────────────────────────────────
 *
 * `@nestjs/platform-fastify` kör sin EGEN fastify (4.x i dag), medan
 * `apps/api` själv beror på en annan (5.x). De två har olika felklasser, och
 * `instanceof` mot apps/api:s klass är ALLTID falskt för det fel parsern
 * faktiskt kastar. Klassen slås därför upp i den fastify som adaptern löser
 * upp — samma modul som skapar felet.
 *
 * ── AVGRÄNSNING ────────────────────────────────────────────────────────────
 *
 * Listan har EN post: tom kropp med `application/json`. Ogiltig JSON har redan
 * ett kontrakt (Nests errorHandler-proxy gör SyntaxError till 400 innan
 * filtret nås) och ingår inte. Att lägga till en post är att ändra ett
 * klientkontrakt och kräver ett eget HTTP-prov.
 */

interface FastifyFelkoder {
  errorCodes?: Record<string, unknown>
}

const adapternsFastify = createRequire(require.resolve('@nestjs/platform-fastify'))(
  'fastify',
) as FastifyFelkoder

type Felklass = abstract new (...args: never[]) => Error

interface BetrottFel {
  kod: string
  status: HttpStatus
  message: string
}

const BETRODDA: readonly BetrottFel[] = [
  {
    kod: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    status: HttpStatus.BAD_REQUEST,
    message:
      'Begäran saknar innehåll. Skicka en JSON-kropp, eller utelämna Content-Type: application/json.',
  },
]

function felklass(kod: string): Felklass | undefined {
  const klass = adapternsFastify.errorCodes?.[kod]
  return typeof klass === 'function' ? (klass as Felklass) : undefined
}

/** Posterna vars klass faktiskt finns i adapterns fastify — läses av specen. */
export function betroddaRamverksfel(): { kod: string; finns: boolean }[] {
  return BETRODDA.map((b) => ({ kod: b.kod, finns: felklass(b.kod) !== undefined }))
}

/**
 * Status och svensk text för ett betrott ramverksfel, eller `null` om felet
 * inte är ett sådant — då gäller filtrets vanliga regler (HttpException eller
 * 500).
 */
export function trustedFrameworkClientError(
  exception: unknown,
): { status: HttpStatus; message: string } | null {
  for (const b of BETRODDA) {
    const klass = felklass(b.kod)
    if (klass && exception instanceof klass) return { status: b.status, message: b.message }
  }
  return null
}
