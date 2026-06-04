import React, { useMemo, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import { get } from '@/lib/api'
import { formatCurrency } from '@eken/shared'
import {
  useContractBatch,
  useConfirmRow,
  useConfirmSafe,
  useSkipRow,
} from './hooks/useContractBatch'
import type {
  ContractBatchRow,
  ContractMatchStatus,
  ScannedContractData,
} from './api/contractBatch.api'

type TabId = 'safe' | 'review' | 'nomatch'

interface UnitOption {
  id: string
  unitNumber: string
  name: string
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'safe', label: 'Säkra' },
  { id: 'review', label: 'Behöver granskning' },
  { id: 'nomatch', label: 'Ingen match' },
]

function inTab(row: ContractBatchRow, tab: TabId): boolean {
  if (row.rowStatus !== 'SCANNED') return false
  if (tab === 'safe') return row.matchStatus === 'AUTO_MATCHED'
  if (tab === 'review') return row.matchStatus === 'AMBIGUOUS' || row.matchStatus === 'NEEDS_REVIEW'
  return row.matchStatus === 'NO_MATCH'
}

function matchBadge(status: ContractMatchStatus): React.ReactNode {
  switch (status) {
    case 'AUTO_MATCHED':
      return <Badge variant="success">Säker match</Badge>
    case 'AMBIGUOUS':
      return <Badge variant="warning">Flera kandidater</Badge>
    case 'NEEDS_REVIEW':
      return <Badge variant="warning">Behöver granskning</Badge>
    case 'NO_MATCH':
      return <Badge variant="danger">Ingen match</Badge>
    default:
      return <Badge variant="ghost">—</Badge>
  }
}

export function ContractBatchReviewPage() {
  const params = useParams({ strict: false }) as { batchId?: string }
  const batchId = params.batchId ?? ''
  const { data: batch, isLoading } = useContractBatch(batchId)
  const confirmSafe = useConfirmSafe(batchId)
  const [tab, setTab] = useState<TabId>('safe')
  const [editRow, setEditRow] = useState<ContractBatchRow | null>(null)

  const units = useQuery({
    queryKey: ['units', 'picker'],
    queryFn: () => get<UnitOption[]>('/units'),
    staleTime: 60_000,
  })

  const counts = useMemo(() => {
    const rows = batch?.rows ?? []
    return {
      safe: rows.filter((r) => inTab(r, 'safe')).length,
      review: rows.filter((r) => inTab(r, 'review')).length,
      nomatch: rows.filter((r) => inTab(r, 'nomatch')).length,
      committed: rows.filter((r) => r.rowStatus === 'COMMITTED').length,
      skipped: rows.filter((r) => r.rowStatus === 'SKIPPED').length,
      failed: rows.filter((r) => r.rowStatus === 'FAILED').length,
      scanning: rows.filter((r) => r.rowStatus === 'PENDING' || r.rowStatus === 'SCANNING').length,
    }
  }, [batch])

  const visibleRows = (batch?.rows ?? []).filter((r) => inTab(r, tab))

  return (
    <PageWrapper id="contract-batch-review">
      <PageHeader
        title="Granska skannade kontrakt"
        description="Godkänn rader för att skapa avtal. Inget avtal skapas utan att du godkänner — säkra matchningar är förvalda men aldrig automatiska."
        action={
          <Button
            variant="primary"
            disabled={counts.safe === 0 || confirmSafe.isPending}
            onClick={() => confirmSafe.mutate()}
          >
            <ShieldCheck size={15} className="mr-1.5" />
            {confirmSafe.isPending ? 'Godkänner…' : `Godkänn alla säkra (${counts.safe})`}
          </Button>
        }
      />

      {/* KPI-rad */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Kpi label="Totalt" value={batch?.totalRows ?? 0} />
        <Kpi label="Skannar" value={counts.scanning} />
        <Kpi label="Avtal skapade" value={counts.committed} accent="emerald" />
        <Kpi label="Misslyckade" value={counts.failed} accent={counts.failed ? 'red' : undefined} />
      </div>

      {/* Filterflikar */}
      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label} ({counts[t.id]})
          </button>
        ))}
      </div>

      {/* Tabell */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
        {isLoading ? (
          <div className="p-8 text-center text-[13px] text-gray-400">Laddar…</div>
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon={tab === 'safe' ? ShieldCheck : FileText}
            title="Inga rader här"
            description={
              counts.scanning > 0
                ? 'Skanningen pågår fortfarande — raderna fylls på allteftersom.'
                : 'Inget att granska i den här vyn.'
            }
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#EAEDF0]">
                <Th>Fil</Th>
                <Th>Hyresgäst</Th>
                <Th>Adress / enhet</Th>
                <Th>Hyra</Th>
                <Th>Matchning</Th>
                <Th className="text-right">Åtgärd</Th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <RowItem key={row.id} batchId={batchId} row={row} onEdit={() => setEditRow(row)} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editRow && (
        <EditRowModal
          batchId={batchId}
          row={editRow}
          units={units.data ?? []}
          onClose={() => setEditRow(null)}
        />
      )}
    </PageWrapper>
  )
}

