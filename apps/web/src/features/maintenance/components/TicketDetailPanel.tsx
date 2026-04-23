import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Lock, Globe, Copy, Check, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  MaintenanceStatusBadge,
  MaintenancePriorityBadge,
  MaintenanceCategoryLabel,
} from './MaintenanceBadges'
import { useUpdateTicket, useAddComment } from '../hooks/useMaintenance'
import { formatDate, formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { MaintenanceTicket } from '../api/maintenance.api'

interface Props {
  ticket: MaintenanceTicket
  onClose: () => void
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium text-gray-800">{value ?? '—'}</p>
    </div>
  )
}

export function TicketDetailPanel({ ticket, onClose }: Props) {
  const updateTicket = useUpdateTicket()
  const addComment = useAddComment()
  const [commentText, setCommentText] = useState('')
  const [isInternal, setIsInternal] = useState(true)
  const [copied, setCopied] = useState(false)

  const tenantName = ticket.tenant
    ? ticket.tenant.type === 'INDIVIDUAL'
      ? `${ticket.tenant.firstName ?? ''} ${ticket.tenant.lastName ?? ''}`.trim()
      : (ticket.tenant.companyName ?? '')
    : null

  const handleStatusTransition = async (newStatus: MaintenanceTicket['status']) => {
    await updateTicket.mutateAsync({ id: ticket.id, dto: { status: newStatus } })
  }

  const handleAddComment = async () => {
    if (!commentText.trim()) return
    await addComment.mutateAsync({ id: ticket.id, content: commentText.trim(), isInternal })
    setCommentText('')
  }

  const portalUrl = ticket.tenantToken
    ? `${window.location.origin}/portal/${ticket.tenantToken}`
    : null

  const handleCopyLink = () => {
    if (!portalUrl) return
    void navigator.clipboard.writeText(portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <motion.aside
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="flex h-full w-[420px] flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-[#EAEDF0] px-5 py-4">
        <div className="min-w-0 flex-1 pr-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold text-gray-400">{ticket.ticketNumber}</span>
            <MaintenanceStatusBadge status={ticket.status} />
          </div>
          <h3 className="text-[15px] font-semibold leading-snug text-gray-900">{ticket.title}</h3>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <InfoItem label="Fastighet" value={ticket.property.name} />
          <InfoItem label="Enhet" value={ticket.unit?.name ?? '—'} />
          <InfoItem label="Hyresgäst" value={tenantName ?? '—'} />
          <InfoItem
            label="Kategori"
            value={<MaintenanceCategoryLabel category={ticket.category} />}
          />
          <InfoItem
            label="Prioritet"
            value={<MaintenancePriorityBadge priority={ticket.priority} />}
          />
          <InfoItem label="Rapporterad" value={formatDate(ticket.createdAt)} />
          {ticket.scheduledDate && (
            <InfoItem label="Schemalagt" value={formatDate(ticket.scheduledDate)} />
          )}
          {ticket.estimatedCost != null && (
            <InfoItem
              label="Beräknad kostnad"
              value={formatCurrency(Number(ticket.estimatedCost))}
            />
          )}
          {ticket.actualCost != null && (
            <InfoItem label="Faktisk kostnad" value={formatCurrency(Number(ticket.actualCost))} />
          )}
          {ticket.completedAt && (
            <InfoItem label="Åtgärdad" value={formatDate(ticket.completedAt)} />
          )}
        </div>

        {/* Description */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Beskrivning
          </p>
          <p className="text-[13px] leading-relaxed text-gray-700">{ticket.description}</p>
        </div>

        {/* Status actions */}
        {(ticket.status === 'NEW' ||
          ticket.status === 'IN_PROGRESS' ||
          ticket.status === 'SCHEDULED' ||
          ticket.status === 'COMPLETED') && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Åtgärder
            </p>
            <div className="flex flex-wrap gap-2">
              {ticket.status === 'NEW' && (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={updateTicket.isPending}
                    onClick={() => void handleStatusTransition('IN_PROGRESS')}
                  >
                    Påbörja
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={updateTicket.isPending}
                    onClick={() => void handleStatusTransition('SCHEDULED')}
                  >
                    Schemalägg
                  </Button>
                </>
              )}
              {(ticket.status === 'IN_PROGRESS' || ticket.status === 'SCHEDULED') && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={updateTicket.isPending}
                  onClick={() => void handleStatusTransition('COMPLETED')}
                >
                  Markera åtgärdad
                </Button>
              )}
              {ticket.status === 'COMPLETED' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={updateTicket.isPending}
                  onClick={() => void handleStatusTransition('CLOSED')}
                >
                  Stäng ärende
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-gray-400"
                loading={updateTicket.isPending}
                onClick={() => void handleStatusTransition('CANCELLED')}
              >
                Avbryt ärende
              </Button>
            </div>
          </div>
        )}

        {/* Tenant portal link */}
        {portalUrl && (
          <div className="rounded-xl border border-[#EAEDF0] bg-gray-50/60 p-3.5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Hyresgästlänk
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-gray-500">
                {portalUrl}
              </code>
              <button
                onClick={handleCopyLink}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                {copied ? (
                  <Check size={12} className="text-emerald-500" />
                ) : (
                  <Copy size={12} strokeWidth={1.8} />
                )}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Dela med hyresgästen så kan de följa ärendets status
            </p>
          </div>
        )}

        {/* Comments */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Kommentarer ({ticket.comments.length})
          </p>
          <div className="space-y-2.5">
            {ticket.comments.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'rounded-xl px-3.5 py-2.5 text-[13px]',
                  c.isInternal
                    ? 'border border-amber-100 bg-amber-50/70'
                    : 'border border-[#EAEDF0] bg-white',
                )}
              >
                <div className="mb-0.5 flex items-center gap-1.5">
                  {c.isInternal ? (
                    <Lock size={10} className="text-amber-500" strokeWidth={2} />
                  ) : (
                    <Globe size={10} className="text-blue-500" strokeWidth={2} />
                  )}
                  <span className="text-[11px] text-gray-400">{formatDate(c.createdAt)}</span>
                </div>
                <p className="leading-relaxed text-gray-700">{c.content}</p>
              </div>
            ))}
          </div>

          {/* Add comment */}
          <div className="mt-3 space-y-2">
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              rows={2}
              placeholder="Lägg till kommentar..."
              className="w-full rounded-lg border border-[#DDDFE4] px-3 py-2 text-[13px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-gray-600">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600"
                />
                <Lock size={11} strokeWidth={2} className="text-amber-500" />
                Intern kommentar
              </label>
              <Button
                size="sm"
                variant="primary"
                disabled={!commentText.trim()}
                loading={addComment.isPending}
                onClick={() => void handleAddComment()}
              >
                <MessageSquare size={12} strokeWidth={1.8} />
                Kommentera
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.aside>
  )
}
