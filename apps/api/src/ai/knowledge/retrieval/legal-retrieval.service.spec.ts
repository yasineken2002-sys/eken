/**
 * Etapp 3, PR 3.3a — hybrid-retrieval (BM25 + Voyage/pgvector via RRF), med
 * GRINDEN ORÖRD som bevisad invariant:
 *
 *   1. Gap B identisk: golven läser ENBART den lexikala kanalen — en
 *      adversariell fused-lista kan per konstruktion inte ändra ett
 *      grindutfall. Sveps mot HELA eval-setet.
 *   2. Stale-hash-vakt: en lagrad vektor används bara om radens contentHash
 *      matchar runtime-textens sha256 — glömd omindexering blir
 *      kvalitetsbortfall (rad släpps + varning), aldrig fel lagtext.
 *   3. Fallback: Voyage nere / tom tabell → BM25-only (fused === lexical),
 *      exakt beteendet före PR 3.3a — deterministiskt utan nät (CI-kravet).
 *   4. Query-PII (GDPR): konstruktor-deps är låsta till
 *      (PrismaService, LegalEmbeddingService) och den enda sträng som når
 *      embeddern är den råa frågan ordagrant — ingen DataContext/Memory.
 *   5. Gap A oförändrad: en semantik-only chunk i fused ger källrad byggd
 *      enbart ur chunk-metadata, som alltid.
 *
 * Ingen modell, inget nät, ingen databas — embedder + prisma är mockade.
 */
import 'reflect-metadata'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Logger } from '@nestjs/common'
import { LegalRetrievalService } from './legal-retrieval.service'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { LegalEmbeddingService } from '../embedding/legal-embedding.service'
import { buildLegalChunks, legalChunkId, legalChunkContentHash } from './legal-chunk'
import { retrieveLegalChunks } from './legal-retrieval'
import {
  evaluateLegalRetrieval,
  evaluateLegalCandidate,
  groundLegalCandidate,
  GROUNDING_TOP_K,
} from '../grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'

const BESITTNING_FRAGA =
  'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.'

/** Hämtar en verklig chunk (med korrekt runtime-hash) ur LEGAL_KNOWLEDGE. */
function chunkFor(lawId: string, paragraph: string) {
  const chunk = buildLegalChunks().find((c) => c.lawId === lawId && c.paragraph === paragraph)
  if (!chunk) throw new Error(`Chunk saknas: ${lawId} § ${paragraph}`)
  return chunk
}

/** En giltig pgvector-rad för en verklig chunk (korrekt id + contentHash). */
function validRow(lawId: string, paragraph: string, distance: number) {
  const chunk = chunkFor(lawId, paragraph)
  return {
    id: legalChunkId(chunk),
    contentHash: legalChunkContentHash(chunk.text),
    distance,
  }
}

function makeService(opts: { rows?: unknown[]; embedRejects?: boolean }): {
  service: LegalRetrievalService
  embed: jest.Mock
  queryRaw: jest.Mock
} {
  const embed = opts.embedRejects
    ? jest.fn().mockRejectedValue(new Error('Voyage nere i test'))
    : jest.fn().mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]], totalTokens: 3 })
  const queryRaw = jest.fn().mockResolvedValue(opts.rows ?? [])
  const service = new LegalRetrievalService({ $queryRaw: queryRaw } as never, { embed } as never)
  return { service, embed, queryRaw }
}

