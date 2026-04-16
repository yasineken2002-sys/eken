import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload,
  FileSpreadsheet,
  Scan,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Download,
  Building2,
  Home,
  Users,
  FileText,
  Loader2,
  ArrowRight,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/cn'
import {
  useImportJobs,
  usePreviewImport,
  useExecuteImport,
  useScanContract,
} from './hooks/useImport'
import { downloadTemplate } from './api/import.api'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { formatDate } from '@eken/shared'
import type { PreviewResult, ImportJob, ScannedContract } from './api/import.api'

// ─── Import Types ─────────────────────────────────────────────────────────────

const IMPORT_TABS: { id: string; label: string; icon: React.ElementType }[] = [
  { id: 'PROPERTIES', label: 'Fastigheter', icon: Building2 },
  { id: 'UNITS', label: 'Enheter', icon: Home },
  { id: 'TENANTS', label: 'Hyresgäster', icon: Users },
  { id: 'LEASES', label: 'Kontrakt', icon: FileText },
]

const TYPE_LABELS: Record<string, string> = {
  PROPERTIES: 'fastigheter',
  UNITS: 'enheter',
  TENANTS: 'hyresgäster',
  LEASES: 'kontrakt',
}

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Klar',
  FAILED: 'Misslyckades',
  PROCESSING: 'Bearbetar',
  PENDING: 'Väntar',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DropZoneProps {
  accept: string
  onFile: (file: File) => void
  disabled?: boolean
  hint?: string
}

