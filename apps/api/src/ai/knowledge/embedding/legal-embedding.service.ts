/**
 * Voyage-embeddings — den ENDA platsen i kodbasen som rör Voyage-nätet.
 *
 * Både indexerings-scriptet (PR 3.2, `knowledge:embed`) och den semantiska
 * query-embeddingen i runtime-retrieval (PR 3.3) går genom denna wrapper. Inget
 * annat anropar Voyage direkt — en enda stryppunkt för nyckel, modell, kostnad
 * och GDPR-gräns.
 *
 * GDPR-INVARIANT (bärande, samma anda som citat-integriteten i gap A):
 *   Metoderna tar ENBART `string` / `string[]`. Klassen har INGEN injicerad
 *   PrismaService, ingen DataContext, ingen org-/tenant-/kund-källa — den KAN
 *   fysiskt inte läsa kunddata och därför aldrig råka skicka den till Voyage.
 *   Att mata in PII är inte bara förbjudet, det är omöjligt via signaturen.
 *   Anroparen ansvarar för att bara skicka publik lagtext (indexering) eller
 *   användarens råa fråga (query) — ALDRIG ett sammansatt data-context-block.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { VOYAGE_EMBEDDINGS } from '../../ai.config'

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings'

/**
 * Voyage skiljer på vad en text ÄR vid embedding: `document` för det som lagras
 * och söks i, `query` för en sökfråga. Rätt typ ger bättre retrieval-kvalitet.
 */
export type VoyageInputType = 'document' | 'query'

export interface EmbeddingResult {
  /** En vektor per inmatad text, i samma ordning som input. */
  vectors: number[][]
  /** Voyage-rapporterad tokenförbrukning för anropet (kostnadsspårning). */
  totalTokens: number
}

interface VoyageResponse {
  data: { embedding: number[]; index: number }[]
  usage: { total_tokens: number }
}

@Injectable()
export class LegalEmbeddingService {
  private readonly logger = new Logger(LegalEmbeddingService.name)
  private readonly apiKey: string
  private readonly model = VOYAGE_EMBEDDINGS.MODEL
  private readonly dim = VOYAGE_EMBEDDINGS.DIM

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('VOYAGE_API_KEY', '')
    if (!this.apiKey) {
      // Inget hårt fel i constructorn (samma mönster som StorageService) —
      // wrappern är lat: felet kastas först när någon faktiskt försöker embedda.
      this.logger.error('VOYAGE_API_KEY saknas — embedding-anrop kommer att misslyckas')
    }
  }

  /**
   * Embedda en eller flera texter. Signaturen tar ENBART råa strängar — se
   * GDPR-invarianten i filhuvudet. Returnerar vektorer i input-ordning plus
   * tokenförbrukning. Kastar tydligt (ServiceUnavailable) om nyckeln saknas,
   * nätet/Voyage failar, eller svaret har fel form/dimension — aldrig en
   * halv/tyst lyckad batch.
   */
  async embed(texts: string[], inputType: VoyageInputType): Promise<EmbeddingResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('VOYAGE_API_KEY är inte konfigurerad i servermiljön')
    }
    if (texts.length === 0) return { vectors: [], totalTokens: 0 }

    let res: Response
    try {
      res = await fetch(VOYAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
      })
    } catch (err) {
      throw new ServiceUnavailableException(
        `Voyage-anrop misslyckades (nät): ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ServiceUnavailableException(`Voyage svarade ${res.status}: ${body.slice(0, 300)}`)
    }

    const json = (await res.json()) as VoyageResponse
    const data = json.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new ServiceUnavailableException(
        `Voyage returnerade ${data?.length ?? 0} vektorer, förväntade ${texts.length}`,
      )
    }

    // Sortera på index (Voyage garanterar inte ordning) och validera dimensionen
    // mot vector(1024)-kolumnen — fel dim får aldrig nå databasen.
    const vectors = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.dim) {
        throw new ServiceUnavailableException(
          `Voyage-vektor har dimension ${v?.length ?? 0}, förväntade ${this.dim} (${this.model})`,
        )
      }
    }

    return { vectors, totalTokens: json.usage?.total_tokens ?? 0 }
  }
}
