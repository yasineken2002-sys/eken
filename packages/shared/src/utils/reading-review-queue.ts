import type { ReadingReviewFilter } from '../schemas'
import { READING_REVIEW_ASSESSMENT_LABELS } from './reading-review'
import type { ReadingReviewSnapshot } from './reading-review'

type Finding = ReadingReviewSnapshot['findings'][number]
export type ReadingReviewState = Exclude<ReadingReviewFilter, 'ALL' | 'TO_ASSESS'>

export const READING_REVIEW_STATE_LABELS: Record<ReadingReviewState, string> = {
  UNASSESSED: 'Ingen bedömning sparad',
  CHANGED_EVIDENCE: 'Ändrat underlag – behöver bedömas på nytt',
  ...READING_REVIEW_ASSESSMENT_LABELS,
}
export const READING_REVIEW_FILTER_LABELS: Record<ReadingReviewFilter, string> = {
  ALL: 'Alla varningar',
  TO_ASSESS: 'Behöver bedömas',
  UNASSESSED: 'Utan bedömning',
  NEEDS_INVESTIGATION: 'Behöver utredas',
  CHANGED_EVIDENCE: 'Ändrat underlag',
  CONFIRMED: 'Avvikelsen bekräftad',
  EXPLAINED: 'Förklarad avvikelse',
}

/** Senaste revisionen gäller även om en äldre revision råkar matcha underlaget. */
export function latestReadingReview(finding: Finding) {
  return finding.reviews.reduce<Finding['reviews'][number] | undefined>(
    (latest, row) => (!latest || row.revision > latest.revision ? row : latest),
    undefined,
  )
}

export function readingReviewState(finding: Finding): ReadingReviewState {
  const latest = latestReadingReview(finding)
  if (!latest) return 'UNASSESSED'
  return latest.fingerprint === finding.fingerprint ? latest.assessment : 'CHANGED_EVIDENCE'
}

const PRIORITY: Record<ReadingReviewState, number> = {
  CHANGED_EVIDENCE: 0,
  NEEDS_INVESTIGATION: 1,
  UNASSESSED: 2,
  CONFIRMED: 3,
  EXPLAINED: 4,
}

/** Urval EFTER analys. Räknare gäller alla aktuella varningar, aldrig historikrader.
 * Bedömd betyder inte åtgärdad, korrekt avläst eller godkänd för debitering.
 * Ändrar varken indata, regler, underlag eller sparade bedömningar.
 */
export function readingReviewQueue(
  findings: readonly Finding[],
  filter: ReadingReviewFilter = 'ALL',
) {
  const counts: Record<ReadingReviewFilter, number> = {
    ALL: findings.length,
    TO_ASSESS: 0,
    UNASSESSED: 0,
    NEEDS_INVESTIGATION: 0,
    CHANGED_EVIDENCE: 0,
    CONFIRMED: 0,
    EXPLAINED: 0,
  }
  const entries = findings.map((finding) => {
    const state = readingReviewState(finding)
    const toAssess =
      state === 'UNASSESSED' || state === 'NEEDS_INVESTIGATION' || state === 'CHANGED_EVIDENCE'
    counts[state]++
    if (toAssess) counts.TO_ASSESS++
    return { finding, state, toAssess }
  })
  return {
    filter,
    counts,
    findings: entries
      .filter(
        (entry) =>
          filter === 'ALL' || (filter === 'TO_ASSESS' ? entry.toAssess : entry.state === filter),
      )
      .sort((a, b) => {
        const priority = PRIORITY[a.state] - PRIORITY[b.state]
        if (priority) return priority
        const aKey = `${a.finding.readingId}:${a.finding.code}`
        const bKey = `${b.finding.readingId}:${b.finding.code}`
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
      })
      .map(({ finding }) => finding),
  }
}
