import { useState } from 'react'
import { motion } from 'framer-motion'
import { History, AlertTriangle, ChevronRight, ReceiptText, ShieldCheck } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { BackfillConfirmModal } from './components/BackfillConfirmModal'
import { useBackfillQueue } from './hooks/useBackfill'
import { formatCurrency } from '@eken/shared'
import type { BackfillQueueItem } from './api/backfill.api'

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}
const rowItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function BackfillPage() {
  const { data: queue, isLoading } = useBackfillQueue()
  const [selected, setSelected] = useState<BackfillQueueItem | null>(null)

  const items = queue ?? []
  const contractCount = items.length
  const billableTotal = items.reduce((sum, i) => sum + i.summary.billableTotal, 0)
  const approvalCount = items.filter((i) => i.requiresApproval).length

  return (
    <PageWrapper id="backfill">
      <PageHeader
        title="Efterdebitering"
        description="Kontrakt som aktiverats bakåt i tiden och har bebodda men aldrig aviserade månader. Du godkänner varje efterdebitering — inget skapas automatiskt."
      />

      {contractCount > 0 && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            title="Kontrakt att efterdebitera"
            value={contractCount}
            icon={History}
            iconColor="#2563EB"
          />
          <StatCard
            title="Debiterbart belopp (≤12 mån)"
            value={formatCurrency(billableTotal)}
            icon={ReceiptText}
            iconColor="#059669"
          />
          <StatCard
            title="Kräver extra godkännande"
            value={approvalCount}
            icon={AlertTriangle}
            iconColor="#D97706"
          />
        </div>
      )}

      <div className="mt-6">
        {isLoading ? (
          <p className="py-16 text-center text-[13px] text-gray-400">Läser in kön…</p>
        ) : contractCount === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Inget att efterdebitera"
            description="Alla aktiva kontrakt är fullständigt aviserade. När ett kontrakt aktiveras bakåt i tiden dyker det upp här för din bekräftelse."
          />
        ) : (
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white"
          >
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-[#EAEDF0] px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              <span>Kontrakt</span>
              <span className="text-right">Att debitera</span>
              <span className="w-5" />
            </div>
            {items.map((item) => {
              const monthCount = item.summary.billableCount + item.summary.beyondWarningCount
              return (
                <motion.button
                  key={item.leaseId}
                  variants={rowItem}
                  onClick={() => setSelected(item)}
                  className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-[#EAEDF0] px-4 py-3 text-left transition-colors last:border-0 hover:bg-gray-50/80"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-gray-900">
                      {item.tenantName}
                    </p>
                    <p className="truncate text-[12px] text-gray-400">
                      {item.unitLabel} · {item.propertyLabel}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {item.requiresApproval && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          <AlertTriangle size={10} strokeWidth={2} />
                          Lång bakdatering
                        </span>
                      )}
                      {item.hasVoluntaryTaxLiability && (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                          Momspliktig lokal
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[13.5px] font-semibold text-gray-900">
                      {formatCurrency(item.summary.billableTotal + item.summary.beyondWarningTotal)}
                    </p>
                    <p className="text-[12px] text-gray-400">{monthCount} månad(er)</p>
                  </div>
                  <ChevronRight size={16} strokeWidth={1.8} className="text-gray-300" />
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </div>

      {selected && (
        <BackfillConfirmModal
          item={selected}
          onClose={() => setSelected(null)}
          onDone={() => setSelected(null)}
        />
      )}
    </PageWrapper>
  )
}
