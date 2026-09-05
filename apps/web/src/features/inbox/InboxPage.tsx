import React, { useState } from 'react'

import { Inbox as InboxIcon } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'

import { InboxDetailModal } from './components/InboxDetailModal'
import { formatKonfidens, formatTraffgrad, konfidensVariant } from './lib/confidence'
import { useDecideInboxItem, useInbox, useInboxSummary } from './hooks/useInbox'

import type { AssignmentStatus, InboxItem } from './api/inbox.api'

/** Filterflikarna. `undefined` = alla. */
const FLIKAR: Array<{ etikett: string; status?: AssignmentStatus }> = [
  { etikett: 'Väntande', status: 'AWAITING_APPROVAL' },
  { etikett: 'Godkända', status: 'APPROVED' },
  { etikett: 'Avvisade', status: 'REJECTED' },
  { etikett: 'Alla' },
]

const STATUSTEXT: Record<
  AssignmentStatus,
  { text: string; variant: 'default' | 'success' | 'danger' | 'warning' }
> = {
  AWAITING_APPROVAL: { text: 'Väntar', variant: 'default' },
  APPROVED: { text: 'Godkänt', variant: 'success' },
  REJECTED: { text: 'Avvisat', variant: 'danger' },
  EXPIRED: { text: 'Förföll', variant: 'warning' },
}

/**
 * INKORGEN — agentens förslag, och hyresvärdens svar.
 *
 * Sidan är en TILLÄGGSYTA. Planens Del 16 förbjuder uttryckligen att "gömma
 * befintliga manuella funktioner eller ersätta dashboarden med inkorgen": allt
 * hyresvärden kunde göra för hand går fortfarande att göra på samma ställe som
 * förut.
 */
export function InboxPage() {
  const [flik, setFlik] = useState(0)
  const [vald, setVald] = useState<InboxItem | null>(null)

  const status = FLIKAR[flik]?.status
  const lista = useInbox(status)
  const summary = useInboxSummary()
  const beslut = useDecideInboxItem()

  const rader = lista.data?.rader ?? []

  const kolumner = [
    {
      key: 'title',
      header: 'Ärende',
      cell: (r: InboxItem) => <span className="font-medium">{r.title}</span>,
    },
    {
      key: 'toolName',
      header: 'Förslag',
      cell: (r: InboxItem) => <span className="font-mono text-[13px]">{r.toolName}</span>,
    },
    {
      key: 'confidence',
      header: 'Konfidens',
      cell: (r: InboxItem) => (
        <Badge variant={konfidensVariant(r.confidence)}>{formatKonfidens(r.confidence)}</Badge>
      ),
    },
    {
      key: 'createdAt',
      header: 'Skapad',
      cell: (r: InboxItem) => formatDate(r.createdAt),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r: InboxItem) => (
        <Badge variant={STATUSTEXT[r.status].variant}>{STATUSTEXT[r.status].text}</Badge>
      ),
    },
  ]

  return (
    <PageWrapper id="inbox">
      <PageHeader
        title="Inkorg"
        description="Systemet föreslår, du bestämmer. Ingenting utförs utan ditt ja."
      />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Väntande" value={summary.data?.status.AWAITING_APPROVAL ?? 0} />
        <StatCard title="Godkända" value={summary.data?.status.APPROVED ?? 0} />
        <StatCard title="Avvisade" value={summary.data?.status.REJECTED ?? 0} />
        {/* TRÄFFGRADEN VISAR `—` TILLS FACIT FINNS. `0 %` hade fått en
            fungerande agent att se trasig ut sin första dag. */}
        <StatCard title="Träffgrad" value={formatTraffgrad(summary.data?.traffgrad)} />
      </div>

      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {FLIKAR.map((f, i) => (
          <button
            key={f.etikett}
            type="button"
            onClick={() => setFlik(i)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              i === flik ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {f.etikett}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {lista.isError ? (
          <LoadErrorState vad="inkorgen" onRetry={() => void lista.refetch()} />
        ) : rader.length === 0 && !lista.isLoading ? (
          <EmptyState
            icon={InboxIcon}
            title="Inga förslag än"
            description="Förslag dyker upp här när felanmälningar kommer in och funktionen är påslagen för din organisation."
          />
        ) : (
          <DataTable
            columns={kolumner}
            data={rader}
            keyExtractor={(r) => r.id}
            onRowClick={(r) => setVald(r)}
            rowLabel={(r) => `Öppna förslaget ${r.title}`}
          />
        )}
      </div>

      <InboxDetailModal
        item={vald}
        onClose={() => setVald(null)}
        pending={beslut.isPending}
        onDecide={(p) => {
          beslut.mutate(p, { onSuccess: () => setVald(null) })
        }}
      />
    </PageWrapper>
  )
}
