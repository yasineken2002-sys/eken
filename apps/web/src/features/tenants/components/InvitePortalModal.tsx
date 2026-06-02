import { useState } from 'react'
import { toast } from 'sonner'
import {
  Mail,
  MailX,
  MailCheck,
  MailWarning,
  CheckCircle2,
  Clock,
  Send,
  AlertTriangle,
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useInviteStatus, useInviteTenants, useResendInvites } from '../hooks/useInvitations'
import type { InviteResult, InviteStatusRow, TenantInviteStatus } from '../api/invitations.api'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  onClose: () => void
}

const STATUS_META: Record<
  TenantInviteStatus,
  { label: string; className: string; icon: typeof Mail }
> = {
  ACTIVATED: {
    label: 'Aktiverad',
    className: 'bg-emerald-50 text-emerald-700',
    icon: CheckCircle2,
  },
  DELIVERED: { label: 'Levererad', className: 'bg-teal-50 text-teal-700', icon: MailCheck },
  BOUNCED: {
    label: 'Studsad — åtgärda',
    className: 'bg-amber-50 text-amber-700',
    icon: MailWarning,
  },
  INVITED: { label: 'Inbjuden', className: 'bg-blue-50 text-blue-700', icon: Mail },
  NOT_INVITED: { label: 'Ej inbjuden', className: 'bg-gray-100 text-gray-600', icon: Clock },
  NO_EMAIL: { label: 'Saknar mejl', className: 'bg-red-50 text-red-600', icon: MailX },
}

function summarize(r: InviteResult): string {
  const parts = [`${r.invited} inbjudna`]
  if (r.skippedNoEmail) parts.push(`${r.skippedNoEmail} saknar mejl`)
  if (r.alreadyActivated) parts.push(`${r.alreadyActivated} redan aktiverade`)
  if (r.skippedRecent) parts.push(`${r.skippedRecent} nyligen inbjudna`)
  if (r.failed) parts.push(`${r.failed} misslyckades`)
  return parts.join(' · ')
}

function StatusBadge({ status }: { status: TenantInviteStatus }) {
  const m = STATUS_META[status]
  const Icon = m.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        m.className,
      )}
    >
      <Icon size={12} strokeWidth={1.8} />
      {m.label}
    </span>
  )
}

