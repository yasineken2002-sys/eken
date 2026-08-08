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
 * TVÅVÄGS SEDAN #382: scriptet var upsert-only och kunde bara lägga till. Nu
 * raderar det också rader vars chunk försvunnit ur korpusen (se PRUNE nedan),
 * så tabellen speglar LEGAL_KNOWLEDGE i BÅDA riktningarna. Paritetskontrollen i
 * LegalRetrievalService.onModuleInit larmar om de ändå glider isär.
 *
 * GDPR: endast publik lagtext (LEGAL_KNOWLEDGE) skickas till Voyage. Embedding-
 * wrappern (LegalEmbeddingService) tar bara strängar och kan inte läsa kunddata.
 */
import { PrismaClient } from '@prisma/client'
import { ConfigService } from '@nestjs/config'
import {
  buildLegalChunks,
  legalChunkId,
  legalChunkContentHash,
} from '../src/ai/knowledge/retrieval/legal-chunk'
import { LegalEmbeddingService } from '../src/ai/knowledge/embedding/legal-embedding.service'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
import { requireApiKey, verifyVoyageKey, exitOnPreflightError } from './preflight-keys'

// Voyage tar flera texter per anrop. Chunkarna är korta paragrafer, så en rimlig
// batch sparar kvot utan att slå i token-/storlekstaket. Konfigurerbar via env:
// vid Voyage-incidenten 2026-06-11 skeddade deras servrar stora batchar (503/
// häng) medan småanrop gick igenom — EMBED_BATCH_SIZE=1 var räddningen.
const BATCH_SIZE = Math.max(1, Number(process.env.EMBED_BATCH_SIZE ?? 100) || 100)

// Retry per Voyage-anrop: ett transient 503 ska backa och försöka om — ALDRIG
// fälla hela körningen (lärdom 2026-06-11). Ihärdiga fel kastar till slut;
// contentHash-idempotensen gör omkörning säker oavsett.
const EMBED_RETRIES = 8
const RETRY_BACKOFF_MS = 5_000

// voyage-4 listpris (verifiera mot voyageai.com — kan ändras; dessutom 200M
// tokens gratis/konto, så indexeringen är i praktiken kostnadsfri). Endast för
// en grov kostnadsuppskattning i loggen, ingen affärslogik.
const USD_PER_MILLION_TOKENS = 0.06

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Embedda med retry/backoff — transienta Voyage-fel fäller inte körningen. */
async function embedWithRetry(
  embedder: LegalEmbeddingService,
  texts: string[],
  label: string,
): Promise<{ vectors: number[][]; totalTokens: number }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
    try {
      return await embedder.embed(texts, 'document')
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      // AUTH-FEL ÄR INTE TRANSIENTA (#385). En återkallad nyckel blir aldrig
      // giltig av att man väntar — utan detta blev en 401 åtta försök à 5 s.
      if (/\b(401|403)\b/.test(msg)) throw err
      console.warn(
        `[embed] ${label}: ${msg.slice(0, 120)} — retry ${attempt}/${EMBED_RETRIES} om ${RETRY_BACKOFF_MS / 1000}s`,
      )
      await new Promise((res) => setTimeout(res, RETRY_BACKOFF_MS))
    }
  }
  throw lastErr
}

async function main(): Promise<void> {
  // FÖRHANDSKONTROLL (#385) före allt arbete: en trasig nyckel ska kosta noll
  // anrop och ge ett besked, inte ett 401 mitt i en batch.
  const voyageKey = requireApiKey({
    envVar: 'VOYAGE_API_KEY',
    whatFor: 'indexeringen i knowledge:embed',
    expectedPrefix: 'pa-',
  })
  await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
  console.warn('[embed] förhandskontroll OK — Voyage-nyckeln accepteras.')

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

    // ── PRUNE: rader vars chunk inte längre finns i LEGAL_KNOWLEDGE (#382) ────
    //
    // Scriptet var upsert-only fram till #382-serien: en chunk som försvann ur
    // korpusen lämnade sin vektor kvar för alltid. Det var precis så de 140
    // mervärdesskattelag-raderna blev föräldralösa, och de var inte harmlösa:
    // stale-hash-vakten i legal-retrieval.service.ts släpper dem, men FÖRST
    // efter SQL:ens LIMIT, så de äter kandidatplatser i den semantiska kanalen.
    // Uppmätt på moms-färgade frågor: upp till 10 av 10 platser gick åt till
    // rader som sedan kastades.
    //
    // KÖRS FÖRE early-returnen nedan. Att ta bort en lag ger noll chunkar att
    // embedda — hade prune legat efter "inget att göra"-grenen hade den aldrig
    // körts i exakt det fall den finns för.
    //
    // id är PK, så en chunk kan bara ha EN rad oavsett modell. Prune på id är
    // därför entydig: en rad utan chunk är död oavsett vilken modell den bär.
    const chunkIds = new Set(chunks.map(legalChunkId))
    const orphans = existing.filter((e) => !chunkIds.has(e.id))
    if (orphans.length > 0) {
      const perLaw = new Map<string, number>()
      for (const o of orphans) {
        const lawId = o.id.split(':')[0] ?? '(okänt)'
        perLaw.set(lawId, (perLaw.get(lawId) ?? 0) + 1)
      }
      const { count } = await prisma.legalChunkEmbedding.deleteMany({
        where: { id: { in: orphans.map((o) => o.id) } },
      })
      console.warn(
        `[embed] PRUNE: ${count} föräldralösa rader raderade (saknar chunk i LEGAL_KNOWLEDGE) — ` +
          [...perLaw].map(([lawId, n]) => `${lawId}: ${n}`).join(', '),
      )
    } else {
      console.warn('[embed] PRUNE: 0 föräldralösa rader — tabellen speglar korpusen.')
    }

    const toEmbed = chunks
      .map((c) => ({ chunk: c, id: legalChunkId(c), hash: legalChunkContentHash(c.text) }))
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
      // som 'query' i runtime-retrieval, PR 3.3a).
      const { vectors, totalTokens: batchTokens } = await embedWithRetry(
        embedder,
        texts,
        `batch ${b + 1}/${batches.length}`,
      )
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
  // contentHash gör omkörning säker — redan skrivna rader hoppas över nästa gång.
  exitOnPreflightError(err, 'embed')
})
