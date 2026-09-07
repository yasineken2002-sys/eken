import React, { useEffect, useState } from 'react'

import { Inbox as InboxIcon } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { PageWrapper } from '@/components/ui/PageWrapper'

import { GjortSektion } from './components/GjortSektion'
import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'

import { InboxDetailModal } from './components/InboxDetailModal'
import { formatKonfidens, formatTraffgrad, konfidensVariant } from './lib/confidence'
import { verdiktVisning } from './lib/verdict'
import {
  useDecideInboxItem,
  useInbox,
  useInboxSummary,
  useKanDelegera,
  useSkapaDelegation,
} from './hooks/useInbox'

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
  // ── DE TRE UTFÖRANDESTATUSARNA (etapp 9) ────────────────────────────────
  //
  // Kartan är `Record<AssignmentStatus, …>`, så TypeScript krävde de här tre i
  // samma stund som unionen vidgades. Det är rätt håll: en status utan text
  // hade renderats som en tom badge, och felet hade synts först i drift.
  EXECUTED: { text: 'Utförd', variant: 'success' },
  FAILED: { text: 'Misslyckades', variant: 'danger' },
  LAPSED: { text: 'Utfördes inte', variant: 'warning' },
}

/**
 * INKORGEN — agentens förslag, och hyresvärdens svar.
 *
 * Sidan är en TILLÄGGSYTA. Planens Del 16 förbjuder uttryckligen att "gömma
 * befintliga manuella funktioner eller ersätta dashboarden med inkorgen": allt
 * hyresvärden kunde göra för hand går fortfarande att göra på samma ställe som
 * förut.
 */
export function InboxPage({ forslag }: { forslag?: string | undefined } = {}) {
  // Kommer man via delegationssidans "Född ur"-länk är fliken ALLA från början.
  // Rätten kan ha fötts ur ett förslag som inte längre står i standardvyn, och
  // en länk som landar på en tom lista läser som att beslutet är borta.
  const [flik, setFlik] = useState(forslag ? FLIKAR.length - 1 : 0)
  const [vald, setVald] = useState<InboxItem | null>(null)
  const [öppnat, setÖppnat] = useState(false)

  const status = FLIKAR[flik]?.status
  const lista = useInbox(status)
  const summary = useInboxSummary()
  const beslut = useDecideInboxItem()
  // Frågan ställs bara för en ÖPPEN och GODKÄND rad — knappen finns inte annars.
  const kanDelegera = useKanDelegera(vald?.id ?? null, vald?.status === 'APPROVED')
  const delegera = useSkapaDelegation()

  const rader = lista.data?.rader ?? []

  // ÖPPNA EN GÅNG. Utan spärren hade modalen öppnats igen varje gång listan
  // hämtades om — inklusive direkt efter att användaren stängt den.
  useEffect(() => {
    if (!forslag || öppnat) return
    const träff = rader.find((r) => r.id === forslag)
    if (!träff) return
    setVald(träff)
    setÖppnat(true)
  }, [forslag, öppnat, rader])

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
      // TORRLÄGETS DOM PÅ KORTET (etapp 8). Hyresvärden ska se vad skarpt läge
      // hade inneburit INNAN hen slår på det — inte efteråt.
      key: 'verdict',
      header: 'I skarpt läge',
      cell: (r: InboxItem) => {
        const v = verdiktVisning(r)
        // INGEN DOM = INGEN BADGE. En tom cell säger "vi vet inte än", vilket
        // är sant; en badge hade gjort en lucka i kön till ett påstående.
        return v ? (
          <Badge variant={v.variant}>{v.etikett}</Badge>
        ) : (
          <span className="text-gray-400">—</span>
        )
      },
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
        kanDelegera={kanDelegera.data}
        delegeringLaddar={kanDelegera.isLoading}
        delegeringSparar={delegera.isPending}
        onDelegera={(villkor, frekvensvillkor) => {
          if (!vald) return
          delegera.mutate({
            assignmentId: vald.id,
            ...(villkor ? { villkor } : {}),
            // TAKET FÖLJER MED när verktyget kräver ett. Utan raden avvisade
            // servern hela delegationen med 400 för de tre DEDUPLICERBARA
            // verktygen — mätt, och det såg ut som ett gränssnittsfel.
            ...(frekvensvillkor ? { frekvensvillkor } : {}),
          })
        }}
        onDecide={(p) => {
          beslut.mutate(p, { onSuccess: () => setVald(null) })
        }}
      />

      {/* SIST PÅ SIDAN, och det är ordningen som bär budskapet: förslagen som
          väntar på dig först, det agenten redan gjort sist. Sektionen döljer
          sig själv när den är tom — skarpt läge är av i varje organisation. */}
      <GjortSektion />
    </PageWrapper>
  )
}
