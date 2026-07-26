import { motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { LoadingDots } from './LoadingDots'
import { cn } from '@/lib/cn'
import type { PendingAction } from '../api/ai.api'

interface ConfirmationCardProps {
  pendingAction: PendingAction
  onConfirm: () => void
  onCancel: () => void
  isLoading: boolean
}

/**
 * Bekräftelsekortet för bindande verktyg (ACTION_TOOLS på servern). Visas ovanför
 * kompositören. `requiresDoubleConfirm` är serverns hög-risk-grind och byter både
 * färg och formulering — den skillnaden är avsiktlig och ska inte tonas ned.
 */
export function ConfirmationCard({
  pendingAction,
  onConfirm,
  onCancel,
  isLoading,
}: ConfirmationCardProps) {
  const entries = Object.entries(pendingAction.details)
  const isHighRisk = pendingAction.requiresDoubleConfirm === true
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="mx-auto max-w-3xl px-6 pb-4"
    >
      <div
        className={cn(
          'overflow-hidden rounded-2xl border border-l-4 border-gray-100 bg-white shadow-sm',
          isHighRisk ? 'border-l-red-600' : 'border-l-green-600',
        )}
      >
        <div className="px-5 pb-5 pt-4">
          {/* Header */}
          <div className="mb-3 flex items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg',
                isHighRisk ? 'bg-red-50' : 'bg-amber-50',
              )}
            >
              <AlertTriangle
                size={14}
                strokeWidth={1.8}
                className={isHighRisk ? 'text-red-600' : 'text-amber-600'}
              />
            </div>
            <span className="text-[13.5px] font-semibold text-gray-900">
              {isHighRisk ? 'Hög risk — bekräfta igen' : 'Bekräfta åtgärd'}
            </span>
          </div>

          {/* High risk extra warning */}
          {isHighRisk && (
            <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
              <p className="text-[12.5px] font-medium text-red-700">
                OBS: Denna åtgärd påverkar flera poster eller ett högt belopp. Kontrollera
                detaljerna nedan noggrant innan du bekräftar.
              </p>
            </div>
          )}

          {/* Confirmation message */}
          <p className="mb-4 text-[14px] font-medium text-gray-800">
            {pendingAction.confirmationMessage}
          </p>

          {/* Details grid */}
          {entries.length > 0 && (
            <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl bg-gray-50 p-3">
              {entries.map(([key, value]) => (
                <div key={key} className="flex flex-col">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {key}
                  </span>
                  <span className="text-[13px] font-medium text-gray-700">{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={isLoading}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 text-[13.5px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <X size={13} strokeWidth={2} />
              Avbryt
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className={cn(
                'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-4 text-[13.5px] font-medium text-white transition-colors active:scale-[0.97] disabled:opacity-50',
                isHighRisk ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700',
              )}
            >
              {isLoading ? (
                <LoadingDots />
              ) : (
                <>
                  <CheckCircle2 size={14} strokeWidth={2} />
                  {isHighRisk ? 'Ja, jag är säker — utför ändå' : 'Bekräfta och utför'}
                </>
              )}
            </button>
          </div>

          <p className="mt-2.5 text-center text-[11px] text-gray-400">
            {isHighRisk
              ? 'Åtgärden kan inte enkelt ångras efter utförande'
              : 'Åtgärden utförs direkt efter bekräftelse'}
          </p>
        </div>
      </div>
    </motion.div>
  )
}
