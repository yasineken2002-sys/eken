import { ReadingReviewAssessment } from '@prisma/client'
import { SaveReadingReviewSchema, READING_REVIEW_RULE_VERSION } from '@eken/shared'
import type { ReadingReviewSnapshot } from '@eken/shared'
import { CHARGE_ASSESSMENT_POLICY, CHARGE_FINDING_POLICY, findingAllowsCharge } from './charge-gate'

// Självständigt facit, varken genererat från produktionsmappningen eller funktionen.
const decisions = [
  ['DATA', 'NEEDS_INVESTIGATION', false],
  ['DATA', 'CONFIRMED', false],
  ['DATA', 'EXPLAINED', false],
  ['OVERLAP', 'NEEDS_INVESTIGATION', false],
  ['OVERLAP', 'CONFIRMED', false],
  ['OVERLAP', 'EXPLAINED', false],
  ['DECREASE', 'NEEDS_INVESTIGATION', false],
  ['DECREASE', 'CONFIRMED', false],
  ['DECREASE', 'EXPLAINED', false],
  ['HIGH_RATE', 'NEEDS_INVESTIGATION', false],
  ['HIGH_RATE', 'CONFIRMED', false],
  ['HIGH_RATE', 'EXPLAINED', true],
] as const
const finding = (
  code: (typeof decisions)[number][0],
  assessment: (typeof decisions)[number][1],
): ReadingReviewSnapshot['findings'][number] => ({
  code,
  readingId: 'reading',
  meterId: 'meter',
  fingerprint: 'a',
  explanation: 'underlag',
  sourceReadings: [],
  reviews: [
    {
      id: 'review',
      revision: 1,
      fingerprint: 'a',
      assessment,
      ruleVersion: READING_REVIEW_RULE_VERSION,
      billingBasisDecision: 'VERIFIED_CORRECT_REAL_INCREASE',
      comment: 'Verklig ökning',
      reviewedByName: 'Ada Test',
      createdAt: '2026-01-01',
      evidence: {
        readingId: 'reading',
        meterId: 'meter',
        code,
        explanation: 'underlag',
        sourceReadings: [],
      },
    },
  ],
})
it('facit täcker varje finding och bedömningsvärde i alla kontraktskällor', () => {
  const codes = [...new Set(decisions.map((d) => d[0]))].sort()
  const statuses = [...new Set(decisions.map((d) => d[1]))].sort()
  expect(codes).toEqual(SaveReadingReviewSchema.shape.findingCode.options.slice().sort())
  expect(codes).toEqual(Object.keys(CHARGE_FINDING_POLICY).sort())
  expect(statuses).toEqual(Object.values(ReadingReviewAssessment).sort())
  expect(statuses).toEqual(SaveReadingReviewSchema.shape.assessment.options.slice().sort())
  expect(statuses).toEqual(Object.keys(CHARGE_ASSESSMENT_POLICY).sort())
  expect(decisions).toHaveLength(codes.length * statuses.length)
})
it.each(decisions)('%s + %s + uttryckligt intyg => %s', (code, status, allowed) => {
  expect(findingAllowsCharge(finding(code, status), READING_REVIEW_RULE_VERSION)).toBe(allowed)
})
it.each(['NEEDS_INVESTIGATION', 'CONFIRMED', 'EXPLAINED'] as const)(
  '%s ensamt ger NEJ',
  (status) => {
    const f = finding('HIGH_RATE', status)
    delete f.reviews[0]!.billingBasisDecision
    expect(findingAllowsCharge(f, READING_REVIEW_RULE_VERSION)).toBe(false)
  },
)
it('saknad, felaktig, gammal version eller revision ger NEJ', () => {
  const f = finding('HIGH_RATE', 'EXPLAINED')
  expect(findingAllowsCharge({ ...f, reviews: [] }, READING_REVIEW_RULE_VERSION)).toBe(false)
  expect(findingAllowsCharge(f, 'ny-regel')).toBe(false)
  expect(findingAllowsCharge({ ...f, fingerprint: 'ändrat' }, READING_REVIEW_RULE_VERSION)).toBe(
    false,
  )
  f.reviews.push({ ...f.reviews[0]!, id: 'latest', revision: 2, billingBasisDecision: 'INCORRECT' })
  expect(findingAllowsCharge(f, READING_REVIEW_RULE_VERSION)).toBe(false)
})
it.each(['DATA', 'OVERLAP', 'DECREASE'] as const)(
  'ett giltigt HIGH_RATE tillsammans med %s ger NEJ',
  (code) => {
    const all = [finding('HIGH_RATE', 'EXPLAINED'), finding(code, 'EXPLAINED')]
    expect(all.every((f) => findingAllowsCharge(f, READING_REVIEW_RULE_VERSION))).toBe(false)
  },
)
