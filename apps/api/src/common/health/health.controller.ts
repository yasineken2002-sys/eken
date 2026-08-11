import { Controller, Get, Logger } from '@nestjs/common'
import { ApiOkResponse } from '@nestjs/swagger'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import { Public } from '../decorators/public.decorator'
import { PrismaService } from '../prisma/prisma.service'
import { PrismaHealthIndicator } from './prisma.health'
import { buildLegalChunks } from '../../ai/knowledge/retrieval/legal-chunk'
import { VOYAGE_EMBEDDINGS } from '../../ai/ai.config'

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

/**
 * Lagtext/vektor-paritet: antal paragraf-chunkar i bundlen mot antal vektorer i
 * LegalChunkEmbedding. Glider de isär är den semantiska kanalen degraderad — de
 * chunkar som saknar vektor kan aldrig hittas semantiskt.
 */
interface LegalKnowledgeParity {
  /** Chunkar i bundlen. Räknat VID BOOT — se kommentaren i controllern. */
  chunks: number
  /** Rader i LegalChunkEmbedding för den aktiva modellen. Räknat PER ANROP. */
  vectors: number | null
  /** Aktiv embedding-modell. Rader för andra modeller räknas inte. */
  model: string
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  /**
   * BUNDLE-ANTALET RÄKNAS VID BOOT, DB-ANTALET PER ANROP — och asymmetrin är
   * avsiktlig, inte en förenkling.
   *
   * Chunkarna är kompilerade in i imagen (`generated/*.ts`). Talet kan per
   * konstruktion inte ändras medan processen lever; en ny lagtext kräver en ny
   * deploy, alltså en ny boot. Att räkna om det per anrop vore att fråga om
   * något som inte kan ha ändrats.
   *
   * Radantalet KAN ändras under drift: `knowledge:embed` körs för hand mot en
   * levande databas. Exakt det hände 2026-08-11 (#400) — prod omindexerades
   * utan omstart. Ett boot-räknat DB-tal hade visat 420 i en halvtimme efter
   * att sanningen var 427, och den fördröjningen är hela skälet till att fältet
   * finns: boot-loggen kunde inte bekräfta omindexeringen förrän en orelaterad
   * deploy råkade ske (#414).
   *
   * Kostnaden är mätt, inte antagen. `count(*)` mot prod går via Index Only
   * Scan på `LegalChunkEmbedding_lawId_idx`: **0.10 ms** (fem upprepningar:
   * 0.116 / 0.111 / 0.104 / 0.107 / 0.095 ms, 427 rader, 8.4 MB). Endpointen
   * gör redan en DB-rundtur (`SELECT 1` i PrismaHealthIndicator), så detta
   * fördubblar antalet frågor från en trivial till två triviala. Även vid
   * polling var femte sekund blir det ~1.7 s DB-tid per dygn. Ingen cache
   * behövs; en cache hade dessutom återinfört exakt den fördröjning fältet
   * finns för att ta bort.
   */
  private readonly bundledChunkCount = buildLegalChunks().length

  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private prisma: PrismaService,
  ) {}

  /**
   * Rader för den AKTIVA modellen. Kastar aldrig: kan talet inte läsas blir det
   * `null`, vilket är ett faktum ("kunde inte räknas"), inte ett omdöme.
   * Endpointen får aldrig gå ned för det här fältets skull — Railway pollar den
   * och skulle starta om tjänsten. Samma avvägning som för `revision`.
   */
  private async countVectors(): Promise<number | null> {
    try {
      return await this.prisma.legalChunkEmbedding.count({
        where: { model: VOYAGE_EMBEDDINGS.MODEL },
      })
    } catch (err) {
      this.logger.warn(
        `Kunde inte räkna LegalChunkEmbedding: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

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
        legalKnowledge: {
          type: 'object',
          description:
            'Lagtext/vektor-paritet. Bär BÅDA TALEN, inte ett omdöme: "427 = 427" går ' +
            'att kontrollera, "ok" går inte. Glider de isär saknar mellanskillnaden ' +
            'vektor och kan aldrig hittas semantiskt.',
          properties: {
            chunks: { type: 'number', example: 427 },
            vectors: { type: 'number', nullable: true, example: 427 },
            model: { type: 'string', example: 'voyage-4' },
          },
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
    // FÄLTET BÄR BÅDA TALEN, INTE ETT OMDÖME. Ingen `parity: "ok"`-flagga:
    // "427 = 427" går att kontrollera av den som läser, "ok" går inte — då
    // måste man lita på vår jämförelse i stället för att göra den själv. Samma
    // skäl som att paritetsraden i boot-loggen skriver ut talen.
    //
    // PÅVERKAR INTE `status`, och ligger därför utanför Terminus
    // indikator-lista. En degraderad semantisk kanal är ett kvalitetsproblem i
    // retrieval, inte skäl att markera tjänsten som nere och få Railway att
    // starta om den.
    const legalKnowledge: LegalKnowledgeParity = {
      chunks: this.bundledChunkCount,
      vectors: await this.countVectors(),
      model: VOYAGE_EMBEDDINGS.MODEL,
    }

    return { ...result, revision: buildRevision(), legalKnowledge }
  }
}
