import { LEGAL_DOCUMENT_IDS } from '../legal-knowledge'
import { LEGAL_EVAL_SET } from './legal-eval-set'
import {
  findMissingSources,
  paragraphExists,
  scoreRun,
  type EvalRunOutput,
} from './legal-eval-harness'

/**
 * Etapp 2, PR 2.1 — eval-setet som mätsticka + regressionsspärr.
 * Här körs INGEN retrieval/AI; testet validerar att eval-setet är konsekvent
 * och att dess "rätt källa"-paragrafer faktiskt finns i LEGAL_KNOWLEDGE.
 */
describe('Legal eval-set (Etapp 2, PR 2.1)', () => {
  it('har en rimlig täckning (~20–30 fall) och unika id:n', () => {
    expect(LEGAL_EVAL_SET.length).toBeGreaterThanOrEqual(20)
    const ids = LEGAL_EVAL_SET.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('varje fall är välformat', () => {
    for (const c of LEGAL_EVAL_SET) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/)
      expect(c.question.length).toBeGreaterThan(10)
      expect(c.expectedAnswerCore.length).toBeGreaterThan(20)
      expect(['answerable', 'needs-jurist', 'no-clear-rule']).toContain(c.expectedOutcome)
      expect(typeof c.shouldRecommendJurist).toBe('boolean')
    }
  })

  it('ALLA förväntade paragrafer finns i LEGAL_KNOWLEDGE (inga självmotsägelser)', () => {
    const problems: string[] = []
    for (const c of LEGAL_EVAL_SET) {
      const missing = findMissingSources(c)
      if (missing.length) problems.push(`${c.id}: ${missing.join(', ')}`)
      for (const s of c.expectedSources) {
        expect(LEGAL_DOCUMENT_IDS).toContain(s.lawId)
      }
    }
    expect(problems).toEqual([])
  })

  it('fall utan källor är miss-fall (no-clear-rule/needs-jurist), aldrig "answerable"', () => {
    for (const c of LEGAL_EVAL_SET) {
      if (c.expectedSources.length === 0) {
        expect(c.expectedOutcome).not.toBe('answerable')
      }
    }
  })

  it('täcker kärnområdena i hyresjuridiken', () => {
    const categories = new Set(LEGAL_EVAL_SET.map((c) => c.category))
    for (const must of [
      'besittningsskydd',
      'uppsägning',
      'förverkande',
      'hyreshöjning',
      'deposition',
      'andrahand',
      'delgivning',
    ]) {
      expect(categories).toContain(must)
    }
  })

  it('innehåller minst tre miss-/jurist-fall (för miss-grinden i 2.3)', () => {
    const misses = LEGAL_EVAL_SET.filter((c) => c.expectedOutcome !== 'answerable')
    expect(misses.length).toBeGreaterThanOrEqual(3)
    expect(misses.some((c) => c.expectedOutcome === 'no-clear-rule')).toBe(true)
    expect(misses.some((c) => c.expectedOutcome === 'needs-jurist')).toBe(true)
  })

  describe('regressionsfall: besittningsskydd (#129-felet)', () => {
    const regression = LEGAL_EVAL_SET.find((c) => c.id === 'besittningsskydd-forstahand-1ar')

    it('finns och är markerat som regression med rätt källa', () => {
      expect(regression).toBeDefined()
      expect(regression!.isRegression).toBe(true)
      expect(regression!.expectedSources).toEqual([
        { lawId: 'hyreslagen', paragraphs: ['45', '46'] },
      ])
      expect(paragraphExists('hyreslagen', '45')).toBe(true)
      expect(paragraphExists('hyreslagen', '46')).toBe(true)
    })

    it('facit säger "från början" och NEKAR uttryckligen myten "efter två år"', () => {
      expect(regression!.expectedAnswerCore).toMatch(/från början/i)
      // Den felaktiga myten (skydd först efter två år) ska uttryckligen avvisas,
      // inte påstås — formuleringen "inte först efter två år" är korrekt.
      expect(regression!.expectedAnswerCore).toMatch(/inte (först )?efter två år/i)
      expect(regression!.shouldRecommendJurist).toBe(true)
    })
  })

  describe('scoreRun (ren poängsättning, ingen AI)', () => {
    const answerable = LEGAL_EVAL_SET.find((c) => c.id === 'besittningsskydd-forstahand-1ar')!
    const miss = LEGAL_EVAL_SET.find((c) => c.id === 'deposition-storlek')!

    it('ger sourceHit när en förväntad paragraf hämtades + juristMatch', () => {
      const out: EvalRunOutput = {
        retrievedSources: [{ lawId: 'hyreslagen', paragraphs: ['46'] }],
        answer: '...',
        recommendedJurist: true,
      }
      expect(scoreRun(answerable, out)).toEqual({ sourceHit: true, juristMatch: true })
    })

    it('för miss-fall är sourceHit sant endast när inget hämtades', () => {
      expect(
        scoreRun(miss, { retrievedSources: [], answer: '...', recommendedJurist: true }).sourceHit,
      ).toBe(true)
      expect(
        scoreRun(miss, {
          retrievedSources: [{ lawId: 'hyreslagen', paragraphs: ['20'] }],
          answer: '...',
          recommendedJurist: true,
        }).sourceHit,
      ).toBe(false)
    })
  })
})
