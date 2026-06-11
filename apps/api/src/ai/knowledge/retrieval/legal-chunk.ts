/**
 * Chunkning av den verifierade lagtexten — per paragraf (§).
 *
 * Källan är redan paragraf-indelad (rubriker "## N §" / "## N a §"), så en chunk
 * = en specifik paragraf med exakt label. Varje chunk bär sin egen källmetadata
 * (lag-id, SFS, verifieradPer, paragraf) HÄMTAD UR LEGAL_KNOWLEDGE-strukturen —
 * aldrig härledd eller gissad. Det är grunden för citat-integritet (gap A): i
 * PR 2.3 ska AI:n bara kunna citera det en chunk faktiskt bär.
 *
 * Ingen AI, ingen modell — ren textbearbetning.
 */
import { createHash } from 'crypto'
import { LEGAL_KNOWLEDGE } from '../legal-knowledge'

export interface LegalChunk {
  /** Lag-id, matchar LEGAL_KNOWLEDGE, t.ex. "hyreslagen". */
  lawId: string
  /** SFS-nummer, ur lagens metadata. */
  sfs: string
  /** Verifieringsdatum, ur lagens metadata. */
  verifieradPer: string
  /**
   * Kapitel-label, t.ex. "1", "9 b" — eller null för lagar utan kapitelindelning
   * (hyreslagen, ränteslagen). KRITISKT för entydig identitet: svenska lagar är
   * kapitelindelade och §-numreringen börjar om per kapitel, så `paragraph`
   * ensam är INTE unik inom en lag ("1 §" finns i varje kapitel). Hämtas ur
   * närmast föregående "# N kap."-rubrik. Additivt fält — BM25-retrieval och
   * grundningens citatväg läser det inte (oförändrat beteende).
   */
  chapter: string | null
  /** Paragraf-label exakt som i rubriken, t.ex. "45", "54 a". */
  paragraph: string
  /** Rubrikraden, t.ex. "## 45 §". */
  heading: string
  /** Paragrafens fulltext (inkl. rubrik), ordagrant ur källan. */
  text: string
}

// Matchar en paragraf-rubrik på egen rad: "## 45 §", "## 54 a §".
const PARAGRAPH_HEADING = /^## (.+?) §[ \t]*$/gm

// Matchar en KAPITEL-rubrik på egen rad: nivå-1 "# N kap. …", t.ex.
// "# 1 kap. Inledande bestämmelser", "# 9 b kap. …". Kräver inledande siffra
// så att lagtitlar som "# Hyreslagen (Jordabalken 12 kap)" (ingen inledande
// siffra) och "# Mervärdesskattelagen … utvalda kapitel" INTE matchar.
const CHAPTER_HEADING = /^# (\d+(?:\s+[a-zåäö])?)\s+kap\./gim

/**
 * Stabil, entydig identitet för en chunk: `lawId:kapitel:paragraf`
 * (t.ex. "bostadsrattslagen:7:1") eller `lawId:paragraf` för lagar utan
 * kapitel (t.ex. "hyreslagen:45"). Sanningskällan för embedding-tabellens PK.
 */
export function legalChunkId(chunk: LegalChunk): string {
  return chunk.chapter
    ? `${chunk.lawId}:${chunk.chapter}:${chunk.paragraph}`
    : `${chunk.lawId}:${chunk.paragraph}`
}

/**
 * sha256-hex av en chunks fulltext — idempotensnyckeln för indexeringen
 * (`knowledge:embed`, PR 3.2) OCH stale-hash-vaktens jämförelsenyckel i
 * runtime-retrieval (PR 3.3a). EN sanningskälla: matchar lagrad
 * LegalChunkEmbedding.contentHash inte denna hash är vektorn beräknad på en
 * äldre lydelse och får inte användas.
 */
export function legalChunkContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

let cache: LegalChunk[] | null = null

/** Bygger (och memoiserar) alla paragraf-chunkar ur LEGAL_KNOWLEDGE. */
export function buildLegalChunks(): LegalChunk[] {
  if (cache) return cache

  const chunks: LegalChunk[] = []
  for (const doc of LEGAL_KNOWLEDGE) {
    // Kapitelpositioner: label + var i texten kapitlet börjar. Paragrafens
    // kapitel = det sista kapitlet som börjar före paragrafens rubrik.
    const chapters = [...doc.innehall.matchAll(CHAPTER_HEADING)].map((m) => ({
      label: m[1]!.replace(/\s+/g, ' ').trim(),
      index: m.index ?? 0,
    }))
    const chapterAt = (pos: number): string | null => {
      let current: string | null = null
      for (const c of chapters) {
        if (c.index < pos) current = c.label
        else break
      }
      return current
    }

    const matches = [...doc.innehall.matchAll(PARAGRAPH_HEADING)]
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i]!
      const next = matches[i + 1]
      const start = current.index ?? 0
      const end = next?.index ?? doc.innehall.length
      chunks.push({
        lawId: doc.id,
        sfs: doc.sfs,
        verifieradPer: doc.verifieradPer,
        chapter: chapterAt(start),
        paragraph: current[1]!.trim(),
        heading: current[0]!.trim(),
        text: doc.innehall.slice(start, end).trim(),
      })
    }
  }

  cache = chunks
  return chunks
}
