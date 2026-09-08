import { reviewReadings } from '@eken/shared'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ReadingReviewContent as ReportContent } from './ReadingReview'
import type { ReviewReading } from '../lib/reading-review'
afterEach(cleanup)
const row = (
  n: number,
  value: number | string,
  extra: Partial<ReviewReading> = {},
): ReviewReading => ({
  id: `r${n}`,
  organizationId: 'org',
  meterId: 'meter',
  value,
  readingType: 'PERIOD_VOLUME',
  periodStart: `2026-01-0${n}`,
  periodEnd: `2026-01-0${n}`,
  ...extra,
})
const label = () => 'Vatten · Lägenhet 101'
it('öppnar underlaget från varningen med rätt beräkning', () => {
  render(
    <ReadingReviewContent
      meterLabel={label}
      readings={[10, 10, 10, 40].map((v, i) => row(i + 1, v))}
    />,
  )
  const summary = screen.getByText('Visa underlag och kontrollsteg')
  const details = summary.closest('details')!
  expect(details.open).toBe(false)
  fireEvent.click(summary)
  expect(details.open).toBe(true)
  expect(
    within(details).getByText(
      'Medianen är 10 mätenheter/dag. Varningsgränsen är 30 mätenheter/dag (3 × medianen).',
    ),
  ).toBeTruthy()
  expect(within(details).getByText('40 / 1 dag = 40 mätenheter/dag')).toBeTruthy()
  expect(within(details).getByText(/säsong eller ändrad användning/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  fireEvent.click(summary)
  expect(details.open).toBe(false)
})
it('visar originalställningarna och mänskliga kontrollsteg vid minskning', () => {
  render(
    <ReadingReviewContent
      meterLabel={label}
      readings={[
        row(1, '100.000', { readingType: 'CUMULATIVE' }),
        row(2, '90.000', { readingType: 'CUMULATIVE' }),
      ]}
    />,
  )
  fireEvent.click(screen.getByText('Visa underlag och kontrollsteg'))
  expect(screen.getByText('Mätarställning: 100.000 mätenheter')).toBeTruthy()
  expect(screen.getByText('Mätarställning: 90.000 mätenheter')).toBeTruthy()
  expect(screen.getByText(/dokumenterat mätarbyte/)).toBeTruthy()
  expect(screen.queryByText('Så räknades jämförelsen')).toBeNull()
})
it('visar ogiltiga datum och tomma värden utan att krascha', () => {
  render(<ReadingReviewContent meterLabel={label} readings={[row(1, '', { periodEnd: 'fel' })]} />)
  fireEvent.click(screen.getByText('Visa underlag och kontrollsteg'))
  expect(screen.getByText(/Ogiltigt datum: fel/)).toBeTruthy()
  expect(screen.getByText(/Periodvolym: \(tomt värde\)/)).toBeTruthy()
})
it('gammalt underlag försvinner när hämtade data byts', () => {
  const { rerender } = render(
    <ReadingReviewContent
      meterLabel={label}
      readings={[10, 10, 10, 40].map((v, i) => row(i + 1, v))}
    />,
  )
  fireEvent.click(screen.getByText('Visa underlag och kontrollsteg'))
  rerender(
    <ReadingReviewContent meterLabel={label} readings={[row(1, 10, { organizationId: 'new' })]} />,
  )
  expect(screen.queryByText('Visa underlag och kontrollsteg')).toBeNull()
  expect(screen.queryByText('Så räknades jämförelsen')).toBeNull()
})

function ReadingReviewContent({
  readings,
  meterLabel,
}: {
  readings: readonly ReviewReading[]
  meterLabel: (id: string) => string
}) {
  return (
    <ReportContent
      report={{
        ...reviewReadings(readings),
        history: [],
        ruleVersion: 'consumption-review-v1',
        findings: reviewReadings(readings).findings.map((f) => ({
          ...f,
          fingerprint: 'a'.repeat(64),
          reviews: [],
        })),
      }}
      meterLabel={meterLabel}
    />
  )
}