let warnSpy: jest.SpyInstance

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('LegalRetrievalService (Etapp 3, PR 3.3a)', () => {
  describe('RRF-fusion: semantiken ändrar ORDNINGEN, aldrig grindsignalen', () => {
    it('semantiska träffar på §45/§46 lyfter dem in i fused topp-3 med cosine satt', async () => {
      const { service } = makeService({
        rows: [validRow('hyreslagen', '45', 0.1), validRow('hyreslagen', '46', 0.15)],
      })
      const result = await service.retrieve(BESITTNING_FRAGA)

      const fusedParagraphs = result.fused.map((r) => `${r.chunk.lawId}:${r.chunk.paragraph}`)
      expect(fusedParagraphs).toContain('hyreslagen:45')
      expect(fusedParagraphs).toContain('hyreslagen:46')
      expect(result.fused.length).toBeLessThanOrEqual(GROUNDING_TOP_K)

      const p45 = result.fused.find((r) => r.chunk.paragraph === '45')!
      expect(p45.cosine).toBeCloseTo(0.9, 5)
      // Råsignalerna är separata: BM25-score/coverage är chunkens SANNA lexikala
      // värden (kan vara 0) — aldrig en blandad/normaliserad skala.
      expect(p45.score).toBeGreaterThanOrEqual(0)
      expect(p45.coverage).toBeGreaterThanOrEqual(0)
    })

    it('lexical är bit-för-bit identisk med retrieveLegalChunks oavsett semantiska träffar', async () => {
      const { service } = makeService({
        rows: [validRow('hyreslagen', '45', 0.1), validRow('ranteslagen', '6', 0.2)],
      })
      const result = await service.retrieve(BESITTNING_FRAGA)
      expect(result.lexical).toEqual(retrieveLegalChunks(BESITTNING_FRAGA, { topK: 3 }))
      expect(result.lexical.every((r) => r.cosine === undefined)).toBe(true)
    })

    it('en chunk som båda kanalerna rankar ackumulerar RRF och behåller båda råsignalerna', async () => {
      // §46 finns i BM25:s topp-10 för eget-behov-frågan; ge den även semantisk rank 1.
      const fraga = 'Jag behöver lägenheten för eget bruk — kan jag säga upp hyresgästen då?'
      const { service } = makeService({ rows: [validRow('hyreslagen', '46', 0.05)] })
      const result = await service.retrieve(fraga)
      const p46 = result.fused.find((r) => r.chunk.paragraph === '46')
      expect(p46).toBeDefined()
      expect(p46!.cosine).toBeCloseTo(0.95, 5)
      expect(p46!.score).toBeGreaterThan(0) // sann BM25-score, inte 0
    })
  })

  describe('Stale-hash-vakt: aldrig fel lagtext, bara kvalitetsbortfall', () => {
    it('rad med fel contentHash släpps med varning (vektor från äldre lydelse)', async () => {
      const stale = { ...validRow('hyreslagen', '45', 0.1), contentHash: 'fel-hash' }
      const { service } = makeService({ rows: [stale, validRow('hyreslagen', '46', 0.2)] })
      const result = await service.retrieve(BESITTNING_FRAGA)

      expect(result.fused.some((r) => r.chunk.paragraph === '45' && r.cosine !== undefined)).toBe(
        false,
      )
      expect(result.fused.some((r) => r.chunk.paragraph === '46')).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('contentHash'))
    })

    it('rad med okänt id (paragraf borttagen ur LEGAL_KNOWLEDGE) släpps med varning', async () => {
      const { service } = makeService({
        rows: [
          { id: 'hyreslagen:999', contentHash: 'x', distance: 0.1 },
          validRow('hyreslagen', '46', 0.2),
        ],
      })
      const result = await service.retrieve(BESITTNING_FRAGA)
      expect(result.fused.some((r) => r.chunk.paragraph === '46')).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hyreslagen:999'))
    })

    it('ALLA rader stale → BM25-only-fallback (fused === lexical)', async () => {
      const stale = { ...validRow('hyreslagen', '45', 0.1), contentHash: 'fel-hash' }
      const { service } = makeService({ rows: [stale] })
      const result = await service.retrieve(BESITTNING_FRAGA)
      expect(result.fused).toEqual(result.lexical)
    })
  })

  describe('Fallback: BM25-only = exakt beteendet före PR 3.3a (deterministiskt utan nät)', () => {
    it('embeddern kastar (nyckel saknas/nät/Voyage) → fused === lexical + varning', async () => {
      const { service, queryRaw } = makeService({ embedRejects: true })
      const result = await service.retrieve(BESITTNING_FRAGA)
      expect(result.fused).toEqual(result.lexical)
      expect(result.lexical).toEqual(retrieveLegalChunks(BESITTNING_FRAGA, { topK: 3 }))
      expect(queryRaw).not.toHaveBeenCalled() // ingen DB-fråga utan query-vektor
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BM25-only'))
    })

    it('tom LegalChunkEmbedding-tabell → fused === lexical + varning', async () => {
      const { service } = makeService({ rows: [] })
      const result = await service.retrieve(BESITTNING_FRAGA)
      expect(result.fused).toEqual(result.lexical)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BM25-only'))
    })
  })

  describe('Query-PII (GDPR-invariant): bara den råa frågan kan nå Voyage', () => {
    it('konstruktor-deps är EXAKT (PrismaService, LegalEmbeddingService)', () => {
      const paramTypes = Reflect.getMetadata('design:paramtypes', LegalRetrievalService) as
        | unknown[]
        | undefined
      expect(paramTypes).toEqual([PrismaService, LegalEmbeddingService])
    })

    it('källfilen importerar varken DataContext, Memory eller tool-executor', () => {
      const src = readFileSync(join(__dirname, 'legal-retrieval.service.ts'), 'utf8')
      // Granska IMPORTRADERNA (kommentarer får nämna invarianten i prosa).
      const imports = src
        .split('\n')
        .filter((line) => line.trimStart().startsWith('import') || line.includes(" from '"))
        .join('\n')
      expect(imports).not.toContain('data-context')
      expect(imports).not.toContain('DataContextService')
      expect(imports).not.toContain('memory.service')
      expect(imports).not.toContain('MemoryService')
      expect(imports).not.toContain('tool-executor')
    })

    it('embeddern anropas med EXAKT [frågan] och input_type "query"', async () => {
      const { service, embed } = makeService({ rows: [] })
      await service.retrieve(BESITTNING_FRAGA)
      expect(embed).toHaveBeenCalledTimes(1)
      expect(embed).toHaveBeenCalledWith([BESITTNING_FRAGA], 'query')
    })
  })

  describe('Gap B IDENTISK: fused kan per konstruktion inte ändra ett grindutfall', () => {
    it('adversariell fused-lista ger samma steg 1-utfall som BM25-vägen för HELA eval-setet', () => {
      // Adversariell: en semantik-only träff med score 0 men maximal cosine
      // ÖVERST i fused. Om grinden läste fused vore detta no-hits/weak — den
      // läser lexical och utfallet är identiskt med evaluateLegalRetrieval.
      const adversarialFused = [
        { chunk: chunkFor('hyreslagen', '1'), score: 0, coverage: 0, cosine: 0.999 },
      ]
      for (const c of LEGAL_EVAL_SET) {
        const lexical = retrieveLegalChunks(c.question, { topK: GROUNDING_TOP_K })
        const baseline = evaluateLegalRetrieval(c.question)
        const hybrid = evaluateLegalCandidate(c.question, { lexical, fused: adversarialFused })

        if (baseline === null || baseline.outcome === 'miss') {
          // null/miss: HELA utfallet identiskt (ingen kandidat byggs ur fused).
          expect({ id: c.id, result: hybrid }).toEqual({ id: c.id, result: baseline })
        } else {
          // Kandidat: grindutfallet identiskt — fused styr BARA vilka chunkar
          // domaren ser (det är PR 3.3a:s hela avsedda beteendeskillnad).
          expect({ id: c.id, outcome: hybrid?.outcome }).toEqual({
            id: c.id,
            outcome: 'candidate',
          })
        }
      }
    })

    it('semantiska träffar kan inte rädda en lexikal no-hit (grinden läser lexical)', () => {
      const fused = [{ chunk: chunkFor('hyreslagen', '45'), score: 0, coverage: 0, cosine: 0.99 }]
      const result = evaluateLegalCandidate('Är blorptaxa laglig?', { lexical: [], fused })
      expect(result).toEqual({ outcome: 'miss', reason: 'no-hits' })
    })

    it('tom fused faller tillbaka på lexical som kandidatkälla (aldrig tom kandidat)', () => {
      const lexical = retrieveLegalChunks(BESITTNING_FRAGA, { topK: GROUNDING_TOP_K })
      const result = evaluateLegalCandidate(BESITTNING_FRAGA, { lexical, fused: [] })
      expect(result?.outcome).toBe('candidate')
      if (result?.outcome !== 'candidate') return
      expect(result.retrieved).toEqual(lexical)
    })
  })

  describe('Gap A oförändrad: källraden byggs ur chunk-metadata även för semantik-only chunkar', () => {
    it('grundning ur en fused-lista med semantik-only §45 citerar §45 ur metadatan', () => {
      const retrieved = [
        { chunk: chunkFor('hyreslagen', '45'), score: 0, coverage: 0, cosine: 0.97 },
        { chunk: chunkFor('hyreslagen', '46'), score: 12.3, coverage: 0.5, cosine: 0.91 },
      ]
      const grounding = groundLegalCandidate(retrieved)
      expect(grounding.sourceCitation).toContain('45 §')
      expect(grounding.sourceCitation).toContain('46 §')
      expect(grounding.sourceCitation).toContain(`SFS ${chunkFor('hyreslagen', '45').sfs}`)
      // cosine är en retrieval-råsignal — den läcker aldrig in i källraden/kontexten.
      expect(grounding.sourceCitation).not.toContain('0.97')
      expect(grounding.contextBlock).not.toContain('cosine')
      expect(grounding.contextBlock).toContain(chunkFor('hyreslagen', '45').text)
    })
  })
})
