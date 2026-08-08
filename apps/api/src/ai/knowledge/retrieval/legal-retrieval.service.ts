/**
 * Hybrid-retrieval över den verifierade lagtexten (Etapp 3, PR 3.3a + 3.3b):
 * BM25 (lexikal kanal, i minnet) + Voyage/pgvector (semantisk kanal) fuserade
 * med Reciprocal Rank Fusion — ENBART för ordningen av kandidaterna.
 *
 * BÄRANDE INVARIANT (gap B): resultatet bär KANAL-RENA grindsignaler SEPARAT
 * från fused-ordningen. Miss-grindens BM25-golv (legal-grounding.ts) läser
 * BARA `lexical` — bit-för-bit identisk med retrieveLegalChunks(query,
 * {topK: 3}); cosine-golvet (3.3b) läser BARA `semanticTopCosine` (bästa
 * giltiga pgvector-träffens cosine). Den fuserade listan kan per konstruktion
 * inte ändra ett grindutfall; den ändrar bara VILKA chunkar relevansdomaren
 * och grundningen ser när grinden redan släppt in en kandidat.
 *
 * GDPR-INVARIANT (query-PII): retrieve() tar ENBART `query: string` och
 * klassens enda deps är PrismaService + LegalEmbeddingService — ingen
 * DataContext, ingen Memory, ingen org-/tenant-källa. Den enda sträng som
 * lämnar processen (till Voyage) är användarens råa fråga ordagrant — att
 * skicka ett sammansatt data-context-block är fysiskt omöjligt via signaturen.
 * Konstruktor-deps låses av legal-retrieval.service.spec.ts.
 *
 * STALE-HASH-VAKT: en lagrad vektor används bara om radens contentHash matchar
 * runtime-textens sha256 (legalChunkContentHash). Glömd omindexering efter en
 * lagtextändring blir alltså KVALITETSBORTFALL (raden släpps + varning) —
 * aldrig fel lagtext framför domaren. Chunk-texten kommer ALLTID ur
 * LEGAL_KNOWLEDGE i minnet, aldrig ur databasen.
 *
 * FALLBACK: Voyage nere / nyckel saknas / tom eller stale tabell → BM25-only
 * (fused === lexical), exakt dagens beteende, loggad varning. Det gör också
 * CI deterministisk utan nät.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { LegalEmbeddingService } from '../../knowledge/embedding/legal-embedding.service'
import { VOYAGE_EMBEDDINGS } from '../../ai.config'
import {
  buildLegalChunks,
  legalChunkId,
  legalChunkContentHash,
  type LegalChunk,
} from './legal-chunk'
import {
  retrieveLegalChunks,
  scoreAllLegalChunks,
  type HybridLegalRetrieval,
  type RetrievedChunk,
} from './legal-retrieval'
import { GROUNDING_TOP_K } from '../grounding/legal-grounding'

/** Kanal-bredd före fusion: båda kanalerna bidrar upp till 10 kandidater. */
const CHANNEL_TOP_K = 10
/** RRF-konstanten k i 1/(k+rank) — standardvärdet 60 (rankbaserad, parameterfri i praktiken). */
const RRF_K = 60

/** En pgvector-träff efter stale-hash-vakten: chunk ur minnet + cosine ur DB. */
interface SemanticHit {
  chunk: LegalChunk
  cosine: number
}

interface EmbeddingRow {
  id: string
  contentHash: string
  distance: number
}

