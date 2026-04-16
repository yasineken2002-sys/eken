import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Zap } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Select, Input } from '@/components/ui/Input'
import { useCreateBulkInvoices } from '../hooks/useInvoiceQueries'
import { useLeases } from '@/features/leases/hooks/useLeases'
import type { BulkInvoiceResult } from '../api/invoices.api'

const MONTH_NAMES = [
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

const VAT_OPTIONS = [
  { value: '0', label: '0%' },
  { value: '6', label: '6%' },
  { value: '12', label: '12%' },
  { value: '25', label: '25%' },
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function calcDates(month: number, year: number): { issueDate: string; dueDate: string } {
  const issueDate = `${year}-${pad2(month)}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const dueDate = `${year}-${pad2(month)}-${pad2(lastDay)}`
  return { issueDate, dueDate }
}

function autoDescription(month: number, year: number): string {
  const d = new Date(year, month - 1, 1)
  return d
    .toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/^/, 'Hyra ')
}

interface Props {
  open: boolean
  onClose: () => void
}

type ViewState = 'form' | 'result'

export function BulkInvoiceModal({ open, onClose }: Props) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [description, setDescription] = useState('')
  const [descriptionEdited, setDescriptionEdited] = useState(false)
  const [vatRate, setVatRate] = useState('0')
  const [sendEmail, setSendEmail] = useState(false)
  const [view, setView] = useState<ViewState>('form')
  const [result, setResult] = useState<BulkInvoiceResult | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)

  const { data: allLeases = [] } = useLeases()
  const activeLeaseCount = allLeases.filter((l) => l.status === 'ACTIVE').length

  const bulkMutation = useCreateBulkInvoices()

  // Auto-fill description when month/year changes (unless user has edited it)
  useEffect(() => {
    if (!descriptionEdited) {
      setDescription(autoDescription(month, year))
    }
  }, [month, year, descriptionEdited])

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setView('form')
      setResult(null)
      setApiError(null)
      setShowErrors(false)
      setDescriptionEdited(false)
      setDescription(autoDescription(month, year))
    }
  }, [open])

  const { issueDate, dueDate } = calcDates(month, year)

  const currentYear = now.getFullYear()
  const yearOptions = [
    { value: String(currentYear), label: String(currentYear) },
    { value: String(currentYear + 1), label: String(currentYear + 1) },
  ]

  const monthOptions = MONTH_NAMES.map((label, i) => ({
    value: String(i + 1),
    label,
  }))

  async function handleSubmit() {
    setApiError(null)
    try {
      const res = await bulkMutation.mutateAsync({
        issueDate,
        dueDate,
        ...(description ? { description } : {}),
        vatRate: Number(vatRate),
        sendEmail,
      })
      setResult(res)
      setView('result')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Något gick fel'
      setApiError(msg)
    }
  }

  function handleClose() {
    setView('form')
    setResult(null)
    setApiError(null)
    onClose()
  }

  const isLoading = bulkMutation.isPending

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Skapa hyresfakturor"
      description="Skapar fakturor för alla aktiva kontrakt"
      size="sm"
    >
      {view === 'form' ? (
        <div className="space-y-5">
          {/* Fakturamånad */}
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Fakturamånad</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <Select
                  options={monthOptions}
                  value={String(month)}
                  onChange={(e) => setMonth(Number(e.target.value))}
                />
              </div>
              <div className="w-28">
                <Select
                  options={yearOptions}
                  value={String(year)}
                  onChange={(e) => setYear(Number(e.target.value))}
                />
              </div>
            </div>
            <p className="mt-1.5 text-[12px] text-gray-400">
              Utfärdas: {issueDate} · Förfaller: {dueDate}
            </p>
          </div>

          {/* Beskrivning */}
          <Input
            label="Beskrivning (valfritt)"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setDescriptionEdited(true)
            }}
            placeholder={autoDescription(month, year)}
          />

          {/* Moms */}
          <Select
            label="Moms"
            options={VAT_OPTIONS}
            value={vatRate}
            onChange={(e) => setVatRate(e.target.value)}
          />

          {/* Skicka e-post */}
          <label className="flex cursor-pointer items-center gap-3">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
              />
              <div
                className={`h-5 w-9 rounded-full transition-colors ${
                  sendEmail ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              />
              <div
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  sendEmail ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </div>
            <span className="text-[13px] text-gray-700">
              Skicka faktura via e-post till hyresgäster
            </span>
          </label>

          {/* Förhandsgranskning */}
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Förhandsgranskning
            </p>
            <p className="mt-1.5 text-[13.5px] font-medium text-gray-800">
              Skapar {activeLeaseCount} fakturor
            </p>
            <p className="text-[13px] text-gray-500">
              Period:{' '}
              {new Date(issueDate).toLocaleDateString('sv-SE', {
                month: 'long',
                year: 'numeric',
              })}
            </p>
            <p className="text-[13px] text-gray-500">Förfallodatum: {dueDate}</p>
            {sendEmail && (
              <p className="text-[13px] text-blue-600">
                E-post skickas till {activeLeaseCount} hyresgäster
              </p>
            )}
          </div>

          {apiError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-600">{apiError}</p>
          )}

          <ModalFooter>
            <Button onClick={handleClose} disabled={isLoading}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSubmit()}
              loading={isLoading}
              disabled={activeLeaseCount === 0}
            >
              <Zap size={13} strokeWidth={2.2} />
              {isLoading ? 'Skapar fakturor…' : `Skapa ${activeLeaseCount} fakturor`}
            </Button>
          </ModalFooter>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
          className="space-y-5 py-2"
        >
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 size={48} className="text-emerald-500" strokeWidth={1.5} />
            <p className="text-[17px] font-semibold text-gray-900">Fakturor skapade!</p>
          </div>

          <div className="space-y-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <div className="flex items-center gap-2 text-[13.5px]">
              <CheckCircle2 size={14} className="text-emerald-600" strokeWidth={2} />
              <span className="font-medium text-gray-800">{result?.created} fakturor skapade</span>
            </div>
            {(result?.skipped ?? 0) > 0 && (
              <div className="flex items-center gap-2 text-[13px] text-gray-500">
                <span className="ml-0.5 text-gray-400">→</span>
                <span>{result?.skipped} hoppades över (dubbletter eller saknat e-post)</span>
              </div>
            )}
            {(result?.errors.length ?? 0) > 0 && (
              <div className="space-y-1">
                <button
                  onClick={() => setShowErrors((v) => !v)}
                  className="flex items-center gap-1.5 text-[13px] text-amber-700"
                >
                  <AlertTriangle size={13} strokeWidth={2} />
                  {result?.errors.length} fel
                  {showErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                {showErrors && (
                  <ul className="ml-5 space-y-0.5">
                    {result?.errors.map((e, i) => (
                      <li key={i} className="text-[12px] text-gray-500">
                        {e}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <ModalFooter>
            <Button variant="primary" onClick={handleClose}>
              Stäng
            </Button>
          </ModalFooter>
        </motion.div>
      )}
    </Modal>
  )
}
