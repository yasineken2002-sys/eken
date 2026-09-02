import { motion } from 'framer-motion'
import { Check, Clock, RotateCcw, X } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatDate } from '@eken/shared'
import type { Assignment } from '../api/assignments.api'

interface Props {
  assignment: Assignment
  onDecide: (decision: 'APPROVED' | 'REJECTED') => void
  isDeciding: boolean
}

/**
 * GODKÄNNANDEKORTET, v1.
 *
 * Ett godkännande som kräver att man kontrollerar agentens arbete är ingen
 * besparing — det är granskning, som är tröttare. Kortet bär därför de fyra
 * saker beslutet behöver utan att öppna en annan sida: vad, varför, vad det får
 * för följd, och om det går att ångra.
 *
 * KONSEKVENSEN OCH ÅNGERVÄGEN STÅR FÖRE KNAPPARNA, aldrig efter. Ett "det gick
 * inte att ångra" som dyker upp efter ett ja är information som kommit för sent
 * för att vara information.
 *
 * ── VAD DET HÄR KORTET INTE ÄR ──────────────────────────────────────────────
 *
 * Planens Del 11 vill dessutom ha kostnad, säkerhetsgrad och "Gör alltid detta"
 * (som skapar en delegation). Inget av det finns här, och det är avsiktligt:
 * delegationsmodellen är G2 och rikedomen är etapp 6. Ett fält som visar en
 * gissad siffra är sämre än ett fält som saknas.
 */
export function AssignmentCard({ assignment: u, onDecide, isDeciding }: Props) {
  const väntar = u.status === 'AWAITING_APPROVAL'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="border-line bg-surface rounded-2xl border p-5 transition-shadow hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-gray-900">{u.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-500">{u.reasoning}</p>
        </div>
        <StatusBadge status={u.status} />
      </div>

      {u.evidence.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {u.evidence.map((e) => (
            <span
              key={`${e.entityType}-${e.entityId}`}
              className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-600"
            >
              {e.label}
            </span>
          ))}
        </div>
      )}

      {/* Konsekvens och ångerväg — FÖRE knapparna. */}
      <div className="mt-4 space-y-1.5 rounded-xl bg-gray-50 px-3.5 py-3">
        <p className="text-[12.5px] text-gray-600">{u.consequence}</p>
        <p className="flex items-start gap-1.5 text-[12.5px] text-gray-500">
          <RotateCcw size={13} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" />
          {u.undoHint}
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[12px] text-gray-400">
          <Clock size={12} strokeWidth={1.8} />
          {väntar
            ? `Gäller till ${formatDate(u.deadline)}`
            : (u.statusReason ?? `Beslutat ${formatDate(u.decidedAt ?? u.createdAt)}`)}
        </span>

        {väntar && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={isDeciding}
              onClick={() => onDecide('REJECTED')}
            >
              <X size={13} strokeWidth={2} />
              Avslå
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isDeciding}
              onClick={() => onDecide('APPROVED')}
            >
              <Check size={13} strokeWidth={2} />
              Godkänn
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  )
}

function StatusBadge({ status }: { status: Assignment['status'] }) {
  // EXPIRED är WARNING och inte DANGER: ingenting gick sönder, något uteblev.
  // Att måla det rött hade sagt "fel" om ett utfall som bara är ett utfall.
  switch (status) {
    case 'AWAITING_APPROVAL':
      return <Badge variant="info">Väntar på dig</Badge>
    case 'APPROVED':
      return <Badge variant="success">Godkänt</Badge>
    case 'REJECTED':
      return <Badge variant="default">Avslaget</Badge>
    case 'EXPIRED':
      return <Badge variant="warning">Förföll</Badge>
  }
}
