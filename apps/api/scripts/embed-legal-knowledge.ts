/**
 * Indexerar den verifierade lagtexten semantiskt: embeddar varje paragraf-chunk
 * (buildLegalChunks) via Voyage och lagrar vektorn i LegalChunkEmbedding (PR 3.1).
 *
 * Etapp 3, PR 3.2 — FÖRSTA scriptet som rör Voyage-nätet. BARA indexering: ingen
 * retrieval i produktchatten, ingen grind, ingen grundning rörs (det är PR 3.3).
 *
 * KÖRS MANUELLT: `pnpm --filter @eken/api knowledge:embed`
 * Aldrig vid runtime/startup/migration (skulle kosta pengar vid varje boot).
 *
 * IDEMPOTENT: contentHash = sha256(chunk.text). En chunk embeddas om bara om den
 * saknar rad, texten ändrats, eller modellen bytts. Oförändrad körning = 0
 * Voyage-anrop = 0 kostnad. Avbryts scriptet mitt i är redan skrivna rader kvar
 * och hoppas över vid omkörning (säker resume) — ingen tyst halvfylld tabell.
 *
 * GDPR: endast publik lagtext (LEGAL_KNOWLEDGE) skickas till Voyage. Embedding-
 * wrappern (LegalEmbeddingService) tar bara strängar och kan inte läsa kunddata.
 */
import { createHash } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { ConfigService } from '@nestjs/config'
import { buildLegalChunks, legalChunkId } from '../src/ai/knowledge/retrieval/legal-chunk'
import { LegalEmbeddingService } from '../src/ai/knowledge/embedding/legal-embedding.service'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'

// Voyage tar flera texter per anrop. Chunkarna är korta paragrafer, så en rimlig
// batch sparar kvot utan att slå i token-/storlekstaket. Sänk vid behov.
const BATCH_SIZE = 100

// voyage-4 listpris (verifiera mot voyageai.com — kan ändras; dessutom 200M
// tokens gratis/konto, så indexeringen är i praktiken kostnadsfri). Endast för
// en grov kostnadsuppskattning i loggen, ingen affärslogik.
const USD_PER_MILLION_TOKENS = 0.06

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  const embedder = new LegalEmbeddingService(new ConfigService())
  const model = VOYAGE_EMBEDDINGS.MODEL

  try {
    const chunks = buildLegalChunks()
    console.warn(`[embed] ${chunks.length} paragraf-chunkar i LEGAL_KNOWLEDGE`)

    // Befintliga rader: id → { contentHash, model }. Avgör vad som behöver (om)embeddas.
    const existing = await prisma.legalChunkEmbedding.findMany({
      select: { id: true, contentHash: true, model: true },
    })
    const existingById = new Map(existing.map((e) => [e.id, e]))

    const toEmbed = chunks
      .map((c) => ({ chunk: c, id: legalChunkId(c), hash: contentHash(c.text) }))
      .filter(({ id, hash }) => {
        const prev = existingById.get(id)
        // (Om)embedda om: ny chunk, ändrad text, eller bytt modell.
        return !prev || prev.contentHash !== hash || prev.model !== model
      })

    const skipped = chunks.length - toEmbed.length
    console.warn(`[embed] ${toEmbed.length} att (om)embedda, ${skipped} oförändrade (hoppas över)`)

    if (toEmbed.length === 0) {
      console.warn('[embed] Inget att göra — tabellen är aktuell. 0 Voyage-anrop, 0 kostnad.')
      return
    }

    let embedded = 0
    let totalTokens = 0
    const batches = chunk(toEmbed, BATCH_SIZE)

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]!
      const texts = batch.map((x) => x.chunk.text)
      // input_type 'document': dessa texter LAGRAS och söks i (queryn embeddas
      // som 'query' i PR 3.3).
      const { vectors, totalTokens: batchTokens } = await embedder.embed(texts, 'document')
      totalTokens += batchTokens

      for (let i = 0; i < batch.length; i++) {
        const { chunk: c, id, hash } = batch[i]!
        const vectorLiteral = `[${vectors[i]!.join(',')}]`
        // embedding är Unsupported("vector(1024)") — Prisma-klienten kan inte
        // skriva den via create/update, så raw upsert med ::vector-cast.
        await prisma.$executeRaw`
          INSERT INTO "LegalChunkEmbedding" (id, "lawId", paragraph, sfs, "contentHash", embedding, model, "createdAt")
          VALUES (${id}, ${c.lawId}, ${c.paragraph}, ${c.sfs}, ${hash}, ${vectorLiteral}::vector, ${model}, now())
          ON CONFLICT (id) DO UPDATE SET
            "lawId" = EXCLUDED."lawId",
            paragraph = EXCLUDED.paragraph,
            sfs = EXCLUDED.sfs,
            "contentHash" = EXCLUDED."contentHash",
            embedding = EXCLUDED.embedding,
            model = EXCLUDED.model
        `
        embedded++
      }
      console.warn(`[embed] batch ${b + 1}/${batches.length} klar (${embedded}/${toEmbed.length})`)
    }

    const cost = (totalTokens / 1_000_000) * USD_PER_MILLION_TOKENS
    console.warn(
      `[embed] KLART: ${embedded} embeddade (modell ${model}), ${skipped} oförändrade.\n` +
        `[embed] Voyage-tokens: ${totalTokens} ≈ $${cost.toFixed(5)} ` +
        `(à $${USD_PER_MILLION_TOKENS}/1M tokens, verifiera priset).`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err: unknown) => {
  console.error('[embed] MISSLYCKADES:', err instanceof Error ? err.message : err)
  // contentHash gör omkörning säker — redan skrivna rader hoppas över nästa gång.
  process.exit(1)
})
