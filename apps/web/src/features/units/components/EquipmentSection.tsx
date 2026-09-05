import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Wrench, Plus, RefreshCw, Package } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { EquipmentModal } from './EquipmentModal'
import { ReplacementModal } from './ReplacementModal'
import { useEquipment } from '../hooks/useEquipment'
import { EQUIPMENT_KIND_LABELS } from '../api/equipment.api'
import { cn } from '@/lib/cn'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Equipment } from '../api/equipment.api'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

function namnFör(e: Equipment): string {
  const sort = EQUIPMENT_KIND_LABELS[e.kind] ?? e.kind
  return e.label ? `${sort} — ${e.label}` : sort
}

/** Utrustningen i en lägenhet: vad som sitter där, och vad som byttes när. */
export function EquipmentSection({ unitId }: { unitId: string }) {
  const { data, isLoading } = useEquipment(unitId)
  const [skapaÖppen, setSkapaÖppen] = useState(false)
  const [byteFör, setByteFör] = useState<Equipment | null>(null)

  const utrustning = data ?? []
  // Aktiv först, utbytt sedan — den som tittar frågar oftast vad som sitter där NU.
  const aktiv = utrustning.filter((e) => !e.removedAt)
  const historisk = utrustning.filter((e) => e.removedAt)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-[14px] font-semibold text-gray-900">Utrustning</p>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Vad som sitter i lägenheten — och vad som byttes när
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setSkapaÖppen(true)}>
          <Plus size={14} strokeWidth={1.8} />
          Lägg till
        </Button>
      </div>

      {isLoading && <p className="text-[13px] text-gray-400">Hämtar utrustning…</p>}

      {!isLoading && utrustning.length === 0 && (
        <EmptyState
          icon={Package}
          title="Ingen utrustning registrerad"
          description="Lägg till kylskåp, spis, ventilation och annat som sitter i lägenheten. Då kan systemet svara på vad som byttes och när."
          action={
            <Button variant="primary" size="sm" onClick={() => setSkapaÖppen(true)}>
              Lägg till utrustning
            </Button>
          }
        />
      )}

      {!isLoading && utrustning.length > 0 && (
        <motion.div variants={container} initial="hidden" animate="show" className="space-y-3">
          {[...aktiv, ...historisk].map((e) => (
            <motion.div
              key={e.id}
              variants={item}
              className={cn(
                'border-line bg-surface rounded-2xl border p-4 transition-shadow hover:shadow-sm',
                e.removedAt && 'opacity-70',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-50">
                    <Wrench size={12} strokeWidth={1.8} className="text-gray-400" />
                  </div>
                  <div>
                    <p className="text-[13.5px] font-medium text-gray-900">{namnFör(e)}</p>
                    <p className="mt-0.5 text-[12px] text-gray-400">
                      Installerad {formatDate(e.installedAt)}
                      {e.removedAt ? ` · utbytt ${formatDate(e.removedAt)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {e.removedAt ? (
                    <Badge variant="info" dot>
                      Utbytt
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="success" dot>
                        Sitter kvar
                      </Badge>
                      <Button variant="secondary" size="xs" onClick={() => setByteFör(e)}>
                        <RefreshCw size={12} strokeWidth={1.8} />
                        Registrera byte
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {e.events.length > 0 && (
                <ul className="border-line mt-3 space-y-1.5 border-t pt-3">
                  {e.events.map((h) => (
                    <li key={h.id} className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] text-gray-500">
                        {h.correctsId ? 'RÄTTELSE · ' : ''}
                        {formatDate(h.occurredAt)} — {h.note ?? h.type}
                        {h.performedBy
                          ? ` (${h.performedBy.firstName} ${h.performedBy.lastName})`
                          : ''}
                      </span>
                      {/* Okänd kostnad visas som streck, aldrig som 0 kr. */}
                      <span className="shrink-0 text-[12px] text-gray-400">
                        {h.cost != null ? formatCurrency(Number(h.cost)) : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          ))}
        </motion.div>
      )}

      <EquipmentModal open={skapaÖppen} unitId={unitId} onClose={() => setSkapaÖppen(false)} />
      <ReplacementModal equipment={byteFör} unitId={unitId} onClose={() => setByteFör(null)} />
    </div>
  )
}
