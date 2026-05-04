import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { CheckCircle2, AlertTriangle, FileText, Lock, Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  fetchContractStatus,
  generateLeaseContract,
  downloadLeaseContract,
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
      <div className="rounded-2xl border border-[#EAEDF0] bg-white p-4">
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
      {versions.length > 1 && (
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Versionshistorik
          </p>
          <ul className="space-y-2">
            {versions.map((v, i) => (
              <li
                key={v.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-[#EAEDF0] bg-white px-3.5 py-2.5 text-[13px]"
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