@Injectable()
export class LegalRetrievalService implements OnModuleInit {
  private readonly logger = new Logger(LegalRetrievalService.name)
  /** legalChunkId → chunk, memoiserad (lagtexten är statisk per process). */
  private chunkById: Map<string, LegalChunk> | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: LegalEmbeddingService,
  ) {}

  /**
   * PARITETSKONTROLL (#382): jämför antalet chunkar i bundlen mot antalet
   * lagrade vektorer för den AKTIVA modellen, och varnar vid avvikelse.
   *
   * VARFÖR UPPSTART: lagtexten är kompilerad in i imagen (generated/*.ts) medan
   * vektorerna bor i databasen. Boot är den ENDA punkt där de två artefakterna
   * paras ihop — och det är exakt vad en rollback gör: en gammal image mot en
   * nyare databas.
   *
   * VARFÖR DEN BEHÖVS: stale-hash-vakten i semanticChannel() itererar över
   * DB-RADER. En chunk som SAKNAR rad passerar därför helt tyst — vakten ser
   * den aldrig. Rullas imagen tillbaka efter att rader raderats får BM25 alltså
   * tillbaka full förmåga att citera en borttagen lag som "gällande lydelse",
   * utan att en enda varning skrivs. Räkningen fångar BÅDA riktningarna:
   * överskott (föräldralösa rader äter top-K-platser) och underskott (chunkar
   * utan vektor → tyst kvalitetsbortfall).
   *
   * DEGRADERING FÖRBLIR DEGRADERING: kastar aldrig, blockerar aldrig boot.
   * Ett trasigt tillstånd ska synas, inte fälla API:et.
   */
  async onModuleInit(): Promise<void> {
    const expected = buildLegalChunks().length
    let stored: number
    try {
      stored = await this.prisma.legalChunkEmbedding.count({
        where: { model: VOYAGE_EMBEDDINGS.MODEL },
      })
    } catch (err) {
      this.logger.warn(
        `Paritetskontrollen kunde inte köras (räkning misslyckades): ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    if (stored === expected) return

    const riktning =
      stored > expected
        ? `${stored - expected} FÖRÄLDRALÖSA rader (lagtext borttagen utan att vektorerna städades)`
        : `${expected - stored} chunkar SAKNAR vektor (omindexering ej körd, eller image återrullad efter radering)`
    this.logger.warn(
      `Lagtext/vektor-paritet BRUTEN för modell ${VOYAGE_EMBEDDINGS.MODEL}: ` +
        `${expected} chunkar i bundlen, ${stored} rader i LegalChunkEmbedding — ${riktning}. ` +
        'Semantiska kanalen är degraderad; kör knowledge:embed och städa bort rader utan chunk.',
    )
  }

  /**
   * Hybrid-retrieval för en juridisk fråga. Tar ENBART den råa frågesträngen —
   * se GDPR-invarianten i filhuvudet. Kastar aldrig: varje fel i den semantiska
   * kanalen degraderar till BM25-only med loggad varning.
   */
  async retrieve(query: string): Promise<HybridLegalRetrieval> {
    const lexical = retrieveLegalChunks(query, { topK: GROUNDING_TOP_K })

    let semantic: SemanticHit[]
    try {
      semantic = await this.semanticChannel(query)
    } catch (err) {
      this.logger.warn(
        `Semantisk kanal otillgänglig — BM25-only fallback: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { lexical, fused: lexical, semanticTopCosine: null }
    }
    if (semantic.length === 0) {
      this.logger.warn(
        'Semantisk kanal gav 0 giltiga träffar (tom/stale LegalChunkEmbedding?) — BM25-only fallback',
      )
      return { lexical, fused: lexical, semanticTopCosine: null }
    }

    // Toppsignalen till cosine-golvet (3.3b): bästa GILTIGA träffens cosine.
    // semanticChannel bevarar pgvector-ordningen (närmast först), så [0] är
    // kanalens topp efter stale-hash-vakten.
    return {
      lexical,
      fused: this.fuse(query, semantic),
      semanticTopCosine: semantic[0]!.cosine,
    }
  }

  /**
   * Semantiska kanalen: embedda frågan (input_type 'query' — dokumenten
   * indexerades som 'document' i PR 3.2) och närmaste-grann-sök i pgvector.
   * Endast rader för den AKTIVA embedding-modellen används, och varje rad
   * passerar stale-hash-vakten innan den får bli en kandidat.
   */
  private async semanticChannel(query: string): Promise<SemanticHit[]> {
    const { vectors } = await this.embedder.embed([query], 'query')
    const vectorLiteral = `[${vectors[0]!.join(',')}]`

    // `<=>` = cosine-distans (HNSW-indexet är byggt med vector_cosine_ops).
    const rows = await this.prisma.$queryRaw<EmbeddingRow[]>`
      SELECT id, "contentHash", (embedding <=> ${vectorLiteral}::vector)::float8 AS distance
      FROM "LegalChunkEmbedding"
      WHERE model = ${VOYAGE_EMBEDDINGS.MODEL}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${CHANNEL_TOP_K}
    `

    const byId = this.getChunkById()
    const hits: SemanticHit[] = []
    for (const row of rows) {
      const chunk = byId.get(row.id)
      if (!chunk) {
        this.logger.warn(
          `Stale embedding-rad: id "${row.id}" finns inte i LEGAL_KNOWLEDGE — släpps (kör knowledge:embed)`,
        )
        continue
      }
      if (row.contentHash !== legalChunkContentHash(chunk.text)) {
        this.logger.warn(
          `Stale embedding-rad: contentHash för "${row.id}" matchar inte aktuell lagtext — släpps (kör knowledge:embed)`,
        )
        continue
      }
      hits.push({ chunk, cosine: 1 - row.distance })
    }
    return hits
  }

  /**
   * Reciprocal Rank Fusion: fusionsscore = Σ 1/(RRF_K + rank) över kanalerna
   * (rank 1-baserad). Fuserade chunkar bär sina RÅSIGNALER separat: sann BM25
   * score+coverage (via scoreAllLegalChunks — kan vara 0 för semantik-only)
   * och cosine där semantiken bidrog. Tie-break: paragraf-label (som BM25:s).
   */
  private fuse(query: string, semantic: SemanticHit[]): RetrievedChunk[] {
    const lexicalRanked = retrieveLegalChunks(query, { topK: CHANNEL_TOP_K })
    const lexicalByKey = new Map(scoreAllLegalChunks(query).map((r) => [legalChunkId(r.chunk), r]))

    interface FusionEntry {
      chunk: LegalChunk
      rrf: number
      cosine?: number
    }
    const entries = new Map<string, FusionEntry>()
    const contribute = (chunk: LegalChunk, rank: number, cosine?: number): void => {
      const key = legalChunkId(chunk)
      const entry = entries.get(key) ?? { chunk, rrf: 0 }
      entry.rrf += 1 / (RRF_K + rank)
      if (cosine !== undefined) entry.cosine = cosine
      entries.set(key, entry)
    }
    lexicalRanked.forEach((r, i) => contribute(r.chunk, i + 1))
    semantic.forEach((s, i) => contribute(s.chunk, i + 1, s.cosine))

    return [...entries.values()]
      .sort((a, b) => b.rrf - a.rrf || a.chunk.paragraph.localeCompare(b.chunk.paragraph))
      .slice(0, GROUNDING_TOP_K)
      .map(({ chunk, cosine }) => {
        const lexicalSignals = lexicalByKey.get(legalChunkId(chunk))
        return {
          chunk,
          score: lexicalSignals?.score ?? 0,
          coverage: lexicalSignals?.coverage ?? 0,
          ...(cosine !== undefined ? { cosine } : {}),
        }
      })
  }

  private getChunkById(): Map<string, LegalChunk> {
    if (!this.chunkById) {
      this.chunkById = new Map(buildLegalChunks().map((c) => [legalChunkId(c), c]))
    }
    return this.chunkById
  }
}
