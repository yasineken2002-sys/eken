import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, AlertTriangle, ReceiptText, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@eken/shared'
import { useBackfillPreview, useConfirmBackfill } from '../hooks/useBackfill'
import type { BackfillQueueItem, BackfillResult } from '../api/backfill.api'

interface Props {
  item: BackfillQueueItem
  onClose: () => void
  onDone: () => void
}

const MONTHS = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`
}

export function BackfillConfirmModal({ item, onClose, onDone }: Props) {
  const { data: preview, isLoading } = useBackfillPreview(item.leaseId)
  const confirm = useConfirmBackfill()
  const [allowBeyond, setAllowBeyond] = useState(false)
  const [vatAck, setVatAck] = useState(false)
  const [result, setResult] = useState<BackfillResult | null>(null)

  const billable = preview?.months.filter((m) => m.status === 'BILLABLE') ?? []
  const beyond = preview?.months.filter((m) => m.status === 'BEYOND_WARNING') ?? []
  const blocked =
    preview?.months.filter((m) => m.status === 'BEYOND_HARD_CAP' || m.status === 'CLOSED_PERIOD') ??
    []

  const s = preview?.summary
  const selectedCount = (s?.billableCount ?? 0) + (allowBeyond ? (s?.beyondWarningCount ?? 0) : 0)
  const selectedTotal = (s?.billableTotal ?? 0) + (allowBeyond ? (s?.beyondWarningTotal ?? 0) : 0)

  // >12-mån-månader kan bara skapas om aktören uttryckligen kryssat i grinden.
  const needsApprovalUnchecked = beyond.length > 0 && !allowBeyond
  // Momspliktig lokal måste bekräftas (bokförings HIGH) — server-side grindat,
  // speglat i UI så knappen inte kan tryckas oinformerat.
  const needsVatAck = preview?.hasVoluntaryTaxLiability === true && !vatAck
  const canConfirm = selectedCount > 0 && !needsVatAck && !confirm.isPending

  const handleConfirm = async () => {
    const res = await confirm.mutateAsync({
      leaseId: item.leaseId,
      allowBeyondWarning: allowBeyond,
      vatDeclarationAcknowledged: vatAck,
    })
    setResult(res)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-[#EAEDF0] bg-white shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[#EAEDF0] p-6 pb-5">
          <div>
            <h2 className="text-[17px] font-semibold text-gray-900">Efterdebitera hyra</h2>
            <p className="mt-1 text-[13px] text-gray-500">
              {item.tenantName} · {item.unitLabel}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {result ? (
            <ResultView result={result} />
          ) : isLoading || !preview ? (
            <p className="py-8 text-center text-[13px] text-gray-400">Läser in perioder…</p>
          ) : (
            <>
              {/* Debiterbara månader */}
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Perioder att efterfakturera
              </p>
              <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
                {billable.map((m) => (
                  <div
                    key={`${m.year}-${m.month}`}
                    className="flex items-center justify-between border-b border-[#EAEDF0] px-3.5 py-2.5 last:border-0"
                  >
                    <div>
                      <p className="text-[13.5px] font-medium text-gray-800">
                        Hyra {monthLabel(m.year, m.month)}
                        {m.isProrated ? ' (delmånad)' : ''}
                      </p>
                      <p className="text-[12px] text-gray-400">
                        Efterfakturerad pga sen registrering · {m.daysCharged} av {m.totalDays}{' '}
                        dagar
                      </p>
                    </div>
                    <span className="text-[13.5px] font-semibold text-gray-900">
                      {formatCurrency(Number(m.totalAmount))}
                    </span>
                  </div>
                ))}
                {billable.length === 0 && (
                  <p className="px-3.5 py-4 text-[13px] text-gray-400">
                    Inga månader inom 12 månader kvarstår att debitera.
                  </p>
                )}
              </div>

              {/* >12-mån-grind (sannolikt datafel) */}
              {beyond.length > 0 && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      size={16}
                      strokeWidth={1.8}
                      className="mt-0.5 flex-shrink-0 text-amber-600"
                    />
                    <div className="flex-1">
                      <p className="text-[13.5px] font-semibold text-amber-800">
                        Lång bakdatering — kontrollera startdatumet
                      </p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-amber-700">
                        {beyond.length} månad(er) ligger mer än 12 månader bakåt. En så lång
                        efterdebitering beror oftast på ett felaktigt tillträdesdatum. Kontrollera
                        att kontraktets startdatum stämmer innan du godkänner.
                      </p>
                      <ul className="mt-2 space-y-0.5">
                        {beyond.map((m) => (
                          <li key={`${m.year}-${m.month}`} className="text-[12.5px] text-amber-700">
                            {monthLabel(m.year, m.month)} — {formatCurrency(Number(m.totalAmount))}{' '}
                            ({m.ageMonths} mån bakåt)
                          </li>
                        ))}
                      </ul>
                      <label className="mt-3 flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={allowBeyond}
                          onChange={(e) => setAllowBeyond(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span className="text-[12.5px] font-medium text-amber-800">
                          Startdatumet stämmer — efterdebitera även dessa månader
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Momsperiod-disclaimer (momspliktig lokal) */}
              {preview.hasVoluntaryTaxLiability && (
                <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <div className="flex items-start gap-2.5">
                    <Info
                      size={16}
                      strokeWidth={1.8}
                      className="mt-0.5 flex-shrink-0 text-blue-600"
                    />
                    <div>
                      <p className="text-[13.5px] font-semibold text-blue-800">
                        Momspliktig lokal — kontrollera momsdeklarationen
                      </p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-blue-700">
                        Perioderna kan falla i en redan lämnad momsdeklaration. En efterdebitering
                        bakåt kan kräva att du rättar deklarationen för berörda perioder. Stäm av
                        med din redovisning innan du bekräftar.
                      </p>
                      <label className="mt-3 flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={vatAck}
                          onChange={(e) => setVatAck(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-[12.5px] font-medium text-blue-800">
                          Jag har kontrollerat momsdeklarationen för berörda perioder
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Ej debiterbart (info) */}
              {blocked.length > 0 && (
                <p className="mt-4 text-[12px] leading-relaxed text-gray-400">
                  {blocked.length} månad(er) skapas inte: preskriberade (&gt;3 år) eller i stängd
                  räkenskapsperiod. De hanteras manuellt vid behov.
                </p>
              )}

              {confirm.isError && (
                <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
                  <AlertCircle size={14} strokeWidth={1.8} />
                  Efterdebiteringen misslyckades. Försök igen.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-[#EAEDF0] p-6 pt-5">
          {result ? (
            <Button variant="primary" className="ml-auto" onClick={onDone}>
              Klar
            </Button>
          ) : (
            <>
              <div className="text-[13px] text-gray-500">
                {selectedCount > 0 ? (
                  <>
                    <span className="font-semibold text-gray-900">{selectedCount}</span> månad(er) ·{' '}
                    <span className="font-semibold text-gray-900">
                      {formatCurrency(selectedTotal)}
                    </span>
                  </>
                ) : (
                  'Inget att debitera'
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose} disabled={confirm.isPending}>
                  Avbryt
                </Button>
                <Button
                  variant="primary"
                  loading={confirm.isPending}
                  disabled={!canConfirm}
                  onClick={() => void handleConfirm()}
                  title={
                    needsVatAck
                      ? 'Bekräfta momsdeklarationen för att fortsätta'
                      : needsApprovalUnchecked && selectedCount === 0
                        ? 'Kryssa i den långa bakdateringen för att fortsätta'
                        : undefined
                  }
                >
                  <ReceiptText size={13} strokeWidth={1.8} />
                  Bekräfta efterdebitering
                </Button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </div>
  )
}

function ResultView({ result }: { result: BackfillResult }) {
  const createdCount = result.created.length
  const rows = (
    [
      { label: 'Skapade avier', value: createdCount, tone: 'ok' },
      { label: 'Redan aviserade (hoppade över)', value: result.skippedExisting, tone: 'muted' },
      { label: 'Stängd period (ej skapade)', value: result.skippedClosed, tone: 'warn' },
      { label: 'Utan godkännande (>12 mån)', value: result.skippedBeyondWarning, tone: 'muted' },
      { label: 'Preskriberade (>3 år)', value: result.blockedHardCap, tone: 'muted' },
      { label: 'Konto saknas i kontoplanen', value: result.skippedMissingAccount, tone: 'warn' },
    ] as const
  ).filter((r) => r.value > 0)

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5">
        <CheckCircle2 size={18} strokeWidth={1.8} className="text-emerald-600" />
        <p className="text-[14px] font-semibold text-gray-900">
          {createdCount > 0 ? `${createdCount} avi(er) efterdebiterade` : 'Inga nya avier skapades'}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between border-b border-[#EAEDF0] px-3.5 py-2.5 text-[13px] last:border-0"
          >
            <span className="text-gray-600">{r.label}</span>
            <span
              className={
                r.tone === 'ok'
                  ? 'font-semibold text-emerald-700'
                  : r.tone === 'warn'
                    ? 'font-semibold text-amber-700'
                    : 'font-medium text-gray-500'
              }
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
      {(result.skippedClosed > 0 || result.skippedMissingAccount > 0) && (
        <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
          Poster som inte kunde skapas har genererat en systemnotis till organisationen — hantera
          dem manuellt i öppen period.
        </p>
      )}
    </div>
  )
}
