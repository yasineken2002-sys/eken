import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useMarkAsPaid } from '../hooks/useAvisering'
import type { RentNotice } from '../api/avisering.api'

interface Props {
  notice: RentNotice | null
  onClose: () => void
  onSuccess: () => void
}

export function MarkPaidModal({ notice, onClose, onSuccess }: Props) {
  const [paidAmount, setPaidAmount] = useState('')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const markPaid = useMarkAsPaid()

  if (!notice) return null

  const handleSubmit = async () => {
    const amount = parseFloat(paidAmount.replace(',', '.'))
    if (isNaN(amount) || amount <= 0) return
    await markPaid.mutateAsync({ id: notice.id, paidAmount: amount, paidAt })
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
        className="w-full max-w-sm rounded-2xl border border-[#EAEDF0] bg-white p-6 shadow-xl"
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
              placeholder={String(Number(notice.totalAmount))}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Betalningsdatum
            </label>
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-[#EAEDF0] pt-5">
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