function DropZone({ accept, onFile, disabled, hint }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) onFile(file)
    },
    [onFile],
  )

  return (
    <div
      className={cn(
        'relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors',
        dragging
          ? 'border-blue-400 bg-blue-50'
          : 'border-[#E5E7EB] bg-gray-50/50 hover:border-blue-300 hover:bg-blue-50/30',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
      <Upload size={22} className="mb-3 text-gray-400" strokeWidth={1.5} />
      <p className="text-[13.5px] font-medium text-gray-700">
        Dra och släpp hit, eller klicka för att välja
      </p>
      {hint && <p className="mt-1 text-[12px] text-gray-400">{hint}</p>}
    </div>
  )
}

// ─── Preview Table ────────────────────────────────────────────────────────────

function PreviewTable({ preview }: { preview: Record<string, string>[] }) {
  if (preview.length === 0) return null
  const headers = Object.keys(preview[0] ?? {})

  return (
    <div className="overflow-auto rounded-xl border border-gray-100">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            {headers.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-3 py-2 text-left font-semibold uppercase tracking-wide text-gray-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/80">
              {headers.map((h) => (
                <td key={h} className="whitespace-nowrap px-3 py-2 text-gray-700">
                  {row[h] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Import Panel (per type tab) ──────────────────────────────────────────────

type PanelState = 'idle' | 'previewing' | 'preview-done' | 'importing' | 'done'

function ImportPanel({ type }: { type: string }) {
  const [state, setState] = useState<PanelState>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [job, setJob] = useState<ImportJob | null>(null)
  const [showAllErrors, setShowAllErrors] = useState(false)

  const { mutateAsync: previewMutate } = usePreviewImport()
  const { mutateAsync: executeMutate } = useExecuteImport()

  const handleFile = async (f: File) => {
    setFile(f)
    setPreview(null)
    setJob(null)
    setState('previewing')
    try {
      const result = await previewMutate({ file: f, type })
      setPreview(result)
      setState('preview-done')
    } catch {
      setState('idle')
    }
  }

  const handleExecute = async () => {
    if (!file) return
    setState('importing')
    try {
      const result = await executeMutate({ file, type })
      setJob(result)
      setState('done')
    } catch {
      setState('preview-done')
    }
  }

  const handleReset = () => {
    setFile(null)
    setPreview(null)
    setJob(null)
    setState('idle')
    setShowAllErrors(false)
  }

  const visibleErrors = preview?.errors
    ? showAllErrors
      ? preview.errors
      : preview.errors.slice(0, 5)
    : []

  return (
    <div className="space-y-4">
      {/* Template download */}
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-gray-500">Ladda ner mallen och fyll i dina uppgifter.</p>
        <Button variant="secondary" size="sm" onClick={() => downloadTemplate(type)}>
          <Download size={13} className="mr-1.5" />
          Ladda ner mall
        </Button>
      </div>

      {/* Dropzone */}
      {(state === 'idle' || state === 'done') && state !== 'done' && (
        <DropZone
          accept=".csv,.xlsx,.xls"
          onFile={handleFile}
          hint="CSV, XLSX eller XLS · max 10 MB"
        />
      )}

      {/* Previewing */}
      {state === 'previewing' && (
        <div className="flex h-24 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
          <Loader2 size={18} className="animate-spin text-blue-500" />
          <span className="ml-2 text-[13px] text-gray-500">Analyserar fil...</span>
        </div>
      )}

      {/* Preview result */}
      {state === 'preview-done' && preview && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Stats row */}
          <div className="flex items-center gap-3">
            {preview.validRows > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1">
                <CheckCircle2 size={13} className="text-emerald-600" />
                <span className="text-[12.5px] font-medium text-emerald-700">
                  {preview.validRows} rader redo
                </span>
              </div>
            )}
            {preview.errorRows > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1">
                <XCircle size={13} className="text-red-500" />
                <span className="text-[12.5px] font-medium text-red-600">
                  {preview.errorRows} rader har fel
                </span>
              </div>
            )}
            <span className="ml-auto text-[12px] text-gray-400">{preview.filename}</span>
          </div>

          {/* Preview table */}
          {preview.preview.length > 0 && <PreviewTable preview={preview.preview} />}

          {/* Errors */}
          {preview.errors.length > 0 && (
            <div className="rounded-xl border border-red-100 bg-red-50/50 p-3">
              <p className="mb-2 text-[12.5px] font-semibold text-red-700">
                Radfel ({preview.errors.length})
              </p>
              <ul className="space-y-1">
                {visibleErrors.map((err) => (
                  <li key={err.row} className="flex gap-2 text-[12px] text-red-600">
                    <span className="font-medium">Rad {err.row}:</span>
                    <span>{err.message}</span>
                  </li>
                ))}
              </ul>
              {preview.errors.length > 5 && (
                <button
                  className="mt-2 flex items-center gap-1 text-[12px] font-medium text-red-500 hover:text-red-700"
                  onClick={() => setShowAllErrors(!showAllErrors)}
                >
                  {showAllErrors ? (
                    <>
                      <ChevronUp size={12} /> Dölj fel
                    </>
                  ) : (
                    <>
                      <ChevronDown size={12} /> Visa alla {preview.errors.length} fel
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleReset}>
              Ny fil
            </Button>
            {preview.validRows > 0 && (
              <Button variant="primary" size="sm" onClick={handleExecute}>
                Importera {preview.validRows} rader
                <ArrowRight size={13} className="ml-1.5" />
              </Button>
            )}
          </div>
        </motion.div>
      )}

      {/* Importing */}
      {state === 'importing' && (
        <div className="flex h-24 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
          <Loader2 size={18} className="animate-spin text-blue-500" />
          <span className="ml-2 text-[13px] text-gray-500">Importerar...</span>
        </div>
      )}

      {/* Done */}
      {state === 'done' && job && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-gray-100 bg-white p-5"
        >
          <div className="mb-4 flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <span className="text-[14px] font-semibold text-gray-800">Import klar</span>
          </div>
          <div className="flex gap-4">
            <div className="text-center">
              <div className="text-[22px] font-semibold text-emerald-600">{job.successRows}</div>
              <div className="text-[12px] text-gray-500">importerades</div>
            </div>
            {job.errorRows > 0 && (
              <div className="text-center">
                <div className="text-[22px] font-semibold text-amber-600">{job.errorRows}</div>
                <div className="text-[12px] text-gray-500">hoppades över</div>
              </div>
            )}
          </div>
          <div className="mt-4">
            <Button variant="secondary" size="sm" onClick={handleReset}>
              Importera mer
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}

// ─── Contract Scanner Panel ───────────────────────────────────────────────────

type ScanState = 'idle' | 'scanning' | 'done'

function ContractScannerPanel() {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [, setContract] = useState<ScannedContract | null>(null)
  const [edited, setEdited] = useState<ScannedContract | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null)
  const { mutateAsync: scan } = useScanContract()

  const handleFile = async (file: File) => {
    setScanState('scanning')
    setContract(null)
    setEdited(null)
    setSaveResult(null)
    try {
      const result = await scan(file)
      setContract(result)
      setEdited(result)
      setScanState('done')
    } catch {
      setScanState('idle')
    }
  }

  const handleReset = () => {
    setScanState('idle')
    setContract(null)
    setEdited(null)
    setSaveResult(null)
  }

  const handleSave = async () => {
    if (!edited) return
    setSaving(true)
    setSaveResult(null)
    try {
      const tenantPayload: Record<string, unknown> = {
        type: edited.tenantType ?? 'INDIVIDUAL',
        email: edited.tenantEmail ?? '',
        phone: edited.tenantPhone ?? undefined,
      }

      if (edited.tenantType === 'COMPANY') {
        tenantPayload['companyName'] = edited.companyName ?? ''
        tenantPayload['orgNumber'] = edited.orgNumber ?? undefined
      } else {
        const nameParts = (edited.tenantName ?? '').trim().split(' ')
        tenantPayload['firstName'] = nameParts.slice(0, -1).join(' ') || nameParts[0] || ''
        tenantPayload['lastName'] =
          nameParts.length > 1 ? (nameParts[nameParts.length - 1] ?? '') : ''
        tenantPayload['personalNumber'] = edited.personalNumber ?? undefined
      }

      const token = useAuthStore.getState().accessToken
      await api.post('/tenants', tenantPayload, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      setSaveResult('success')
    } catch {
      setSaveResult('error')
    } finally {
      setSaving(false)
    }
  }

  const confidenceColor = !edited
    ? ''
    : edited.confidence >= 0.8
      ? 'bg-emerald-50 text-emerald-700'
      : edited.confidence >= 0.5
        ? 'bg-amber-50 text-amber-700'
        : 'bg-red-50 text-red-600'

  const confidenceLabel = !edited
    ? ''
    : edited.confidence >= 0.8
      ? 'Hög säkerhet'
      : edited.confidence >= 0.5
        ? 'Medel säkerhet'
        : 'Låg säkerhet'

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-500">
        Ladda upp ett hyreskontrakt — AI:n läser av informationen automatiskt.
      </p>

      {scanState === 'idle' && (
        <DropZone
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          onFile={handleFile}
          hint="PDF, JPG, PNG eller WEBP · max 10 MB"
        />
      )}

      {scanState === 'scanning' && (
        <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="text-[13px] text-gray-500">Analyserar kontrakt...</span>
        </div>
      )}

      {scanState === 'done' && edited && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Confidence badge */}
          <div className="flex items-center justify-between">
            <span
              className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-medium', confidenceColor)}
            >
              {confidenceLabel}
            </span>
            <button
              className="text-[12px] text-gray-400 underline hover:text-gray-600"
              onClick={handleReset}
            >
              Skanna nytt
            </button>
          </div>

          {/* Hyresgäst section */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Hyresgäst
            </p>
            <div className="space-y-3">
              {/* Type toggle */}
              <div className="flex w-fit gap-1 rounded-lg bg-gray-100 p-1">
                {(['INDIVIDUAL', 'COMPANY'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setEdited({ ...edited, tenantType: t })}
                    className={cn(
                      'h-7 rounded-md px-3 text-[12.5px] font-medium transition-colors',
                      edited.tenantType === t
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700',
                    )}
                  >
                    {t === 'INDIVIDUAL' ? 'Privatperson' : 'Företag'}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3">
                {edited.tenantType === 'COMPANY' ? (
                  <>
                    <ScanField
                      label="Företagsnamn"
                      value={edited.companyName}
                      onChange={(v) => setEdited({ ...edited, companyName: v || null })}
                    />
                    <ScanField
                      label="Org.nummer"
                      value={edited.orgNumber}
                      onChange={(v) => setEdited({ ...edited, orgNumber: v || null })}
                    />
                  </>
                ) : (
                  <>
                    <ScanField
                      label="Namn"
                      value={edited.tenantName}
                      onChange={(v) => setEdited({ ...edited, tenantName: v || null })}
                    />
                    <ScanField
                      label="Personnummer"
                      value={edited.personalNumber}
                      onChange={(v) => setEdited({ ...edited, personalNumber: v || null })}
                    />
                  </>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <ScanField
                    label="E-post"
                    value={edited.tenantEmail}
                    onChange={(v) => setEdited({ ...edited, tenantEmail: v || null })}
                  />
                  <ScanField
                    label="Telefon"
                    value={edited.tenantPhone}
                    onChange={(v) => setEdited({ ...edited, tenantPhone: v || null })}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Contract section */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Kontrakt
            </p>
            <div className="grid grid-cols-2 gap-3">
              <ScanField
                label="Adress"
                value={edited.propertyAddress}
                onChange={(v) => setEdited({ ...edited, propertyAddress: v || null })}
              />
              <ScanField
                label="Enhet"
                value={edited.unitDescription}
                onChange={(v) => setEdited({ ...edited, unitDescription: v || null })}
              />
              <ScanField
                label="Startdatum"
                value={edited.startDate}
                onChange={(v) => setEdited({ ...edited, startDate: v || null })}
              />
              <ScanField
                label="Slutdatum"
                value={edited.endDate}
                onChange={(v) => setEdited({ ...edited, endDate: v || null })}
              />
              <ScanField
                label="Månadshyra (kr)"
                value={edited.monthlyRent != null ? String(edited.monthlyRent) : null}
                onChange={(v) =>
                  setEdited({ ...edited, monthlyRent: v ? parseFloat(v) || null : null })
                }
              />
              <ScanField
                label="Deposition (kr)"
                value={edited.depositAmount != null ? String(edited.depositAmount) : null}
                onChange={(v) =>
                  setEdited({ ...edited, depositAmount: v ? parseFloat(v) || null : null })
                }
              />
            </div>
          </div>

          {/* Save result */}
          <AnimatePresence>
            {saveResult === 'success' && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700"
              >
                <CheckCircle2 size={14} />
                Hyresgästen sparades
              </motion.div>
            )}
            {saveResult === 'error' && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-600"
              >
                <AlertCircle size={14} />
                Något gick fel. Kontrollera uppgifterna.
              </motion.div>
            )}
          </AnimatePresence>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleReset}>
              Skanna nytt
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || !edited.tenantEmail}
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="mr-1.5 animate-spin" />
                  Sparar...
                </>
              ) : (
                <>
                  Spara hyresgäst & kontrakt
                  <ArrowRight size={13} className="ml-1.5" />
                </>
              )}
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}

// ─── ScanField ────────────────────────────────────────────────────────────────

function ScanField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string | null | undefined
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-gray-500">{label}</label>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Hittades inte"
        className={cn(
          'h-8 w-full rounded-lg border px-2.5 text-[13px] outline-none transition-colors',
          'focus:border-blue-500 focus:ring-2 focus:ring-blue-500',
          !value
            ? 'border-[#E5E7EB] bg-gray-50 text-gray-400 placeholder:text-gray-300'
            : 'border-[#E5E7EB] bg-white text-gray-800',
        )}
      />
    </div>
  )
}

// ─── History Table ────────────────────────────────────────────────────────────

function ImportHistory({ jobs }: { jobs: ImportJob[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-gray-100">
            {['Datum', 'Typ', 'Fil', 'Totalt', 'Lyckades', 'Fel', 'Status'].map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-[13px] text-gray-400">
                Inga importer än
              </td>
            </tr>
          )}
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/80">
              <td className="px-4 py-3 text-gray-600">{formatDate(job.createdAt)}</td>
              <td className="px-4 py-3 text-gray-700">{TYPE_LABELS[job.type] ?? job.type}</td>
              <td className="max-w-[160px] truncate px-4 py-3 text-gray-500">{job.filename}</td>
              <td className="px-4 py-3 text-gray-700">{job.totalRows}</td>
              <td className="px-4 py-3 font-medium text-emerald-700">{job.successRows}</td>
              <td className="px-4 py-3 font-medium text-red-600">{job.errorRows}</td>
              <td className="px-4 py-3">
                <Badge
                  variant={
                    job.status === 'COMPLETED'
                      ? 'success'
                      : job.status === 'FAILED'
                        ? 'danger'
                        : job.status === 'PROCESSING'
                          ? 'info'
                          : 'default'
                  }
                >
                  {STATUS_LABELS[job.status] ?? job.status}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function ImportPage() {
  const [activeTab, setActiveTab] = useState<string>('PROPERTIES')
  const { data: jobs = [] } = useImportJobs()

  return (
    <PageWrapper id="import">
      <PageHeader
        title="Importera data"
        description="Migrera din data från Excel, CSV eller gamla system"
      />

      <div className="mt-6">
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 gap-6 lg:grid-cols-5"
        >
          {/* LEFT — Excel/CSV Import */}
          <motion.div variants={item} className="lg:col-span-3">
            <div className="rounded-2xl border border-gray-100 bg-white p-5">
              <div className="mb-5 flex items-center gap-2">
                <FileSpreadsheet size={16} className="text-blue-600" strokeWidth={1.8} />
                <h2 className="text-[15px] font-semibold text-gray-900">
                  Importera från Excel eller CSV
                </h2>
              </div>

              {/* Tabs */}
              <div className="mb-5 flex gap-1 rounded-xl bg-gray-100/70 p-1">
                {IMPORT_TABS.map((tab) => {
                  const Icon = tab.icon
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors',
                        activeTab === tab.id
                          ? 'bg-white text-gray-900 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700',
                      )}
                    >
                      <Icon size={12} strokeWidth={1.8} />
                      {tab.label}
                    </button>
                  )
                })}
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                >
                  <ImportPanel type={activeTab} />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>

          {/* RIGHT — AI Scanner */}
          <motion.div variants={item} className="lg:col-span-2">
            <div className="rounded-2xl border border-gray-100 bg-white p-5">
              <div className="mb-4 flex items-center gap-2">
                <Scan size={16} className="text-purple-600" strokeWidth={1.8} />
                <h2 className="text-[15px] font-semibold text-gray-900">Skanna kontrakt med AI</h2>
              </div>
              <ContractScannerPanel />
            </div>
          </motion.div>
        </motion.div>

        {/* Import History */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mt-6"
        >
          <h2 className="mb-3 text-[14px] font-semibold text-gray-900">Importhistorik</h2>
          <ImportHistory jobs={jobs} />
        </motion.div>
      </div>
    </PageWrapper>
  )
}
