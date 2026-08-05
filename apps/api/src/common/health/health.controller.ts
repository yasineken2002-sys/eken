import { Controller, Get } from '@nestjs/common'
import { ApiOkResponse } from '@nestjs/swagger'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import { Public } from '../decorators/public.decorator'
import { PrismaHealthIndicator } from './prisma.health'

/**
 * Byggd commit-SHA, ur Railways egen variabel — ingen egen mekanism.
 * `RAILWAY_GIT_COMMIT_SHA` sätts automatiskt för GitHub-triggade deployer, vilket
 * är hur API:t deployas. `GIT_COMMIT_SHA` är andrahand: konventionen finns redan
 * (`instrument.ts` läser den för Sentrys release) och ger en väg att sätta värdet
 * manuellt om Railways skulle utebli, utan kodändring.
 *
 * 'unknown' ÄR OCKSÅ DETEKTORN. Står det 'unknown' i produktion är
 * leveranskedjan trasig. Därför måste värdet vara synligt fel: tom sträng
 * försvinner i ögat, `null` går inte att skilja från ett fält som aldrig skrevs,
 * och 'local' skulle påstå ett känt tillstånd.
 *
 * BLANKT RÄKNAS SOM FRÅNVARANDE. `??` faller bara tillbaka på null/undefined —
 * en variabel som är SATT men tom hade gett `revision: ""`, alltså exakt det
 * osynliga värde fallbacken finns för att undvika. En variabel som interpoleras
 * från en saknad annan blir tom, inte oskriven. (Hittades genom att köra igång
 * servern med tomma variabler; `delete` i enhetstesterna kunde inte se det.)
 */
function readNonBlank(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function buildRevision(): string {
  return readNonBlank('RAILWAY_GIT_COMMIT_SHA') ?? readNonBlank('GIT_COMMIT_SHA') ?? 'unknown'
}

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
  ) {}

  /**
   * Deploy-workflowen bygger bara de tre SPA:erna; API:t deployas av Railways
   * git-integration utanför GitHub Actions. Ett grönt Deploy-jobb bevisar
   * därför inte att en API-ändring nått produktion, och endpointen visade bara
   * ATT deployen var frisk — aldrig VILKEN kod som kördes.
   */
  @Get()
  @Public()
  // ORDNINGEN ÄR LASTBÄRANDE: `@ApiOkResponse` MÅSTE ligga OVANFÖR
  // `@HealthCheck()`. Dekoratorer appliceras nedifrån och upp, och
  // `@HealthCheck()` sätter sitt egna fasta Terminus-schema (utan `revision`)
  // på samma metadatanyckel. Ligger vår under blir den överskriven och Swagger
  // (dev: /api/docs) beskriver en svarsform som inte längre stämmer — samma
  // sorts tysta kontraktsdrift som revisionen finns för att upptäcka på
  // deploy-nivå. Verifierat mot /api/docs-json, inte antaget.
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        info: { type: 'object', nullable: true, additionalProperties: { type: 'object' } },
        error: { type: 'object', nullable: true, additionalProperties: { type: 'object' } },
        details: { type: 'object', additionalProperties: { type: 'object' } },
        revision: {
          type: 'string',
          description: "Byggd commit-SHA, eller 'unknown' när deployen inte angav någon.",
          example: '9c73e7878280d9487679ea09e81ed44d31ee16b3',
        },
      },
    },
  })
  @HealthCheck()
  async check() {
    const result = await this.health.check([() => this.prismaHealth.isHealthy('database')])

    // ENDAST REVISIONEN — endpointen är @Public. Branch, byggnummer, miljönamn,
    // domäner och tjänste-id:n hör inte hemma i ett svar vem som helst kan hämta.
    //
    // TILLAGT FÄLT, INTE ÄNDRAD STRUKTUR, och medvetet UTANFÖR Terminus
    // indikator-lista: en indikator kan rapportera `down` och skulle då fälla
    // hela hälsokontrollen. Railway pollar endpointen (`healthcheckPath` i
    // railway.toml) och skulle starta om tjänsten. Att veta vilken revision som
    // kör får aldrig kunna ta ned den.
    //
    // AVGRÄNSNING: `health.check` kastar vid fel, så revisionen saknas i
    // 503-svaret. Felvägen har redan ett eget hål (GlobalExceptionFilter läser
    // bara `message` ur Terminus-kroppen och tappar all indikator-detalj) —
    // eget ärende, inte något den här ändringen ska bunta in.
    return { ...result, revision: buildRevision() }
  }
}
