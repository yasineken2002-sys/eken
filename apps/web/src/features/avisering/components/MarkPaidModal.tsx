import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { formatCurrency } from '@eken/shared'
import { useMarkAsPaid } from '../hooks/useAvisering'
import type { PaymentMethod, RentNotice } from '../api/avisering.api'

interface Props {
  notice: RentNotice | null
  onClose: () => void
  onSuccess: () => void
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'BANK', label: 'Bank' },
  { value: 'SWISH', label: 'Swish' },
  { value: 'CASH', label: 'Kontant' },
  { value: 'MANUAL', label: 'Övrigt' },
]

export function MarkPaidModal({ notice, onClose, onSuccess }: Props) {
  const [paidAmount, setPaidAmount] = useState('')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('BANK')
  const markPaid = useMarkAsPaid()

  if (!notice) return null

  const handleSubmit = async () => {
    const amount = parseFloat(paidAmount.replace(',', '.'))
    if (isNaN(amount) || amount <= 0) return
    await markPaid.mutateAsync({ id: notice.id, paidAmount: amount, paymentMethod, paidAt })
    onSuccess()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="border-line w-full max-w-sm rounded-2xl border bg-white p-6 shadow-xl"
      >
        <div className="mb-5 flex items-start justify-between">
          <h2 className="text-[17px] font-semibold text-gray-900">Markera som betald</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        <p className="mb-4 text-[13px] text-gray-500">
          Avi <span className="font-medium text-gray-700">{notice.noticeNumber}</span> — OCR:{' '}
          <span className="font-mono font-medium">{notice.ocrNumber}</span>
        </p>

        {markPaid.isError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
            <AlertCircle size={14} strokeWidth={1.8} />
            Misslyckades. Försök igen.
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Betalt belopp (SEK)
            </label>
            <input
              type="number"
              value={paidAmount}
              onChange={(e) => setPaidAmount(e.target.value)}
              placeholder={formatCurrency(Number(notice.totalAmount))}
              className="border-input h-9 w-full rounded-lg border px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Betalningssätt
            </label>
            <div className="flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setPaymentMethod(m.value)}
                  className={cn(
                    'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
                    paymentMethod === m.value
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Betalningsdatum
            </label>
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="border-input h-9 w-full rounded-lg border px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="border-line mt-5 flex justify-end gap-2 border-t pt-5">
          <Button variant="secondary" onClick={onClose} disabled={markPaid.isPending}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            loading={markPaid.isPending}
            disabled={!paidAmount || parseFloat(paidAmount) <= 0}
            onClick={() => void handleSubmit()}
          >
            <CheckCircle2 size={13} strokeWidth={1.8} />
            Bekräfta betalning
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
