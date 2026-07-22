import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  AlertTriangle,
  FileText,
  Lock,
  Download,
  RefreshCw,
  Paperclip,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  fetchContractStatus,
  fetchAppendices,
  generateLeaseContract,
  downloadLeaseContract,
  updateAppendix,
  type AppendixCategory,
  type AppendixItem,
  type ContractDocument,
} from '../api/leases.api'

interface Props {
  leaseId: string
}

const CONTRACT_KEY = (id: string) => ['contract', 'status', id] as const

function formatDateTime(value: string): string {
  const d = new Date(value)
  return `${d.toLocaleDateString('sv-SE')} kl. ${d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`
}

function signedByLabel(doc: ContractDocument): string {
  const t = doc.signedByTenant
  if (!t) return 'okänd hyresgäst'
  const name = [t.firstName, t.lastName].filter(Boolean).join(' ').trim()
  return name || t.companyName || 'okänd hyresgäst'
}

/**
 * Lättviktig User-Agent-formatter som plockar ut webbläsare + OS från
 * en rå UA-sträng utan ny dependency. Vi matchar bara de vanligaste
 * familjerna; för udda strängar faller vi tillbaka till råversionen.
 */
function formatUserAgent(ua: string): string {
  const browserMatch =
    ua.match(/(Edg|Chrome|Firefox|Safari)\/([0-9]+)/) ?? ([] as RegExpMatchArray | string[])
  const browserName = browserMatch[1] === 'Edg' ? 'Edge' : browserMatch[1]
  const browserVersion = browserMatch[2]

  let os = ''
  if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/iPhone OS|iPad/.test(ua)) os = 'iOS'
  else if (/Mac OS X/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Linux/.test(ua)) os = 'Linux'

  if (browserName && browserVersion && os) return `${browserName} ${browserVersion} på ${os}`
  if (browserName && browserVersion) return `${browserName} ${browserVersion}`
  if (os) return os
  return ua.length > 80 ? `${ua.slice(0, 77)}…` : ua
}

