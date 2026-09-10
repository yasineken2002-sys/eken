import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import {
  SaveReadingReviewSchema,
  READING_REVIEW_ASSESSMENT_LABELS,
  latestReadingReview,
  readingReviewState,
  READING_REVIEW_STATE_LABELS,
} from '@eken/shared'
import type {
  ReadingReviewSnapshot,
  SaveReadingReviewInput,
  ReadingReviewDecision,
} from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { saveReadingReview } from '../api/reading-review.api'
import { ReadingReviewEvidence } from './ReadingReviewEvidence'

type Finding = ReadingReviewSnapshot['findings'][number]
const time = (value: string) =>
  new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )

interface AssessmentFormProps {
  finding: Finding
  onClose: () => void
  onSaved: () => void
  unavailable: boolean
}
function AssessmentForm({ finding, onClose, onSaved, unavailable }: AssessmentFormProps) {
  const qc = useQueryClient()
  const formId = useId()
  const [basis, setBasis] = useState({
    fingerprint: finding.fingerprint,
    revision: latestReadingReview(finding)?.revision ?? 0,
  })
  const [reloaded, setReloaded] = useState(false)
  const stale =
    unavailable ||
    basis.fingerprint !== finding.fingerprint ||
    basis.revision !== (latestReadingReview(finding)?.revision ?? 0)
  const form = useForm<SaveReadingReviewInput>({
    resolver: zodResolver(SaveReadingReviewSchema),
    defaultValues: {
      readingId: finding.readingId,
      findingCode: finding.code,
      fingerprint: basis.fingerprint,
      expectedRevision: basis.revision,
      assessment: 'NEEDS_INVESTIGATION',
      comment: '',
    },
  })
  const save = useMutation({
    mutationFn: saveReadingReview,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['readings', 'review'] })
      onSaved()
    },
  })
  const conflict = axios.isAxiosError(save.error) && save.error.response?.status === 409
  return (
    <form
      className="mt-3 space-y-3 rounded-xl border border-gray-200 bg-white p-4"
      onSubmit={form.handleSubmit((dto) => {
        if (!stale) save.mutate(dto)
      })}
      aria-label="Spara bedömning"
    >
      <div>
        <label className="block text-sm font-medium" htmlFor={`${formId}-assessment`}>
          Bedömning
        </label>
        <select
          id={`${formId}-assessment`}
          className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
          {...form.register('assessment')}
          disabled={save.isPending || stale}
        >
          {Object.entries(READING_REVIEW_ASSESSMENT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium" htmlFor={`${formId}-basis`}>
          Intyg om debiteringsunderlaget
        </label>
        <select
          id={`${formId}-basis`}
          className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
          {...form.register('billingBasisDecision', { setValueAs: (value) => value || undefined })}
          disabled={save.isPending || stale}
        >
          <option value="">Inget intyg om korrekt underlag</option>
          <option value="INCORRECT">Underlaget är felaktigt – debitering spärras</option>
          {finding.code === 'HIGH_RATE' && (
            <option value="VERIFIED_CORRECT_REAL_INCREASE">
              Jag intygar korrekt underlag och verklig, förklarad ökning
            </option>
          )}
        </select>
        <p className="mt-1 text-xs text-gray-600">
          Intyget gäller mätvärde, period och visade jämförelseavläsningar. Kontrollera dessa och
          beskriv ökningen. Endast Förklarad avvikelse tillsammans med detta uttryckliga intyg kan
          tillåta en hög förbrukning. En kommentar rättar inga data. Rättelsevägen är ett separat
          kommande bygge.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium" htmlFor={`${formId}-comment`}>
          Motivering
        </label>
        <textarea
          id={`${formId}-comment`}
          className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
          rows={3}
          maxLength={1000}
          {...form.register('comment')}
          disabled={save.isPending || stale}
        />
      </div>
      {form.formState.errors.comment && (
        <p role="alert" className="text-sm text-red-600">
          {form.formState.errors.comment.message}
        </p>
      )}
      <p className="text-xs text-gray-600">
        Bedömningen sparas med ditt namn och underlaget du granskat. Den ändrar inga avläsningar,
        förbrukningsposter eller fakturor.
      </p>
      {stale || conflict ? (
        <div role="alert" className="text-sm text-amber-800">
          Underlaget eller bedömningen har ändrats. Läs om innan du sparar. Om varningen har
          försvunnit eller bytt kod finns ditt utkast kvar, men kan inte sparas mot den gamla
          varningen.
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={async () => {
              await qc.invalidateQueries({ queryKey: ['readings', 'review'] })
              setReloaded(true)
            }}
          >
            Läs om granskningen
          </Button>
          {reloaded && !unavailable && (
            <Button
              type="button"
              onClick={() => {
                const next = {
                  fingerprint: finding.fingerprint,
                  revision: latestReadingReview(finding)?.revision ?? 0,
                }
                setBasis(next)
                form.setValue('fingerprint', next.fingerprint)
                form.setValue('expectedRevision', next.revision)
                // Ett nytt underlag kräver ett nytt uttryckligt intyg. Motiveringen bevaras.
                form.setValue('billingBasisDecision', undefined)
                save.reset()
                setReloaded(false)
              }}
            >
              Jag har granskat det omlästa underlaget
            </Button>
          )}
        </div>
      ) : (
        save.isError && (
          <p role="alert" className="text-sm text-red-600">
            Bedömningen kunde inte sparas. Din motivering finns kvar; försök igen.
          </p>
        )
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || stale || conflict}>
          {save.isPending ? 'Sparar…' : 'Spara bedömning'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={save.isPending}
          onClick={onClose}
        >
          Avbryt
        </Button>
      </div>
    </form>
  )
}

interface ReadingReviewAssessmentProps {
  finding: Finding
  canAssess: boolean
  unavailable?: boolean
  onEditingChange?: (editing: boolean) => void
}
export function ReadingReviewAssessment({
  finding,
  canAssess,
  unavailable = false,
  onEditingChange,
}: ReadingReviewAssessmentProps) {
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const latest = latestReadingReview(finding)
  return (
    <div className="mt-4 text-sm">
      <p className="font-medium">
        {latest?.fingerprint === finding.fingerprint ? 'Senaste bedömning: ' : ''}
        {READING_REVIEW_STATE_LABELS[readingReviewState(finding)]}
      </p>
      <p>
        Intyg:{' '}
        {latest?.billingBasisDecision === 'VERIFIED_CORRECT_REAL_INCREASE'
          ? 'Korrekt underlag och verklig, förklarad ökning'
          : latest?.billingBasisDecision === 'INCORRECT'
            ? 'Underlaget bedömt felaktigt'
            : 'Inget intyg om korrekt underlag'}
      </p>
      {saved && (
        <p role="status" className="mt-1 text-gray-600">
          Bedömningen har sparats.
        </p>
      )}
      {canAssess && !editing && (
        <Button
          className="mt-2"
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setSaved(false)
            setEditing(true)
            onEditingChange?.(true)
          }}
        >
          {latest ? 'Lägg till ny bedömning' : 'Bedöm varningen'}
        </Button>
      )}
      {canAssess && editing && (
        <AssessmentForm
          finding={finding}
          unavailable={unavailable}
          onClose={() => {
            setEditing(false)
            onEditingChange?.(false)
          }}
          onSaved={() => {
            setEditing(false)
            setSaved(true)
            onEditingChange?.(false)
          }}
        />
      )}
    </div>
  )
}

interface ReadingReviewHistoryProps {
  history: readonly ReadingReviewDecision[]
  meterLabel: (id: string) => string
}
export function ReadingReviewHistory({ history, meterLabel }: ReadingReviewHistoryProps) {
  if (!history.length) return null
  return (
    <details className="rounded-xl border border-gray-200 bg-white p-5">
      <summary className="cursor-pointer font-semibold">
        Bedömningshistorik ({history.length})
      </summary>
      <p className="mt-2 text-sm text-gray-600">
        Tidigare bedömningar finns kvar även när varningen eller underlaget har ändrats.
      </p>
      <ol className="mt-4 space-y-4">
        {history.map((review) => (
          <li key={review.id} className="rounded-xl border border-gray-200 p-4">
            <h3 className="font-medium">
              {meterLabel(review.evidence.meterId)} ·{' '}
              {READING_REVIEW_ASSESSMENT_LABELS[review.assessment]}
            </h3>
            <p className="mt-1 text-xs text-gray-600">
              {review.reviewedByName} · {time(review.createdAt)} · Bedömning {review.revision}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-700">
              {review.comment}
            </p>
            {review.billingBasisDecision && (
              <p>
                Intyg:{' '}
                {review.billingBasisDecision === 'INCORRECT'
                  ? 'Underlaget bedömt felaktigt'
                  : 'Korrekt underlag och verklig, förklarad ökning'}
              </p>
            )}
            <p>
              Intyg:{' '}
              {review.billingBasisDecision === 'VERIFIED_CORRECT_REAL_INCREASE'
                ? 'Korrekt underlag och verklig, förklarad ökning'
                : review.billingBasisDecision === 'INCORRECT'
                  ? 'Underlaget bedömt felaktigt'
                  : 'Inget intyg om korrekt underlag'}
            </p>
            <ReadingReviewEvidence finding={review.evidence} />
          </li>
        ))}
      </ol>
    </details>
  )
}