export function InvitePortalModal({ open, onClose }: Props) {
  const { data, isLoading } = useInviteStatus()
  const invite = useInviteTenants()
  const resend = useResendInvites()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const busy = invite.isPending || resend.isPending
  const counts = data?.counts ?? {
    NOT_INVITED: 0,
    NO_EMAIL: 0,
    INVITED: 0,
    DELIVERED: 0,
    BOUNCED: 0,
    ACTIVATED: 0,
  }
  const rows = data?.items ?? []
  const noEmailRows = rows.filter((r) => r.status === 'NO_EMAIL')
  // Allt utom redan aktiverade och de som saknar mejl kan (om)bjudas in — inkl.
  // studsade (ägaren kan ha rättat adressen) och levererade-men-ej-aktiverade.
  const selectable = (r: InviteStatusRow) => r.status !== 'ACTIVATED' && r.status !== 'NO_EMAIL'

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleResult(r: InviteResult) {
    if (r.invited > 0) toast.success(`Inbjudningar skickade: ${summarize(r)}`)
    else toast.info(`Inga nya inbjudningar — ${summarize(r)}`)
    if (r.skippedNoEmail > 0) {
      toast.warning(
        `${r.skippedNoEmail} hyresgäst(er) saknar giltig mejl — åtgärda och bjud in igen`,
      )
    }
    if (r.failed > 0) toast.error(`${r.failed} inbjudan(ar) misslyckades`)
    setSelected(new Set())
  }

  function inviteAll() {
    invite.mutate(
      { all: true },
      { onSuccess: handleResult, onError: () => toast.error('Något gick fel') },
    )
  }
  function inviteSelected() {
    invite.mutate(
      { tenantIds: Array.from(selected), force: true },
      { onSuccess: handleResult, onError: () => toast.error('Något gick fel') },
    )
  }
  function remindNotActivated() {
    resend.mutate(
      { onlyNotActivated: true },
      { onSuccess: handleResult, onError: () => toast.error('Något gick fel') },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bjud in till portalen"
      description="Skicka aktiveringsmejl till dina hyresgäster så de kan logga in i portalen."
      size="lg"
    >
      {/* Räknare */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {(
          [
            'ACTIVATED',
            'DELIVERED',
            'INVITED',
            'BOUNCED',
            'NOT_INVITED',
            'NO_EMAIL',
          ] as TenantInviteStatus[]
        ).map((s) => (
          <div key={s} className="rounded-xl border border-[#EAEDF0] bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {STATUS_META[s].label}
            </p>
            <p className="mt-0.5 text-[20px] font-semibold tracking-tight text-gray-900">
              {counts[s]}
            </p>
          </div>
        ))}
      </div>

      {/* Saknar mejl — åtgärda (ytas, hoppas ALDRIG tyst över) */}
      {noEmailRows.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50/70 p-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-red-600">
            <AlertTriangle size={14} strokeWidth={1.8} />
            {noEmailRows.length} hyresgäst(er) saknar giltig mejladress — åtgärda för att kunna
            bjuda in
          </p>
          <ul className="mt-2 space-y-1">
            {noEmailRows.slice(0, 8).map((r) => (
              <li key={r.tenantId} className="text-[12.5px] text-red-700">
                {r.name}
                {r.email.trim() ? ` (${r.email})` : ' (ingen mejl)'}
              </li>
            ))}
            {noEmailRows.length > 8 && (
              <li className="text-[12px] text-red-500">+ {noEmailRows.length - 8} till</li>
            )}
          </ul>
        </div>
      )}

      {/* Lista */}
      <div className="mt-4 max-h-[280px] overflow-y-auto rounded-xl border border-[#EAEDF0]">
        {isLoading ? (
          <p className="p-4 text-[13px] text-gray-400">Laddar…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-[13px] text-gray-400">Inga hyresgäster.</p>
        ) : (
          rows.map((r) => (
            <label
              key={r.tenantId}
              className="flex items-center gap-3 border-b border-[#EAEDF0] px-4 py-2.5 last:border-0 hover:bg-gray-50/80"
            >
              <input
                type="checkbox"
                disabled={!selectable(r) || busy}
                checked={selected.has(r.tenantId)}
                onChange={() => toggle(r.tenantId)}
                className="h-4 w-4 rounded border-gray-300 disabled:opacity-40"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-gray-800">{r.name}</p>
                <p className="truncate text-[12px] text-gray-400">{r.email || '—'}</p>
                {r.status === 'BOUNCED' && r.bounceReason && (
                  <p className="truncate text-[11.5px] text-amber-600" title={r.bounceReason}>
                    {r.bounceReason}
                  </p>
                )}
              </div>
              <StatusBadge status={r.status} />
            </label>
          ))
        )}
      </div>

      {/* Åtgärder */}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-[#EAEDF0] pt-5">
        <Button
          variant="secondary"
          size="sm"
          onClick={remindNotActivated}
          loading={resend.isPending}
        >
          <Clock size={13} strokeWidth={1.8} />
          Påminn ej aktiverade
        </Button>
        {selected.size > 0 && (
          <Button variant="secondary" size="sm" onClick={inviteSelected} loading={invite.isPending}>
            <Send size={13} strokeWidth={1.8} />
            Bjud in valda ({selected.size})
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={inviteAll} loading={invite.isPending}>
          <Mail size={13} strokeWidth={1.8} />
          Bjud in alla aktiva
        </Button>
      </div>
    </Modal>
  )
}