export function ContractTab({ leaseId }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: CONTRACT_KEY(leaseId),
    queryFn: () => fetchContractStatus(leaseId),
  })

  const regenerate = useMutation({
    mutationFn: () => generateLeaseContract(leaseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONTRACT_KEY(leaseId) }),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-[13px] text-gray-500">
        Hämtar kontraktsstatus…
      </div>
    )
  }

  if (!data?.hasPdf) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/60 p-4 text-[13px] text-amber-900">
          <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">Inget kontrakt har genererats än</p>
            <p className="mt-0.5 text-amber-700/80">
              När kontraktet aktiveras genereras en PDF automatiskt och skickas till hyresgästen för
              signering. Du kan även generera den manuellt nu.
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          loading={regenerate.isPending}
          onClick={() => regenerate.mutate()}
        >
          <FileText size={14} className="mr-1.5" strokeWidth={1.8} />
          Generera kontrakts-PDF
        </Button>
      </div>
    )
  }

  const latest = data.latest!
  const versions = data.versions

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-5"
    >
      {/* Status-banner */}
      {latest.locked && latest.signedAt ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-4 text-[13px] text-emerald-900">
          <CheckCircle2 size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-emerald-600" />
          <div>
            <p className="font-medium">Kontraktet är digitalt signerat</p>
            <p className="mt-0.5 text-emerald-700/80">
              Signerat av <strong>{signedByLabel(latest)}</strong> {formatDateTime(latest.signedAt)}
              {latest.signedFromIp ? ` från IP ${latest.signedFromIp}` : ''}.
            </p>
            {latest.signatureName && (
              <p className="mt-0.5 text-emerald-700/80">
                Skriven underskrift: <strong>{latest.signatureName}</strong>
              </p>
            )}
            {latest.signedUserAgent && (
              <p className="mt-0.5 text-emerald-700/80">
                Enhet: {formatUserAgent(latest.signedUserAgent)}
              </p>
            )}
            {latest.contentHash && (
              <p className="mt-1 break-all font-mono text-[10.5px] text-emerald-700/70">
                SHA-256: {latest.contentHash}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-[13px] text-blue-900">
          <FileText size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-blue-600" />
          <div>
            <p className="font-medium">Kontrakt genererat — väntar på signering</p>
            <p className="mt-0.5 text-blue-700/80">
              När hyresgästen aktiverar kontot via portallänken signeras PDF:en digitalt och låses
              automatiskt med en SHA-256-hash.
            </p>
          </div>
        </div>
      )}

      {data.staleSinceSigning && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/60 p-4 text-[13px] text-amber-900">
          <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">Kontraktet har ändrats efter signering</p>
            <p className="mt-0.5 text-amber-700/80">
              Generera en ny version för att låsa de uppdaterade villkoren — den föregående
              versionen behålls för spårbarhet.
            </p>
          </div>
        </div>
      )}

      {/* Senaste version */}
      <div className="border-line rounded-2xl border bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-gray-900">{latest.name}</p>
            <p className="mt-0.5 text-[12px] text-gray-500">
              Skapat {formatDateTime(latest.createdAt)} · {versions.length} version
              {versions.length === 1 ? '' : 'er'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {latest.locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                <Lock size={10} strokeWidth={2.2} /> Låst
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => void downloadLeaseContract(leaseId)}>
            <Download size={13} strokeWidth={1.8} className="mr-1.5" />
            Ladda ner senaste
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={regenerate.isPending}
            onClick={() => regenerate.mutate()}
          >
            <RefreshCw size={13} strokeWidth={1.8} className="mr-1.5" />
            Generera ny version
          </Button>
        </div>
      </div>

      {/* Versionshistorik */}
      <AppendicesSection leaseId={leaseId} />

      {versions.length > 1 && (
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Versionshistorik
          </p>
          <ul className="space-y-2">
            {versions.map((v, i) => (
              <li
                key={v.id}
                className="border-line flex items-start justify-between gap-3 rounded-xl border bg-white px-3.5 py-2.5 text-[13px]"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">
                    Version {versions.length - i}
                    {i === 0 ? ' · Senaste' : ''}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-gray-500">
                    {formatDateTime(v.createdAt)}
                    {v.signedAt ? ` · signerad ${formatDateTime(v.signedAt)}` : ' · ej signerad'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {v.locked && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                      <Lock size={9} strokeWidth={2.2} /> Låst
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  )
}

// ─── Bilagor / appendices ──────────────────────────────────────────────────
// Listar alla dokument som är länkade till leasen (förutom själva
// kontrakts-PDF:en) och låter hyresvärden välja vilka som ska bifogas
// kontraktet samt klassificera typ. Filuppladdning sker via separata
// dokumentvyn — den här sektionen är ren konfiguration.

const APPENDIX_KEY = (id: string) => ['contract', 'appendices', id] as const

const APPENDIX_CATEGORY_LABEL: Record<string, string> = {
  ENERGY_DECLARATION: 'Energideklaration',
  HOUSE_RULES: 'Ordningsregler',
  INSPECTION_PROTOCOL: 'Tillträdesbesiktning',
  OTHER: 'Övrig bilaga',
  INSPECTION: 'Tillträdesbesiktning',
  INSURANCE: 'Försäkringsbevis',
  DRAWING: 'Ritning',
  PHOTO: 'Foto',
  INVOICE: 'Faktura',
  CONTRACT: 'Kontrakt',
}

function formatAppendixSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function AppendicesSection({ leaseId }: { leaseId: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: APPENDIX_KEY(leaseId),
    queryFn: () => fetchAppendices(leaseId),
  })

  const toggle = useMutation({
    mutationFn: (vars: { documentId: string; attached: boolean }) =>
      updateAppendix(leaseId, vars.documentId, { attachedToLeaseAsAppendix: vars.attached }),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPENDIX_KEY(leaseId) }),
  })

  const setCategory = useMutation({
    mutationFn: (vars: { documentId: string; category: AppendixCategory }) =>
      updateAppendix(leaseId, vars.documentId, { category: vars.category }),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPENDIX_KEY(leaseId) }),
  })

  if (isLoading) return null

  const items = data?.items ?? []
  const attachedCount = items.filter((i) => i.attachedToLeaseAsAppendix).length

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">
          Bilagor &amp; appendix
        </p>
        {attachedCount > 0 ? (
          <span className="text-[11.5px] text-gray-500">
            {attachedCount} bifogad{attachedCount === 1 ? '' : 'a'} till kontraktet
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="border-line rounded-xl border border-dashed bg-white px-4 py-5 text-center text-[12.5px] text-gray-500">
          Inga dokument är länkade till detta kontrakt än. Ladda upp under <strong>Dokument</strong>{' '}
          och koppla mot leasen för att kunna bifoga som bilaga.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((doc) => (
            <AppendixRow
              key={doc.id}
              doc={doc}
              onToggle={(attached) => toggle.mutate({ documentId: doc.id, attached })}
              onSetCategory={(category) => setCategory.mutate({ documentId: doc.id, category })}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function AppendixRow({
  doc,
  onToggle,
  onSetCategory,
}: {
  doc: AppendixItem
  onToggle: (attached: boolean) => void
  onSetCategory: (category: AppendixCategory) => void
}) {
  const isAppendixCategory =
    doc.category === 'ENERGY_DECLARATION' ||
    doc.category === 'HOUSE_RULES' ||
    doc.category === 'INSPECTION_PROTOCOL' ||
    doc.category === 'OTHER'
  return (
    <li className="border-line flex items-start gap-3 rounded-xl border bg-white px-3.5 py-2.5">
      <input
        type="checkbox"
        checked={doc.attachedToLeaseAsAppendix}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-1 h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      <Paperclip size={14} strokeWidth={1.8} className="mt-1 shrink-0 text-gray-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-gray-800">{doc.name}</p>
        <p className="mt-0.5 text-[11.5px] text-gray-500">
          {APPENDIX_CATEGORY_LABEL[doc.category] ?? doc.category}
          {doc.fileSize ? ` · ${formatAppendixSize(doc.fileSize)}` : ''}
        </p>
      </div>
      {doc.attachedToLeaseAsAppendix ? (
        <select
          value={isAppendixCategory ? doc.category : 'OTHER'}
          onChange={(e) => onSetCategory(e.target.value as AppendixCategory)}
          className="h-7 shrink-0 rounded-md border border-[#E5E7EB] bg-white px-2 text-[12px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="ENERGY_DECLARATION">Energideklaration</option>
          <option value="HOUSE_RULES">Ordningsregler</option>
          <option value="INSPECTION_PROTOCOL">Tillträdesbesiktning</option>
          <option value="OTHER">Övrig bilaga</option>
        </select>
      ) : null}
    </li>
  )
}
