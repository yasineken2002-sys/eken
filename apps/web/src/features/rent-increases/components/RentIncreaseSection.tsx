import { useState, useMemo } from 'react'
import { TrendingUp, Send, Check, X, RotateCcw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { RentIncreaseStatusBadge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@eken/shared'
import {
  useRentIncreases,
  useCreateRentIncrease,
  useSendRentIncreaseNotice,
  useAcceptRentIncrease,
  useRejectRentIncrease,
  useWithdrawRentIncrease,
} from '../hooks/useRentIncreases'
import type { RentIncreaseDetail } from '../api/rent-increases.api'

interface Props {
  leaseId: string
  currentRent: number
}

export function RentIncreaseSection({ leaseId, currentRent }: Props) {
  const { data: increases = [], isLoading } = useRentIncreases({ leaseId })
  const [showCreate, setShowCreate] = useState(false)
  const [rejecting, setRejecting] = useState<RentIncreaseDetail | null>(null)
  const sendMutation = useSendRentIncreaseNotice()
  const acceptMutation = useAcceptRentIncrease()
  const withdrawMutation = useWithdrawRentIncrease()
  const createMutation = useCreateRentIncrease()

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-100 p-4 text-[12.5px] text-gray-400">
        Laddar hyreshöjningar…
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} strokeWidth={1.8} className="text-gray-400" />
          <p className="text-[13px] font-semibold text-gray-800">Hyreshöjningar</p>
        </div>
        <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
          <Plus size={13} strokeWidth={1.8} />
          Ny hyreshöjning
        </Button>
      </div>

      {increases.length === 0 ? (
        <p className="text-[12.5px] text-gray-500">Inga hyreshöjningar registrerade.</p>
      ) : (
        <ul className="space-y-2">
          {increases.map((ri) => (
            <li key={ri.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold text-gray-900">
                      {formatCurrency(Number(ri.currentRent))} →{' '}
                      {formatCurrency(Number(ri.newRent))}
                    </span>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      +{Number(ri.increasePercent).toFixed(2)}%
                    </span>
                    <RentIncreaseStatusBadge status={ri.status} />
                  </div>
                  <p className="mt-0.5 text-[12px] text-gray-600">{ri.reason}</p>
                  <p className="mt-0.5 text-[11.5px] text-gray-400">
                    Gäller från {formatDate(ri.effectiveDate)}
                    {ri.noticeDate ? <> · Aviserad {formatDate(ri.noticeDate)}</> : null}
                    {ri.respondedAt ? <> · Svar {formatDate(ri.respondedAt)}</> : null}
                  </p>
                  {ri.rejectionReason && (
                    <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-[11.5px] text-red-700">
                      Anledning till nekande: {ri.rejectionReason}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {ri.status === 'DRAFT' && (
                  <>
                    <Button
                      size="xs"
                      variant="primary"
                      loading={sendMutation.isPending && sendMutation.variables === ri.id}
                      onClick={() => sendMutation.mutate(ri.id)}
                    >
                      <Send size={11} strokeWidth={1.8} />
                      Skicka avisering
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => withdrawMutation.mutate(ri.id)}
                    >
                      <RotateCcw size={11} strokeWidth={1.8} />
                      Återkalla
                    </Button>
                  </>
                )}
                {ri.status === 'NOTICE_SENT' && (
                  <>
                    <Button
                      size="xs"
                      variant="primary"
                      onClick={() => acceptMutation.mutate(ri.id)}
                      loading={acceptMutation.isPending && acceptMutation.variables === ri.id}
                    >
                      <Check size={11} strokeWidth={1.8} />
                      Markera godkänd
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setRejecting(ri)}>
                      <X size={11} strokeWidth={1.8} />
                      Markera nekad
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => withdrawMutation.mutate(ri.id)}
                    >
                      <RotateCcw size={11} strokeWidth={1.8} />
                      Återkalla
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Ny hyreshöjning"
        size="md"
      >
        <CreateForm
          leaseId={leaseId}
          currentRent={currentRent}
          isSubmitting={createMutation.isPending}
          onCancel={() => setShowCreate(false)}
          onSubmit={(dto) => createMutation.mutate(dto, { onSuccess: () => setShowCreate(false) })}
        />
      </Modal>

      {/* Reject modal */}
      {rejecting && (
        <Modal open onClose={() => setRejecting(null)} title="Markera som nekad" size="sm">
          <RejectForm
            rentIncreaseId={rejecting.id}
            onCancel={() => setRejecting(null)}
            onSuccess={() => setRejecting(null)}
          />
        </Modal>
      )}
    </div>
  )
}

// ─── Create form ──────────────────────────────────────────────────────────────

function CreateForm({
  leaseId,
  currentRent,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  leaseId: string
  currentRent: number
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (dto: {
    leaseId: string
    newRent: number
    reason: string
    effectiveDate: string
  }) => void
}) {
  const minDate = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 3)
    return d.toISOString().slice(0, 10)
  }, [])

  const [newRentStr, setNewRentStr] = useState(String(currentRent))
  const [reason, setReason] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(minDate)

  const newRent = Number(newRentStr) || 0
  const increase = newRent - currentRent
  const percent = currentRent > 0 ? (increase / currentRent) * 100 : 0

  const tooSoon = effectiveDate && effectiveDate < minDate
  const valid = newRent > currentRent && reason.trim().length >= 3 && !tooSoon

  const submit = () => {
    if (!valid) return
    onSubmit({
      leaseId,
      newRent,
      reason: reason.trim(),
      effectiveDate,
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600">
        Enligt svensk hyresrätt krävs minst <strong>3 månaders varsel</strong> innan en hyreshöjning
        får träda i kraft.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-[12px] font-medium text-gray-600">Nuvarande hyra</p>
          <div className="flex h-9 items-center rounded-lg border border-[#DDDFE4] bg-gray-50 px-3 text-[13.5px] text-gray-700">
            {formatCurrency(currentRent)}/mån
          </div>
        </div>
        <Input
          label="Ny månadshyra (kr)"
          type="number"
          value={newRentStr}
          onChange={(e) => setNewRentStr(e.target.value)}
        />
      </div>

      {newRent > 0 && (
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px]">
          <div className="flex justify-between text-gray-700">
            <span>Höjning</span>
            <span className={`font-semibold ${increase > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
              {increase > 0 ? '+' : ''}
              {formatCurrency(increase)} ({percent.toFixed(2)}%)
            </span>
          </div>
        </div>
      )}

      <Input
        label="Anledning"
        placeholder="t.ex. KPI-justering 2026"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div>
        <Input
          label="Gäller från"
          type="date"
          value={effectiveDate}
          min={minDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
        />
        {tooSoon && (
          <p className="mt-1 text-[12px] text-red-600">
            Datumet är för nära — minst 3 månader krävs ({formatDate(minDate)} eller senare).
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={isSubmitting}
          disabled={!valid}
          onClick={submit}
        >
          Skapa hyreshöjning
        </Button>
      </ModalFooter>
    </div>
  )
}

// ─── Reject form ──────────────────────────────────────────────────────────────

function RejectForm({
  rentIncreaseId,
  onCancel,
  onSuccess,
}: {
  rentIncreaseId: string
  onCancel: () => void
  onSuccess: () => void
}) {
  const [reason, setReason] = useState('')
  const reject = useRejectRentIncrease()

  const submit = () => {
    if (reason.trim().length < 2) return
    reject.mutate({ id: rentIncreaseId, rejectionReason: reason.trim() }, { onSuccess })
  }

  return (
    <div className="space-y-4">
      <Input
        label="Anledning till nekande"
        placeholder="t.ex. Hyresnämnden tar över ärendet"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={reject.isPending}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={reject.isPending}
          disabled={reason.trim().length < 2}
          onClick={submit}
        >
          Markera som nekad
        </Button>
      </ModalFooter>
    </div>
  )
}
