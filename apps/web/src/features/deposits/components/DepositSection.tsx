import { useState } from 'react'
import { CreditCard, Plus, RefreshCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { DepositStatusBadge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@eken/shared'
import {
  useDeposits,
  useCreateDeposit,
  useMarkDepositPaid,
  useRefundDeposit,
} from '../hooks/useDeposits'
import type { DepositDetail } from '../api/deposits.api'

interface Props {
  leaseId: string
  /** Förvald defaultsumma från avtalet (Lease.depositAmount) */
  fallbackAmount: number
}

export function DepositSection({ leaseId, fallbackAmount }: Props) {
  const { data: deposits = [], isLoading } = useDeposits({ leaseId })
  const deposit = deposits[0] ?? null

  const [showCreate, setShowCreate] = useState(false)
  const [showRefund, setShowRefund] = useState(false)

  const createMutation = useCreateDeposit()
  const payMutation = useMarkDepositPaid()

  const handleCreate = (amount: number, notes: string) => {
    createMutation.mutate(
      { leaseId, amount, ...(notes ? { notes } : {}) },
      { onSuccess: () => setShowCreate(false) },
    )
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-100 p-4 text-[12.5px] text-gray-400">
        Laddar deposition…
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CreditCard size={14} strokeWidth={1.8} className="text-gray-400" />
          <p className="text-[13px] font-semibold text-gray-800">Deposition</p>
        </div>
        {deposit && <DepositStatusBadge status={deposit.status} />}
      </div>

      {deposit ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Cell label="Belopp" value={formatCurrency(Number(deposit.amount))} />
            {deposit.paidAt && <Cell label="Betald" value={formatDate(deposit.paidAt)} />}
            {deposit.refundedAt && (
              <Cell
                label="Återbetald"
                value={`${formatDate(deposit.refundedAt)}${
                  deposit.refundAmount != null
                    ? ` · ${formatCurrency(Number(deposit.refundAmount))}`
                    : ''
                }`}
              />
            )}
            {deposit.invoice && (
              <Cell
                label="Faktura"
                value={`${deposit.invoice.invoiceNumber} (${deposit.invoice.status})`}
              />
            )}
          </div>

          {deposit.deductions && deposit.deductions.length > 0 && (
            <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Avdrag
              </p>
              <ul className="mt-1 space-y-0.5">
                {deposit.deductions.map((d, i) => (
                  <li key={i} className="flex justify-between text-[12.5px] text-gray-700">
                    <span>{d.reason}</span>
                    <span className="font-medium">{formatCurrency(Number(d.amount))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {deposit.status === 'PENDING' && (
              <Button
                size="sm"
                variant="primary"
                loading={payMutation.isPending}
                onClick={() => payMutation.mutate(deposit.id)}
              >
                Markera som betald
              </Button>
            )}
            {(deposit.status === 'PAID' || deposit.status === 'REFUND_PENDING') && (
              <Button size="sm" variant="primary" onClick={() => setShowRefund(true)}>
                <RefreshCcw size={13} strokeWidth={1.8} />
                Återbetala
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-[12.5px] text-gray-500">
            Ingen deposition är registrerad för det här kontraktet.
          </p>
          <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
            <Plus size={13} strokeWidth={1.8} />
            Registrera deposition
          </Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Registrera deposition"
        size="sm"
      >
        <CreateDepositForm
          fallbackAmount={fallbackAmount}
          isSubmitting={createMutation.isPending}
          onCancel={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      </Modal>

      {/* Refund modal */}
      {deposit && (
        <Modal
          open={showRefund}
          onClose={() => setShowRefund(false)}
          title="Återbetala deposition"
          size="md"
        >
          <RefundForm
            deposit={deposit}
            onCancel={() => setShowRefund(false)}
            onSuccess={() => setShowRefund(false)}
          />
        </Modal>
      )}
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium text-gray-800">{value}</p>
    </div>
  )
}

// ─── Create form ──────────────────────────────────────────────────────────────

function CreateDepositForm({
  fallbackAmount,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  fallbackAmount: number
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (amount: number, notes: string) => void
}) {
  const [amount, setAmount] = useState(String(fallbackAmount || ''))
  const [notes, setNotes] = useState('')

  const submit = () => {
    const num = Number(amount)
    if (!num || num <= 0) return
    onSubmit(num, notes.trim())
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600">
        En faktura av typen <span className="font-semibold">Deposition</span> skapas automatiskt och
        skickas till hyresgästen. Bokföringspost: 1510 D / 2490 K.
      </p>

      <Input
        label="Belopp (kr)"
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <Input
        label="Notering (valfri)"
        placeholder="t.ex. 3 månadshyror"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={isSubmitting}
          onClick={submit}
          disabled={!amount || Number(amount) <= 0}
        >
          Registrera
        </Button>
      </ModalFooter>
    </div>
  )
}

// ─── Refund form ──────────────────────────────────────────────────────────────

interface DeductionRow {
  reason: string
  amount: string
}

function RefundForm({
  deposit,
  onCancel,
  onSuccess,
}: {
  deposit: DepositDetail
  onCancel: () => void
  onSuccess: () => void
}) {
  const total = Number(deposit.amount)
  const [deductions, setDeductions] = useState<DeductionRow[]>([])
  const [refundAmountStr, setRefundAmountStr] = useState(String(total))
  const [touchedRefund, setTouchedRefund] = useState(false)
  const refundMutation = useRefundDeposit()

  const deductionsTotal = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0)
  // Om användaren inte rört återbetalningsfältet, räkna om automatiskt.
  const computedRefund = touchedRefund
    ? Number(refundAmountStr) || 0
    : Math.max(0, total - deductionsTotal)
  const remaining = Number((total - deductionsTotal - computedRefund).toFixed(2))
  const valid = Math.abs(remaining) < 0.01 && computedRefund >= 0

  const updateDeduction = (idx: number, key: keyof DeductionRow, value: string) => {
    setDeductions((prev) => prev.map((d, i) => (i === idx ? { ...d, [key]: value } : d)))
  }

  const submit = () => {
    if (!valid) return
    refundMutation.mutate(
      {
        id: deposit.id,
        refundAmount: computedRefund,
        deductions: deductions
          .filter((d) => d.reason.trim() && Number(d.amount) > 0)
          .map((d) => ({ reason: d.reason.trim(), amount: Number(d.amount) })),
      },
      { onSuccess },
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] text-gray-600">
        Total deposition: <span className="font-semibold">{formatCurrency(total)}</span>
      </div>

      {/* Deductions */}
      <div className="space-y-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">
          Avdrag (valfritt)
        </p>
        {deductions.length === 0 && (
          <p className="text-[12px] text-gray-400">Inga avdrag — fullt belopp återbetalas.</p>
        )}
        {deductions.map((d, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label={i === 0 ? 'Beskrivning' : ''}
                placeholder="t.ex. Skada på golv"
                value={d.reason}
                onChange={(e) => updateDeduction(i, 'reason', e.target.value)}
              />
            </div>
            <div className="w-32">
              <Input
                label={i === 0 ? 'Belopp (kr)' : ''}
                type="number"
                value={d.amount}
                onChange={(e) => updateDeduction(i, 'amount', e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => setDeductions((prev) => prev.filter((_, j) => j !== i))}
              className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#DDDFE4] text-gray-400 hover:border-red-200 hover:text-red-500"
            >
              <Trash2 size={13} strokeWidth={1.8} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setDeductions((prev) => [...prev, { reason: '', amount: '' }])}
          className="text-[12.5px] font-medium text-blue-600 hover:text-blue-700"
        >
          + Lägg till avdrag
        </button>
      </div>

      {/* Refund amount */}
      <Input
        label="Återbetalningsbelopp (kr)"
        type="number"
        value={touchedRefund ? refundAmountStr : String(computedRefund)}
        onChange={(e) => {
          setTouchedRefund(true)
          setRefundAmountStr(e.target.value)
        }}
      />

      <div className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px]">
        <div className="flex justify-between text-gray-700">
          <span>Avdrag totalt</span>
          <span className="font-medium">{formatCurrency(deductionsTotal)}</span>
        </div>
        <div className="flex justify-between text-gray-700">
          <span>Återbetalas</span>
          <span className="font-medium">{formatCurrency(computedRefund)}</span>
        </div>
        <div
          className={`mt-1 flex justify-between border-t border-gray-200 pt-1 font-semibold ${
            valid ? 'text-gray-900' : 'text-red-600'
          }`}
        >
          <span>{valid ? 'Balanserar' : 'Ojämnt'}</span>
          <span>{formatCurrency(remaining)}</span>
        </div>
      </div>

      <ModalFooter>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={refundMutation.isPending}
        >
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={refundMutation.isPending}
          disabled={!valid}
          onClick={submit}
        >
          Bekräfta återbetalning
        </Button>
      </ModalFooter>
    </div>
  )
}
