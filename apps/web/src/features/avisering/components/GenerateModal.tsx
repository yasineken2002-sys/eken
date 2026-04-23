import { motion } from 'framer-motion'
import { X, Sparkles, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useGenerateNotices } from '../hooks/useAvisering'

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
  const generate = useGenerateNotices()

  if (!open) return null

  const handleGenerate = async () => {
    const result = await generate.mutateAsync({ month, year })
    onSuccess(result.created)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="w-full max-w-md rounded-2xl border border-[#EAEDF0] bg-white p-6 shadow-xl"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-[17px] font-semibold text-gray-900">Generera hyresavier</h2>
            <p className="mt-0.5 text-[13px] text-gray-500">
              {MONTHS[month - 1]} {year}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {generate.isError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
            <AlertCircle size={14} strokeWidth={1.8} />
            Generering misslyckades. Försök igen.
          </div>
        )}

        <div className="mb-5 rounded-xl border border-[#EAEDF0] bg-gray-50 px-4 py-3 text-[13px] text-gray-600">
          <p>
            Avier genereras för alla <strong>aktiva hyreskontrakt</strong>.
          </p>
          <p className="mt-1">
            Förfallodatum sätts till <strong>25:e {MONTHS[month - 1]}</strong>.
          </p>
          <p className="mt-1">Avier som redan finns för perioden hoppas över.</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#EAEDF0] pt-5">
          <Button variant="secondary" onClick={onClose} disabled={generate.isPending}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            loading={generate.isPending}
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
