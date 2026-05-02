import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  MessageSquare,
  Send,
  Users,
  User,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Mail,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useMessages, useMessageStats, useSendMessage, useRetryMessage } from './hooks/useMessages'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { cn } from '@/lib/cn'
import type { SentMessage } from './api/messages.api'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const itemAnim = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

type RecipientMode = 'all' | 'specific'
type HistoryFilter = 'all' | 'SENT' | 'FAILED' | 'PARTIAL'

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just nu'
  if (mins < 60) return `${mins} min sedan`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} tim sedan`
  const days = Math.floor(hours / 24)
  return `${days} dag${days !== 1 ? 'ar' : ''} sedan`
}

function tenantDisplayName(
  tenant: { firstName: string | null; lastName: string | null; companyName: string | null } | null,
): string {
  if (!tenant) return 'Okänd'
  if (tenant.companyName) return tenant.companyName
  return `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim() || 'Okänd'
}

function StatusBadge({ status }: { status: SentMessage['status'] }) {
  const map = {
    SENT: {
      label: 'Skickat',
      bg: 'bg-emerald-50',
      text: 'text-emerald-700',
      dot: 'bg-emerald-500',
    },
    FAILED: { label: 'Misslyckades', bg: 'bg-red-50', text: 'text-red-600', dot: 'bg-red-500' },
    PARTIAL: {
      label: 'Delvis skickat',
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      dot: 'bg-amber-500',
    },
  }[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        map.bg,
        map.text,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', map.dot)} />
      {map.label}
    </span>
  )
}