function RowItem({
  batchId,
  row,
  onEdit,
}: {
  batchId: string
  row: ContractBatchRow
  onEdit: () => void
}) {
  const confirm = useConfirmRow(batchId)
  const skip = useSkipRow(batchId)
  const d = row.reviewedData
  const canQuickConfirm = row.matchStatus === 'AUTO_MATCHED'

  return (
    <tr className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80">
      <Td className="max-w-[160px] truncate text-gray-500">{row.fileName}</Td>
      <Td className="font-medium text-gray-900">{d?.tenantName ?? '—'}</Td>
      <Td className="text-gray-600">{d?.propertyAddress ?? '—'}</Td>
      <Td className="text-gray-600">
        {typeof d?.monthlyRent === 'number' ? formatCurrency(d.monthlyRent) : '—'}
      </Td>
      <Td>{matchBadge(row.matchStatus)}</Td>
      <Td className="text-right">
        <div className="flex justify-end gap-1.5">
          {canQuickConfirm && (
            <Button
              variant="primary"
              size="xs"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate({ rowId: row.id, body: {} })}
            >
              Godkänn
            </Button>
          )}
          <Button variant="secondary" size="xs" onClick={onEdit}>
            {canQuickConfirm ? 'Redigera' : 'Välj enhet'}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={skip.isPending}
            onClick={() => skip.mutate(row.id)}
          >
            Hoppa över
          </Button>
        </div>
      </Td>
    </tr>
  )
}

function EditRowModal({
  batchId,
  row,
  units,
  onClose,
}: {
  batchId: string
  row: ContractBatchRow
  units: UnitOption[]
  onClose: () => void
}) {
  const confirm = useConfirmRow(batchId)
  const d = row.reviewedData
  const [tenantName, setTenantName] = useState(d?.tenantName ?? '')
  const [tenantEmail, setTenantEmail] = useState(d?.tenantEmail ?? '')
  const [monthlyRent, setMonthlyRent] = useState(
    d?.monthlyRent != null ? String(d.monthlyRent) : '',
  )
  const [startDate, setStartDate] = useState(d?.startDate ?? '')
  const [unitId, setUnitId] = useState(row.matchedUnitId ?? '')

  async function save() {
    const reviewedData: Partial<ScannedContractData> = {
      tenantName: tenantName.trim() || null,
      tenantEmail: tenantEmail.trim() || null,
      monthlyRent: monthlyRent.trim() ? Number(monthlyRent) : null,
      startDate: startDate.trim() || null,
    }
    await confirm.mutateAsync({
      rowId: row.id,
      body: { ...(unitId ? { unitId } : {}), reviewedData },
    })
    onClose()
  }

  return (
    <Modal open onClose={onClose} title="Granska & godkänn rad">
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-gray-700">Enhet</label>
          <select
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            className="h-9 w-full rounded-lg border border-[#DDDFE4] px-2 text-[13.5px] focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Välj enhet…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.unitNumber} — {u.name}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="Hyresgäst (för- och efternamn)"
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
        />
        <Input
          label="E-post (krävs för att skapa avtal)"
          value={tenantEmail}
          onChange={(e) => setTenantEmail(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Månadshyra (SEK)"
            type="number"
            value={monthlyRent}
            onChange={(e) => setMonthlyRent(e.target.value)}
          />
          <Input
            label="Startdatum"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <p className="text-[12px] text-gray-400">
          Ett avtalsutkast skapas via hyresavtalsflödet när du godkänner. Inget aktiveras
          automatiskt.
        </p>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button variant="primary" disabled={confirm.isPending} onClick={save}>
          {confirm.isPending ? 'Skapar avtal…' : 'Godkänn & skapa avtal'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: 'emerald' | 'red' | undefined
}) {
  return (
    <div className="rounded-2xl border border-[#EAEDF0] bg-white p-4">
      <p className="text-[12px] text-gray-500">{label}</p>
      <p
        className={cn(
          'mt-1 text-[26px] font-semibold tracking-tight',
          accent === 'emerald' && 'text-emerald-600',
          accent === 'red' && 'text-red-600',
          !accent && 'text-gray-900',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-4 py-3 text-[13px]', className)}>{children}</td>
}
