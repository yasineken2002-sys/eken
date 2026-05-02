import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Wrench, Send, CheckCircle2, Clock, AlertCircle } from 'lucide-react'
import { get, post } from '@/lib/api'
import { formatDate } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { MaintenanceStatusBadge } from '@/features/maintenance/components/MaintenanceBadges'
import type { MaintenanceTicket } from '@/features/maintenance/api/maintenance.api'

interface Props {
  token: string
}

export function TenantPortalPage({ token }: Props) {
  const [commentText, setCommentText] = useState('')

  const {
    data: ticket,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['tenant-portal', token],
    queryFn: () => get<MaintenanceTicket>(`/maintenance/tenant/${token}`),
    retry: false,
  })

  const addComment = useMutation({
    mutationFn: (content: string) =>
      post<MaintenanceTicket>(`/maintenance/tenant/${token}/comment`, { content }),
    onSuccess: () => {
      setCommentText('')
      void refetch()
    },
  })

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F8FA]">
        <div className="text-[13px] text-gray-400">Laddar ärende...</div>
      </div>
    )
  }

  if (isError || !ticket) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#F7F8FA] px-4">
        <AlertCircle size={40} className="mb-4 text-gray-300" strokeWidth={1.4} />
        <p className="text-[16px] font-semibold text-gray-700">Ärende hittades inte</p>
        <p className="mt-1 text-[13.5px] text-gray-400">Länken är ogiltig eller har upphört.</p>
      </div>
    )
  }

  const statusIcon =
    ticket.status === 'COMPLETED' || ticket.status === 'CLOSED' ? (
      <CheckCircle2 size={18} className="text-emerald-500" strokeWidth={1.8} />
    ) : (
      <Clock size={18} className="text-amber-500" strokeWidth={1.8} />
    )

  return (
    <div className="min-h-screen bg-[#F7F8FA] py-10">
      <div className="mx-auto max-w-[600px] px-4">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 flex items-center gap-2"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600">
            <Wrench size={14} className="text-white" strokeWidth={2} />
          </div>
          <span className="text-[15px] font-bold text-gray-900">Eveno Fastigheter</span>
        </motion.div>

        {/* Ticket card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="rounded-2xl border border-[#EAEDF0] bg-white p-6 shadow-sm"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {ticket.ticketNumber}
              </p>
              <h1 className="text-[18px] font-semibold text-gray-900">{ticket.title}</h1>
            </div>
            <div className="flex items-center gap-1.5">
              {statusIcon}
              <MaintenanceStatusBadge status={ticket.status} />
            </div>
          </div>

          <p className="mb-5 text-[13.5px] leading-relaxed text-gray-600">{ticket.description}</p>

          <div className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Fastighet
              </p>
              <p className="mt-0.5 text-[13px] font-medium text-gray-800">{ticket.property.name}</p>
            </div>
            {ticket.unit && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Enhet
                </p>
                <p className="mt-0.5 text-[13px] font-medium text-gray-800">{ticket.unit.name}</p>
              </div>
            )}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Rapporterad
              </p>
              <p className="mt-0.5 text-[13px] font-medium text-gray-800">
                {formatDate(ticket.createdAt)}
              </p>
            </div>
            {ticket.scheduledDate && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Schemalagt
                </p>
                <p className="mt-0.5 text-[13px] font-medium text-gray-800">
                  {formatDate(ticket.scheduledDate)}
                </p>
              </div>
            )}
          </div>

          {/* Public comments */}
          {ticket.comments.length > 0 && (
            <div className="mt-5">
              <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Meddelanden
              </p>
              <div className="space-y-2">
                {ticket.comments.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-xl border border-[#EAEDF0] bg-white px-3.5 py-2.5"
                  >
                    <p className="mb-0.5 text-[11px] text-gray-400">{formatDate(c.createdAt)}</p>
                    <p className="text-[13px] leading-relaxed text-gray-700">{c.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add comment */}
          {ticket.status !== 'CLOSED' && ticket.status !== 'CANCELLED' && (
            <div className="mt-5">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Skicka meddelande
              </p>
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={3}
                placeholder="Skriv ett meddelande till fastighetsägaren..."
                className="w-full rounded-xl border border-[#DDDFE4] px-3.5 py-2.5 text-[13px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="mt-2.5 flex justify-end">
                <Button
                  variant="primary"
                  disabled={!commentText.trim()}
                  loading={addComment.isPending}
                  onClick={() => void addComment.mutateAsync(commentText.trim())}
                >
                  <Send size={13} strokeWidth={1.8} />
                  Skicka
                </Button>
              </div>
            </div>
          )}
        </motion.div>

        <p className="mt-6 text-center text-[12px] text-gray-400">
          Powered by Eveno Fastighetsförvaltning
        </p>
      </div>
    </div>
  )
}
