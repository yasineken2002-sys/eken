import { useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Sparkles, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useGenerateNotices, useGenerateNoticesPreview } from '../hooks/useAvisering'

const MONTHS = [
  'Januari',
  'Februari',
  'Mars',
  'April',
  'Maj',
  'Juni',
  'Juli',
  'Augusti',
  'September',
  'Oktober',
  'November',
  'December',
]

interface Props {
  open: boolean
  month: number
  year: number
  onClose: () => void
  onSuccess: (created: number) => void
}

export function GenerateModal({ open, month, year, onClose, onSuccess }: Props) {
  if (!open) return null
  return (
    <GenerateModalContent
      key={`${year}-${month}`}
      month={month}
      year={year}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  )
}

type GenerationOutcome = {
  created: number
  skipped: number
  blockedByOpening: number
  failed: number
  blockedReason: string | null
}

function GenerateModalContent({ month, year, onClose, onSuccess }: Omit<Props, 'open'>) {
  const generate = useGenerateNotices()
  const preview = useGenerateNoticesPreview(month, year, true)
  const [outcome, setOutcome] = useState<GenerationOutcome | null>(null)
  const active = useRef(true)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const ready =
    preview.isSuccess &&
    !preview.isFetching &&
    preview.data.month === month &&
    preview.data.year === year

  const handleGenerate = async () => {
    if (!ready || preview.data.toCreate === 0) return
    setOutcome(null)
    try {
      const result = await generate.mutateAsync({ month, year })
      // En avslutad öppning eller period får inte kvittera en ny dialog.
      if (!active.current) return
      const failed = result.failed ?? 0
      const blockedByOpening = result.blockedByOpening ?? 0
      if (failed > 0 || blockedByOpening > 0) {
        // Utfallet kommer från svaret, inte den preview som hooken nu uppdaterar.
        setOutcome({
          created: result.created,
          skipped: result.skipped,
          failed,
          blockedByOpening,
          blockedReason: result.blockedReason ?? null,
        })
        return
      }
      onSuccess(result.created)
      onClose()
    } catch {
      // Mutationen visar felet nedan och behåller dialogen öppen.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-notices-title"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="border-line max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border bg-white p-6 shadow-xl"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 id="generate-notices-title" className="text-[17px] font-semibold text-gray-900">
              Generera hyresavier
            </h2>
            <p className="mt-0.5 text-[13px] text-gray-500">
              {MONTHS[month - 1]} {year}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Stäng"
            disabled={generate.isPending}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {outcome && (
          <div
            role="alert"
            className="mb-4 rounded-xl bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900"
          >
            <p className="font-medium">Resultat av genereringen</p>
            {outcome.blockedByOpening > 0 && (
              <p className="mt-1">
                {outcome.blockedReason?.trim()
                  ? outcome.blockedReason
                  : 'Avier blockerades av ett ofärdigt öppningspaket. Hantera öppningspaketet innan du försöker igen.'}
              </p>
            )}
            {outcome.failed > 0 && (
              <p className="mt-1">En eller flera avier kunde inte skapas. Försök igen.</p>
            )}
            <p className="mt-2">Skapade: {outcome.created}</p>
            <p>Överhoppade: {outcome.skipped}</p>
            <p>Blockerade: {outcome.blockedByOpening}</p>
            <p>Misslyckade: {outcome.failed}</p>
          </div>
        )}

        {generate.isError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
            <AlertCircle size={14} strokeWidth={1.8} />
            Generering misslyckades. Försök igen.
          </div>
        )}

        <div className="border-line mb-5 rounded-xl border bg-gray-50 px-4 py-3 text-[13px] text-gray-600">
          <p>Avier genereras för hyreskontrakt som omfattar perioden.</p>
          {preview.isFetching && (
            <p className="mt-2" role="status">
              Hämtar förfallodatum…
            </p>
          )}
          {preview.isError && !preview.isFetching && (
            <div className="mt-2" role="alert">
              <p>Förfallodatum kunde inte hämtas. Försök igen innan du genererar avier.</p>
              <Button variant="secondary" onClick={() => void preview.refetch()}>
                Försök igen
              </Button>
            </div>
          )}
          {ready && (
            <>
              <p className="mt-2 font-medium">{preview.data.toCreate} nya avier att skapa</p>
              {/* KUNDSTART: serverns skäl när perioden ligger före brytdatum — en nolla utan
                  skäl ser ut som ett fel eller som att avtalen saknas. */}
              {preview.data.beforeCutover && (
                <p className="mt-1 text-amber-700">{preview.data.beforeCutover}</p>
              )}
              {preview.data.dueDates.map(({ dueDate, count }) => (
                <p className="mt-1" key={dueDate}>
                  Förfallodatum: <strong>{dueDate}</strong> ({count} avier)
                </p>
              ))}
              {preview.data.existingDueDates.length > 0 && (
                <div className="mt-3">
                  <p>Avier som redan finns hoppas över. Deras förfallodatum:</p>
                  {preview.data.existingDueDates.map(({ dueDate, count }) => (
                    <p className="mt-1" key={dueDate}>
                      <strong>{dueDate}</strong> ({count} avier)
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-line flex justify-end gap-2 border-t pt-5">
          <Button variant="secondary" onClick={onClose} disabled={generate.isPending}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            loading={generate.isPending}
            disabled={generate.isPending || !ready || preview.data?.toCreate === 0}
            onClick={() => void handleGenerate()}
          >
            <Sparkles size={13} strokeWidth={1.8} />
            Generera avier
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
