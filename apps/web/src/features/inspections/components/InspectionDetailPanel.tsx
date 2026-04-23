import { useState, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { X, FileDown, Sparkles, Upload, X as XIcon, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  InspectionTypeBadge,
  InspectionStatusBadge,
  InspectionConditionBadge,
} from './InspectionBadges'
import {
  useUpdateInspection,
  useUpdateInspectionItem,
  useDownloadPdf,
  useAnalyzeInspection,
} from '../hooks/useInspections'
import { formatDate, formatCurrency } from '@eken/shared'
import type { Inspection, InspectionItemCondition, AnalysisResult } from '../api/inspections.api'

interface Props {
  inspection: Inspection
  onClose: () => void
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium text-gray-800">{value ?? '—'}</p>
    </div>
  )
}

const CONDITIONS: { value: InspectionItemCondition; label: string }[] = [
  { value: 'GOOD', label: 'Bra' },
  { value: 'ACCEPTABLE', label: 'Acceptabelt' },
  { value: 'DAMAGED', label: 'Skadat' },
  { value: 'MISSING', label: 'Saknas' },
]

export function InspectionDetailPanel({ inspection, onClose }: Props) {
  const updateInspection = useUpdateInspection()
  const updateItem = useUpdateInspectionItem()
  const downloadPdf = useDownloadPdf()
  const analyzeInspection = useAnalyzeInspection()
  const [pendingFiles, setPendingFiles] = useState<
    Array<{ file: File; caption: string; previewUrl: string }>
  >([])
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return
      const allowed = ['image/jpeg', 'image/png', 'image/webp']
      const entries = Array.from(fileList)
        .filter((f) => allowed.includes(f.type))
        .slice(0, 10 - pendingFiles.length)
        .map((f) => ({ file: f, caption: '', previewUrl: URL.createObjectURL(f) }))
      setPendingFiles((prev) => [...prev, ...entries].slice(0, 10))
    },
    [pendingFiles.length],
  )

  const removeFile = (i: number) => {
    setPendingFiles((prev) => {
      URL.revokeObjectURL(prev[i]!.previewUrl)
      return prev.filter((_, idx) => idx !== i)
    })
  }

  const handleAnalyze = async () => {
    const result = await analyzeInspection.mutateAsync({
      id: inspection.id,
      files: pendingFiles.map(({ file, caption }) => (caption ? { file, caption } : { file })),
    })
    setAnalysisResult(result.analysis)
    setPendingFiles([])
  }

  const tenantName = inspection.tenant
    ? inspection.tenant.type === 'INDIVIDUAL'
      ? `${inspection.tenant.firstName ?? ''} ${inspection.tenant.lastName ?? ''}`.trim()
      : (inspection.tenant.companyName ?? '')
    : null

  // Group items by room
  const rooms = inspection.items.reduce<Record<string, typeof inspection.items>>((acc, item) => {
    if (!acc[item.room]) acc[item.room] = []
    acc[item.room]!.push(item)
    return acc
  }, {})

  const damagedItems = inspection.items.filter(
    (i) => i.condition === 'DAMAGED' || i.condition === 'MISSING',
  )
  const totalRepairCost = damagedItems.reduce((sum, i) => sum + (Number(i.repairCost) || 0), 0)

  return (
    <motion.aside
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="flex h-full w-[450px] flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-[#EAEDF0] px-5 py-4">
        <div className="min-w-0 flex-1 pr-3">
          <div className="mb-1 flex items-center gap-2">
            <InspectionTypeBadge type={inspection.type} />
            <InspectionStatusBadge status={inspection.status} />
          </div>
          <h3 className="text-[15px] font-semibold leading-snug text-gray-900">
            {inspection.property.name} – {inspection.unit.unitNumber}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <InfoItem label="Fastighet" value={inspection.property.name} />
          <InfoItem
            label="Enhet"
            value={`${inspection.unit.name} (${inspection.unit.unitNumber})`}
          />
          <InfoItem label="Hyresgäst" value={tenantName ?? '—'} />
          <InfoItem label="Datum" value={formatDate(inspection.scheduledDate)} />
          {inspection.completedAt && (
            <InfoItem label="Slutförd" value={formatDate(inspection.completedAt)} />
          )}
          {inspection.overallCondition && (
            <InfoItem label="Helhetsskick" value={inspection.overallCondition} />
          )}
        </div>

        {/* Notes */}
        {inspection.notes && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Anteckningar
            </p>
            <p className="text-[13px] leading-relaxed text-gray-700">{inspection.notes}</p>
          </div>
        )}

        {/* Items per room */}
        {Object.keys(rooms).length > 0 && (
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Besiktningsprotokoll
            </p>
            <div className="space-y-4">
              {Object.entries(rooms).map(([room, items]) => (
                <div key={room}>
                  <p className="mb-2 text-[13px] font-semibold text-gray-700">{room}</p>
                  <div className="space-y-2 overflow-hidden rounded-xl border border-[#EAEDF0]">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="grid grid-cols-[1fr,auto] gap-2 border-b border-[#EAEDF0] px-3 py-2.5 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-gray-800">{item.item}</p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <select
                              value={item.condition}
                              onChange={(e) =>
                                void updateItem.mutateAsync({
                                  inspectionId: inspection.id,
                                  itemId: item.id,
                                  dto: { condition: e.target.value as InspectionItemCondition },
                                })
                              }
                              className="h-7 rounded-md border border-[#DDDFE4] px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              {CONDITIONS.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          {(item.condition === 'DAMAGED' || item.condition === 'MISSING') && (
                            <div className="mt-2 flex gap-2">
                              <input
                                type="text"
                                defaultValue={item.notes ?? ''}
                                placeholder="Anteckning..."
                                onBlur={(e) => {
                                  const val = e.target.value.trim()
                                  if (val !== (item.notes ?? '')) {
                                    void updateItem.mutateAsync({
                                      inspectionId: inspection.id,
                                      itemId: item.id,
                                      dto: val ? { notes: val } : {},
                                    })
                                  }
                                }}
                                className="h-7 flex-1 rounded-md border border-[#DDDFE4] px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                              <input
                                type="number"
                                defaultValue={item.repairCost ?? ''}
                                placeholder="kr"
                                onBlur={(e) => {
                                  const val = e.target.value ? parseFloat(e.target.value) : null
                                  if (val !== item.repairCost) {
                                    void updateItem.mutateAsync({
                                      inspectionId: inspection.id,
                                      itemId: item.id,
                                      dto: { repairCost: val },
                                    })
                                  }
                                }}
                                className="h-7 w-20 rounded-md border border-[#DDDFE4] px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </div>
                          )}
                        </div>
                        <div className="flex items-start pt-0.5">
                          <InspectionConditionBadge condition={item.condition} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Summary */}
        {damagedItems.length > 0 && (
          <div className="rounded-xl border border-red-100 bg-red-50/60 px-4 py-3">
            <p className="text-[12px] font-semibold text-red-700">
              {damagedItems.length} skada{damagedItems.length !== 1 ? 'r' : ''} noterade
            </p>
            {totalRepairCost > 0 && (
              <p className="mt-0.5 text-[12px] text-red-600">
                Beräknad kostnad: {formatCurrency(totalRepairCost)}
              </p>
            )}
          </div>
        )}

        {/* AI Analysis */}
        <div className="border-t border-[#EAEDF0] pt-4">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            <Sparkles size={11} strokeWidth={1.8} />
            AI-analys
          </p>

          {pendingFiles.length < 10 && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#DDDFE4] bg-gray-50/50 px-4 py-5 text-center transition-colors hover:border-blue-400 hover:bg-blue-50/30"
            >
              <Upload size={16} className="mb-1.5 text-gray-400" strokeWidth={1.8} />
              <p className="text-[12px] font-medium text-gray-500">
                Dra bilder hit eller klicka för att välja
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">JPG, PNG, WebP · Max 10 bilder</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div className="mt-3 space-y-2">
              {pendingFiles.map((pf, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-xl border border-[#EAEDF0] px-3 py-2"
                >
                  <img
                    src={pf.previewUrl}
                    alt=""
                    className="h-10 w-10 flex-shrink-0 rounded-lg object-cover"
                  />
                  <input
                    type="text"
                    value={pf.caption}
                    onChange={(e) =>
                      setPendingFiles((prev) =>
                        prev.map((f, idx) => (idx === i ? { ...f, caption: e.target.value } : f)),
                      )
                    }
                    placeholder="Bildtext (valfri)..."
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-700 placeholder:text-gray-400 focus:outline-none"
                  />
                  <button
                    onClick={() => removeFile(i)}
                    className="flex-shrink-0 text-gray-400 hover:text-gray-600"
                  >
                    <XIcon size={13} strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <Button
              className="mt-3 w-full"
              variant="primary"
              size="sm"
              loading={analyzeInspection.isPending}
              disabled={analyzeInspection.isPending}
              onClick={() => void handleAnalyze()}
            >
              <Sparkles size={12} strokeWidth={1.8} />
              {analyzeInspection.isPending ? 'Analyserar bilder...' : 'Analysera med AI'}
            </Button>
          )}

          {analyzeInspection.isPending && (
            <p className="mt-2 text-center text-[11px] text-gray-400">Det kan ta 15–30 sekunder</p>
          )}

          {analysisResult && (
            <div className="mt-3 space-y-3">
              <div className="rounded-xl border border-[#EAEDF0] bg-gray-50/50 px-4 py-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Helhetsskick
                </p>
                <p className="text-[13px] text-gray-700">{analysisResult.overallCondition}</p>
                {analysisResult.notes && (
                  <p className="mt-1.5 text-[12px] text-gray-500">{analysisResult.notes}</p>
                )}
              </div>

              {analysisResult.urgentIssues.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                    <AlertTriangle size={11} strokeWidth={1.8} />
                    Brådskande
                  </p>
                  <ul className="space-y-0.5">
                    {analysisResult.urgentIssues.map((issue, i) => (
                      <li key={i} className="text-[12px] text-amber-700">
                        • {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {analysisResult.estimatedTotalCost > 0 && (
                <div className="flex items-center justify-between rounded-xl border border-[#EAEDF0] px-4 py-2.5">
                  <p className="text-[12px] font-semibold text-gray-600">Beräknad totalkostnad</p>
                  <p className="text-[13px] font-bold text-red-600">
                    {formatCurrency(analysisResult.estimatedTotalCost)}
                  </p>
                </div>
              )}

              <p className="text-center text-[11px] text-emerald-600">
                Besiktningspunkterna har uppdaterats automatiskt
              </p>

              <button
                onClick={() => setAnalysisResult(null)}
                className="w-full text-[11px] text-gray-400 transition-colors hover:text-gray-600"
              >
                Stäng resultat
              </button>
            </div>
          )}
        </div>

        {/* Status actions */}
        {(inspection.status === 'SCHEDULED' ||
          inspection.status === 'IN_PROGRESS' ||
          inspection.status === 'COMPLETED') && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Åtgärder
            </p>
            <div className="flex flex-wrap gap-2">
              {inspection.status === 'SCHEDULED' && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={updateInspection.isPending}
                  onClick={() =>
                    void updateInspection.mutateAsync({
                      id: inspection.id,
                      dto: { status: 'IN_PROGRESS' },
                    })
                  }
                >
                  Påbörja besiktning
                </Button>
              )}
              {inspection.status === 'IN_PROGRESS' && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={updateInspection.isPending}
                  onClick={() =>
                    void updateInspection.mutateAsync({
                      id: inspection.id,
                      dto: { status: 'COMPLETED' },
                    })
                  }
                >
                  Slutför besiktning
                </Button>
              )}
              {inspection.status === 'COMPLETED' && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={updateInspection.isPending}
                  onClick={() =>
                    void updateInspection.mutateAsync({
                      id: inspection.id,
                      dto: { status: 'SIGNED', signedAt: new Date().toISOString() },
                    })
                  }
                >
                  Signera protokoll
                </Button>
              )}
            </div>
          </div>
        )}

        {/* PDF download */}
        <div className="border-t border-[#EAEDF0] pt-4">
          <Button
            variant="secondary"
            size="sm"
            loading={downloadPdf.isPending}
            onClick={() => void downloadPdf.mutateAsync(inspection.id)}
          >
            <FileDown size={13} strokeWidth={1.8} />
            Ladda ned protokoll
          </Button>
        </div>
      </div>
    </motion.aside>
  )
}
