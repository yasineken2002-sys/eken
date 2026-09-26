import { useState, useRef, useCallback } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { X, FileDown, Sparkles, Upload, X as XIcon, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { extractApiError } from '@/lib/api'
import {
  InspectionTypeBadge,
  InspectionStatusBadge,
  InspectionConditionBadge,
} from './InspectionBadges'
import { InspectionVersionSection } from './InspectionVersionSection'
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
  /** Byter vilken version panelen visar. Används av versionshistoriken. */
  onOppnaVersion: (id: string) => void
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

export function InspectionDetailPanel({ inspection, onClose, onOppnaVersion }: Props) {
  const updateInspection = useUpdateInspection()
  const updateItem = useUpdateInspectionItem()

  // Gränssnittet dolde tidigare bara ÅTGÄRDSKNAPPARNA när protokollet var
  // signerat — postlistan var fortfarande redigerbar, och skick och
  // reparationskostnad gick att ändra rakt i vyn. Servern nekar numera (F025);
  // fälten låses här så att beskedet kommer före anropet i stället för efter.
  const protokolletÄrLåst = inspection.status === 'SIGNED'

  // ── FEL MÅSTE SYNAS ────────────────────────────────────────────────────────
  //
  // Alla skrivningar härifrån gick via `void ...mutateAsync()` utan `.catch`.
  // För signeringen var följden att en 409 försvann. För POSTERNA var den
  // värre: nekas en `repairCost`-skrivning av statusspärren försvinner beloppet
  // tyst ur just det fält ett depositionsavdrag vilar på. Samma ruta bär båda.
  const [panelfel, setPanelfel] = useState<string | null>(null)
  const qc = useQueryClient()

  // ── SIGNERA FÅR INTE KAPPLÖPA MED EN PÅGÅENDE POSTÄNDRING ──────────────────
  //
  // `onBlur` på beloppsfältet och `click` på Signera utlöses av samma
  // musnedtryckning. Utan spärren nedan skickas `expectedContentHash` från
  // FÖRE beloppet: antingen committar poständringen först och användaren får
  // 409 av sin egen inmatning, eller så committar signeringen först och
  // beloppet nekas efteråt. Knappen väntar därför tills postskrivningen och
  // omläsningen är klara.
  const hämtarBesiktningar = useIsFetching({ queryKey: ['inspections'] }) > 0
  const väntarPåÄndring = updateItem.isPending || hämtarBesiktningar

  /** Visar felet i stället för att svälja det. */
  const kör = (p: Promise<unknown>) =>
    p.then(
      () => setPanelfel(null),
      (err: unknown) => setPanelfel(extractApiError(err)),
    )
  const downloadPdf = useDownloadPdf()
  const analyzeInspection = useAnalyzeInspection()
  // Varje köpost är ett användarVAL med en egen återförsöksnyckel (OB5). Samma
  // post som skickas igen bär samma nyckel och återanvänder bilagan servern redan
  // sparat; ett nytt val av samma fil får en ny nyckel. `sha256` räknas här så
  // att sparbeskedet kan jämföra serverns bilaga med just den här filens bytes.
  const [pendingFiles, setPendingFiles] = useState<
    Array<{
      file: File
      caption: string
      previewUrl: string
      nyckel: string
      sha256: string | null
    }>
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
        .map((f) => ({
          file: f,
          caption: '',
          previewUrl: URL.createObjectURL(f),
          nyckel: crypto.randomUUID(),
          sha256: null as string | null,
        }))
      setPendingFiles((prev) => [...prev, ...entries].slice(0, 10))
      for (const e of entries) {
        void e.file
          .arrayBuffer()
          .then((b) => crypto.subtle.digest('SHA-256', b))
          .then((d) => {
            const hex = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
            setPendingFiles((prev) =>
              prev.map((p) => (p.nyckel === e.nyckel ? { ...p, sha256: hex } : p)),
            )
          })
      }
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
    try {
      const result = await analyzeInspection.mutateAsync({
        id: inspection.id,
        files: pendingFiles.map(({ file, caption, nyckel }) =>
          caption ? { file, caption, nyckel } : { file, nyckel },
        ),
      })
      setAnalysisResult(result.analysis)
      setPendingFiles([])
    } catch {
      // Beskedet visas redan av den globala mutationstoasten (serverns text). Fångas
      // här så att ett misslyckat försök inte blir ett ohanterat löfte i sidan.
    }
  }

  // Bilagan servern redan sparat för ett val — ur den omlästa besiktningen, inte
  // ur ett HTTP-status. Analysvägen sparar bilderna före AI-anropet, så ett
  // misslyckat försök kan ha lämnat en bilaga; ett fel före lagringen lämnar ingen.
  const sparadBilaga = (nyckel: string) =>
    inspection.images.find((b) => b.storageKey.includes(`/${nyckel}/`))
  const nagonSparad = pendingFiles.some((pf) => sparadBilaga(pf.nyckel))

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
      className="border-line flex h-full w-[450px] flex-shrink-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-sm"
    >
      {/* Header */}
      <div className="border-line flex items-start justify-between border-b px-5 py-4">
        <div className="min-w-0 flex-1 pr-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <InspectionTypeBadge type={inspection.type} />
            <InspectionStatusBadge status={inspection.status} />
            {/* Versionsmärket står i HUVUDET, inte bara i historiken längre ned.
                Den som scrollar aldrig dit ska ändå se att protokollet framför
                hen är en rättad version — eller en ersatt. */}
            {inspection.version > 1 && (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[12px] font-medium text-gray-600">
                Version {inspection.version}
              </span>
            )}
            {inspection.correction !== null && (
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[12px] font-medium text-amber-700">
                Rättad
              </span>
            )}
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
            {protokolletÄrLåst && (
              <p className="mb-3 text-[12px] text-gray-500">
                Protokollet är signerat och kan inte ändras. Ett signerat protokoll är bevisunderlag
                vid en depositionstvist.
              </p>
            )}
            <div className="space-y-4">
              {Object.entries(rooms).map(([room, items]) => (
                <div key={room}>
                  <p className="mb-2 text-[13px] font-semibold text-gray-700">{room}</p>
                  <div className="border-line space-y-2 overflow-hidden rounded-xl border">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="border-line grid grid-cols-[1fr,auto] gap-2 border-b px-3 py-2.5 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-gray-800">{item.item}</p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <select
                              value={item.condition}
                              disabled={protokolletÄrLåst}
                              onChange={(e) =>
                                void kör(
                                  updateItem.mutateAsync({
                                    inspectionId: inspection.id,
                                    itemId: item.id,
                                    dto: { condition: e.target.value as InspectionItemCondition },
                                  }),
                                )
                              }
                              className="border-input h-7 rounded-md border px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
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
                                disabled={protokolletÄrLåst}
                                onBlur={(e) => {
                                  const val = e.target.value.trim()
                                  if (val !== (item.notes ?? '')) {
                                    void kör(
                                      updateItem.mutateAsync({
                                        inspectionId: inspection.id,
                                        itemId: item.id,
                                        dto: val ? { notes: val } : {},
                                      }),
                                    )
                                  }
                                }}
                                className="border-input h-7 flex-1 rounded-md border px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
                              />
                              <input
                                type="number"
                                defaultValue={item.repairCost ?? ''}
                                placeholder="kr"
                                disabled={protokolletÄrLåst}
                                onBlur={(e) => {
                                  const val = e.target.value ? parseFloat(e.target.value) : null
                                  if (val !== item.repairCost) {
                                    void kör(
                                      updateItem.mutateAsync({
                                        inspectionId: inspection.id,
                                        itemId: item.id,
                                        dto: { repairCost: val },
                                      }),
                                    )
                                  }
                                }}
                                className="border-input h-7 w-20 rounded-md border px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
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
        <div className="border-line border-t pt-4">
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
              className="border-input flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed bg-gray-50/50 px-4 py-5 text-center transition-colors hover:border-blue-400 hover:bg-blue-50/30"
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
              {pendingFiles.map((pf, i) => {
                const sparad = sparadBilaga(pf.nyckel)
                return (
                  <div key={pf.nyckel} className="border-line rounded-xl border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <img
                        src={pf.previewUrl}
                        alt=""
                        className="h-10 w-10 flex-shrink-0 rounded-lg object-cover"
                      />
                      <input
                        type="text"
                        value={sparad ? (sparad.caption ?? '') : pf.caption}
                        readOnly={Boolean(sparad)}
                        onChange={(e) =>
                          setPendingFiles((prev) =>
                            prev.map((f, idx) =>
                              idx === i ? { ...f, caption: e.target.value } : f,
                            ),
                          )
                        }
                        placeholder="Bildtext (valfri)..."
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-700 placeholder:text-gray-400 focus:outline-none"
                      />
                      <button
                        onClick={() => removeFile(i)}
                        title={
                          sparad ? 'Ta bort ur kön — bilagan finns kvar på besiktningen' : 'Ta bort'
                        }
                        className="flex-shrink-0 text-gray-400 hover:text-gray-600"
                      >
                        <XIcon size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                    {sparad && (
                      <p
                        data-testid="bild-sparad"
                        data-bild-id={sparad.id}
                        className="mt-1.5 text-[11px] text-emerald-700"
                      >
                        Sparad som bilaga · id {sparad.id.slice(0, 8)} ·{' '}
                        {pf.sha256 === null || sparad.contentSha256 === null
                          ? 'innehållet kontrolleras…'
                          : pf.sha256 === sparad.contentSha256
                            ? 'samma innehåll som din fil'
                            : 'innehållet skiljer sig från din fil'}
                      </p>
                    )}
                  </div>
                )
              })}
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
              {analyzeInspection.isPending
                ? 'Analyserar bilder...'
                : nagonSparad
                  ? 'Försök analysera igen'
                  : 'Analysera med AI'}
            </Button>
          )}

          {nagonSparad && !analyzeInspection.isPending && (
            <p className="mt-2 text-[11px] text-gray-500">
              Bilden är sparad som bilaga på besiktningen. Ett nytt försök analyserar samma bilaga —
              den laddas inte upp igen.
            </p>
          )}

          {analyzeInspection.isPending && (
            <p className="mt-2 text-center text-[11px] text-gray-400">Det kan ta 15–30 sekunder</p>
          )}

          {analysisResult && (
            <div className="mt-3 space-y-3">
              <div className="border-line rounded-xl border bg-gray-50/50 px-4 py-3">
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
                <div className="border-line flex items-center justify-between rounded-xl border px-4 py-2.5">
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
                  disabled={väntarPåÄndring}
                  onClick={() => {
                    setPanelfel(null)
                    void updateInspection
                      .mutateAsync({
                        id: inspection.id,
                        dto: {
                          status: 'SIGNED',
                          // Versionen användaren faktiskt ser. Ändrar någon
                          // annan protokollet däremellan svarar servern 409 i
                          // stället för att signera data som aldrig visats.
                          expectedContentHash: inspection.contentHash,
                        },
                      })
                      .catch((err: unknown) => setPanelfel(extractApiError(err)))
                  }}
                >
                  Signera protokoll
                </Button>
              )}
            </div>
            {panelfel && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-[12px] font-medium text-amber-900">{panelfel}</p>
                <button
                  type="button"
                  onClick={() => {
                    setPanelfel(null)
                    void qc.invalidateQueries({ queryKey: ['inspections'] })
                  }}
                  className="mt-1.5 text-[12px] font-semibold text-amber-900 underline underline-offset-2"
                >
                  Läs om protokollet
                </button>
              </div>
            )}
          </div>
        )}

        <InspectionVersionSection inspection={inspection} onOppnaVersion={onOppnaVersion} />

        {/* PDF download */}
        <div className="border-line border-t pt-4">
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
