/**
 * PR1 batch-tak — förhandsestimat av skanningskostnad. Estimatet behöver inte
 * vara exakt, men det ska vara monotont (större fil → inte billigare), aldrig
 * negativt, och klampat så en absurd filstorlek inte ger ett absurt estimat.
 */

import {
  estimatePagesFromSize,
  estimateContractScanCostSek,
  estimateBatchCostSek,
  MAX_BATCH_FILES_ABSOLUTE,
} from './contract-scan-cost'

describe('contract-scan-cost', () => {
  describe('estimatePagesFromSize', () => {
    it('ger minst 1 sida även för tom/ogiltig storlek', () => {
      expect(estimatePagesFromSize(0)).toBe(1)
      expect(estimatePagesFromSize(-5)).toBe(1)
      expect(estimatePagesFromSize(1)).toBe(1)
    })

    it('skalar med storleken', () => {
      const small = estimatePagesFromSize(50_000)
      const big = estimatePagesFromSize(500_000)
      expect(big).toBeGreaterThan(small)
    })

    it('klampar till ett tak (300 sidor) för absurt stora filer', () => {
      expect(estimatePagesFromSize(1_000_000_000)).toBe(300)
    })

    it('underskattar inte en tät 10 MB-fil (taket ligger över realistiskt max)', () => {
      // 10 MB / 40 kB ≈ 262 sidor — får INTE klampas ner till ett lågt tak.
      expect(estimatePagesFromSize(10 * 1024 * 1024)).toBeGreaterThan(200)
    })
  })

  describe('estimateContractScanCostSek', () => {
    it('är positivt och rimligt för ett typiskt kontrakt (~150 kB)', () => {
      const cost = estimateContractScanCostSek(150_000)
      expect(cost).toBeGreaterThan(0)
      // Sanity: en enskild kontraktsskanning ska inte estimeras till kronor i tiotal.
      expect(cost).toBeLessThan(2)
    })

    it('är monotont icke-avtagande i filstorlek', () => {
      expect(estimateContractScanCostSek(500_000)).toBeGreaterThanOrEqual(
        estimateContractScanCostSek(100_000),
      )
    })
  })

  describe('estimateBatchCostSek', () => {
    it('summerar per-fil-estimaten', () => {
      const a = estimateContractScanCostSek(100_000)
      const b = estimateContractScanCostSek(200_000)
      expect(estimateBatchCostSek([100_000, 200_000])).toBeCloseTo(a + b, 4)
    })

    it('en tom batch kostar 0', () => {
      expect(estimateBatchCostSek([])).toBe(0)
    })

    it('skalar med antal filer', () => {
      const ten = estimateBatchCostSek(Array(10).fill(150_000))
      const fifty = estimateBatchCostSek(Array(50).fill(150_000))
      expect(fifty).toBeGreaterThan(ten)
    })
  })

  it('exponerar ett absolut filtak', () => {
    expect(MAX_BATCH_FILES_ABSOLUTE).toBe(200)
  })
})