function MessageCard({
  msg,
  onRetry,
  retrying,
}: {
  msg: SentMessage
  onRetry: (id: string) => void
  retrying: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const errors = Array.isArray(msg.errorLog) ? msg.errorLog : []

  return (
    <motion.div
      variants={itemAnim}
      className="rounded-2xl border border-[#EAEDF0] bg-white transition-shadow hover:shadow-sm"
    >
      <button className="w-full p-4 text-left" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-start justify-between gap-3">
          <p className="flex-1 truncate text-[13.5px] font-semibold text-gray-900">{msg.subject}</p>
          <div className="flex flex-shrink-0 items-center gap-2">
            <StatusBadge status={msg.status} />
            {expanded ? (
              <ChevronUp size={14} className="text-gray-400" />
            ) : (
              <ChevronDown size={14} className="text-gray-400" />
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1 text-[13px] text-gray-500">
            {msg.sentToAll ? (
              <Users size={12} strokeWidth={1.8} />
            ) : (
              <User size={12} strokeWidth={1.8} />
            )}
            {msg.sentToAll ? 'Alla hyresgäster' : tenantDisplayName(msg.tenant)}
          </span>
          <span className="flex items-center gap-1 text-[13px] text-gray-500">
            <Clock size={12} strokeWidth={1.8} />
            {relativeTime(msg.createdAt)}
          </span>
        </div>

        {(msg.status === 'SENT' || msg.status === 'PARTIAL') && (
          <p className="mt-1.5 text-[12px] text-gray-400">
            {msg.successCount} av {msg.recipientCount} levererade
          </p>
        )}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-t border-[#EAEDF0]"
          >
            <div className="p-4">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">
                {msg.content}
              </p>

              {errors.length > 0 && (
                <div className="mt-3 rounded-xl bg-red-50 p-3">
                  <p className="mb-2 text-[12px] font-semibold text-red-700">
                    Misslyckade mottagare:
                  </p>
                  {errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-600">
                      {e.email} — {e.error}
                    </p>
                  ))}
                </div>
              )}

              {(msg.status === 'FAILED' || msg.status === 'PARTIAL') && (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRetry(msg.id)}
                    disabled={retrying}
                  >
                    {retrying ? (
                      <span className="flex items-center gap-1.5">
                        <RefreshCw size={12} className="animate-spin" />
                        Försöker igen...
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <RefreshCw size={12} />
                        Försök igen
                      </span>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

interface SendResult {
  type: 'success' | 'partial' | 'failed'
  successCount: number
  recipientCount: number
  errors: Array<{ email: string; error: string }>
  messageId: string
}

export function MessagesPage() {
  const { data: stats } = useMessageStats()
  const { data: messages = [], refetch: refetchMessages } = useMessages()
  const { data: tenants = [] } = useTenants()
  const sendMutation = useSendMessage()
  const retryMutation = useRetryMessage()

  const [mode, setMode] = useState<RecipientMode>('all')
  const [tenantId, setTenantId] = useState('')
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const canSend =
    subject.trim().length > 0 && content.trim().length > 0 && (mode === 'all' || tenantId !== '')

  const selectedTenant = tenants.find((t) => t.id === tenantId)
  const tenantEmail = selectedTenant?.email ?? ''

  const handleSendClick = () => {
    if (mode === 'all') {
      setConfirmOpen(true)
    } else {
      void doSend()
    }
  }

  const doSend = async () => {
    setConfirmOpen(false)
    setSendResult(null)
    const payload =
      mode === 'all' ? { sendToAll: true, subject, content } : { tenantId, subject, content }

    try {
      const msg = await sendMutation.mutateAsync(payload)
      const errors = Array.isArray(msg.errorLog) ? msg.errorLog : []
      setSendResult({
        type: msg.status === 'SENT' ? 'success' : msg.status === 'PARTIAL' ? 'partial' : 'failed',
        successCount: msg.successCount,
        recipientCount: msg.recipientCount,
        errors,
        messageId: msg.id,
      })
      if (msg.status === 'SENT') {
        setSubject('')
        setContent('')
        setTenantId('')
      }
    } catch {
      setSendResult({
        type: 'failed',
        successCount: 0,
        recipientCount: 1,
        errors: [],
        messageId: '',
      })
    }
  }

  const handleRetry = (id: string) => {
    setRetryingId(id)
    retryMutation.mutate(id, {
      onSettled: () => setRetryingId(null),
    })
  }

  const filtered =
    historyFilter === 'all' ? messages : messages.filter((m) => m.status === historyFilter)

  return (
    <PageWrapper id="messages">
      <PageHeader title="Meddelanden" description="Kommunicera direkt med dina hyresgäster" />

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Totalt skickade"
          value={stats?.total ?? 0}
          icon={MessageSquare}
          iconColor="#2563EB"
          delay={0}
        />
        <StatCard
          title="Lyckade"
          value={stats?.sent ?? 0}
          icon={CheckCircle}
          iconColor="#059669"
          delay={0.05}
        />
        <StatCard
          title="Misslyckade"
          value={stats?.failed ?? 0}
          icon={XCircle}
          iconColor="#DC2626"
          delay={0.1}
        />
        <StatCard
          title="Totalt mottagare"
          value={stats?.totalRecipients ?? 0}
          icon={Users}
          iconColor="#7C3AED"
          delay={0.15}
        />
      </div>

      {/* Two columns */}
      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        {/* ── LEFT: Compose ── */}
        <div className="w-full lg:w-[45%]">
          <div className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <h2 className="mb-4 text-[14px] font-semibold text-gray-900">Nytt meddelande</h2>

            {/* Recipient toggle */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                Mottagare
              </label>
              <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
                {(['all', 'specific'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m)
                      setTenantId('')
                      setSendResult(null)
                    }}
                    className={cn(
                      'flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all',
                      mode === m
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700',
                    )}
                  >
                    {m === 'all' ? 'Alla hyresgäster' : 'Specifik hyresgäst'}
                  </button>
                ))}
              </div>

              <div className="mt-2">
                {mode === 'all' ? (
                  tenants.length === 0 ? (
                    <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
                      <AlertTriangle size={13} strokeWidth={1.8} />
                      Inga hyresgäster registrerade
                    </p>
                  ) : (
                    <p className="text-[13px] text-gray-500">
                      Skickas till{' '}
                      <span className="font-semibold text-gray-800">{tenants.length}</span>{' '}
                      hyresgäster
                    </p>
                  )
                ) : (
                  <div>
                    <select
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                      className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Välj hyresgäst...</option>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.companyName ?? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()}
                        </option>
                      ))}
                    </select>
                    {tenantEmail && (
                      <p className="mt-1 flex items-center gap-1 text-[12px] text-gray-500">
                        <Mail size={11} strokeWidth={1.8} />
                        {tenantEmail}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Subject */}
            <div className="mb-4">
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[13px] font-medium text-gray-700">Ämne</label>
                <span className="text-[12px] text-gray-400">{subject.length}/200</span>
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value.slice(0, 200))}
                placeholder="t.ex. Viktig information om fastigheten"
                className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Content */}
            <div className="mb-4">
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[13px] font-medium text-gray-700">Meddelande</label>
                <span className="text-[12px] text-gray-400">{content.length}/5000</span>
              </div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, 5000))}
                placeholder="Skriv ditt meddelande här..."
                rows={8}
                className="w-full resize-none rounded-lg border border-[#DDDFE4] px-3 py-2 text-[13.5px] leading-relaxed focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                style={{ minHeight: 200 }}
              />
            </div>

            {/* Preview toggle */}
            <button
              onClick={() => setPreviewOpen((v) => !v)}
              className="mb-4 flex items-center gap-1.5 text-[13px] font-medium text-blue-600 hover:text-blue-700"
            >
              {previewOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Förhandsgranska e-post
            </button>

            <AnimatePresence>
              {previewOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-4 overflow-hidden"
                >
                  <div className="rounded-xl border border-[#EAEDF0] bg-[#F7F8FA] p-4">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      Förhandsgranskning
                    </p>
                    <p className="mb-1 text-[12px] text-gray-500">
                      <span className="font-medium">Från:</span> Din organisation
                    </p>
                    <p className="mb-3 text-[12px] text-gray-500">
                      <span className="font-medium">Ämne:</span> {subject || '(inget ämne)'}
                    </p>
                    <div className="rounded-lg bg-white p-3 shadow-sm">
                      <p className="text-[13px] font-bold text-blue-600">Din organisation</p>
                      <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">
                        {content || '(inget innehåll)'}
                      </div>
                      <p className="mt-3 text-[12px] text-gray-400">
                        Med vänliga hälsningar, Din organisation
                      </p>
                      <p className="mt-1 text-center text-[11px] text-gray-300">
                        Detta e-postmeddelande skickades via Eveno Fastigheter.
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Result state */}
            <AnimatePresence>
              {sendResult && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mb-4"
                >
                  {sendResult.type === 'success' && (
                    <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3">
                      <CheckCircle size={16} className="flex-shrink-0 text-emerald-600" />
                      <p className="text-[13px] font-medium text-emerald-700">
                        Skickat till {sendResult.successCount} av {sendResult.recipientCount}{' '}
                        mottagare
                      </p>
                    </div>
                  )}
                  {sendResult.type === 'partial' && (
                    <div className="rounded-xl bg-amber-50 p-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={16} className="flex-shrink-0 text-amber-600" />
                        <p className="text-[13px] font-medium text-amber-700">
                          Skickat till {sendResult.successCount}, misslyckades för{' '}
                          {sendResult.recipientCount - sendResult.successCount}
                        </p>
                      </div>
                      {sendResult.errors.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {sendResult.errors.map((e, i) => (
                            <li key={i} className="text-[12px] text-amber-600">
                              {e.email}
                            </li>
                          ))}
                        </ul>
                      )}
                      {sendResult.messageId && (
                        <button
                          onClick={() => handleRetry(sendResult.messageId)}
                          className="mt-2 text-[12px] font-medium text-amber-700 underline"
                        >
                          Försök igen för misslyckade
                        </button>
                      )}
                    </div>
                  )}
                  {sendResult.type === 'failed' && (
                    <div className="flex items-center gap-2 rounded-xl bg-red-50 p-3">
                      <XCircle size={16} className="flex-shrink-0 text-red-600" />
                      <p className="text-[13px] font-medium text-red-700">
                        Kunde inte skicka meddelandet
                      </p>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <Button
              variant="primary"
              onClick={handleSendClick}
              disabled={!canSend || sendMutation.isPending}
              className="w-full"
            >
              {sendMutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <RefreshCw size={14} className="animate-spin" />
                  Skickar...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Send size={14} />
                  Skicka meddelande
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* ── RIGHT: History ── */}
        <div className="w-full lg:w-[55%]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-gray-900">Historik</h2>
            <button
              onClick={() => void refetchMessages()}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <RefreshCw size={13} strokeWidth={1.8} />
            </button>
          </div>

          {/* Filter tabs */}
          <div className="mb-4 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
            {(
              [
                ['all', 'Alla'],
                ['SENT', 'Lyckade'],
                ['FAILED', 'Misslyckade'],
                ['PARTIAL', 'Delvis'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setHistoryFilter(val)}
                className={cn(
                  'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                  historyFilter === val
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="Inga meddelanden skickade"
              description="Börja kommunicera med dina hyresgäster"
            />
          ) : (
            <motion.div variants={container} initial="hidden" animate="show" className="space-y-3">
              {filtered.map((msg) => (
                <MessageCard
                  key={msg.id}
                  msg={msg}
                  onRetry={handleRetry}
                  retrying={retryingId === msg.id && retryMutation.isPending}
                />
              ))}
            </motion.div>
          )}
        </div>
      </div>

      {/* Confirm dialog – send to all */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Bekräfta massutskick">
        <p className="text-[13.5px] text-gray-700">
          Du är på väg att skicka ett meddelande till{' '}
          <span className="font-semibold">{tenants.length} hyresgäster</span>. Vill du fortsätta?
        </p>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={() => void doSend()}>
            Ja, skicka
          </Button>
        </ModalFooter>
      </Modal>
    </PageWrapper>
  )
}
