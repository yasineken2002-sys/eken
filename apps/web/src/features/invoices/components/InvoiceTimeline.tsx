import { motion } from 'framer-motion'
import {
  FileText,
  Send,
  CheckCircle2,
  Eye,
  FileSearch,
  CircleDollarSign,
  AlertCircle,
  Bell,
  XCircle,
  Mail,
  MailX,
  MailWarning,
  MessageSquare,
  Clock,
  RefreshCcw,
  Gavel,
  FileMinus,
  Info,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { InvoiceEvent, InvoiceEventType } from '@eken/shared'
import { cn } from '@/lib/cn'

// ─── Metadata per händelsetyp ─────────────────────────────────────────────────

interface EventMeta {
  label: string
  icon: LucideIcon
  iconColor: string
  dotColor: string
  /** Om true: visa "mjuk signal"-tooltip (Apple Mail pre-fetch etc.) */
  isSoftSignal?: boolean
}

const EVENT_META: Record<InvoiceEventType, EventMeta> = {
  'invoice.created': {
    label: 'Faktura skapad',
    icon: FileText,
    iconColor: 'text-gray-500',
    dotColor: 'bg-gray-100',
  },
  'invoice.updated': {
    label: 'Faktura uppdaterad',
    icon: FileText,
    iconColor: 'text-gray-500',
    dotColor: 'bg-gray-100',
  },
  'invoice.sent': {
    label: 'Faktura skickad',
    icon: Send,
    iconColor: 'text-blue-600',
    dotColor: 'bg-blue-50',
  },
  'invoice.send_failed': {
    label: 'Utskick misslyckades',
    icon: MailX,
    iconColor: 'text-red-600',
    dotColor: 'bg-red-50',
  },
  'invoice.email_queued': {
    label: 'E-post köad',
    icon: Clock,
    iconColor: 'text-gray-400',
    dotColor: 'bg-gray-100',
  },
  'invoice.email_delivered': {
    label: 'E-post levererad',
    icon: CheckCircle2,
    iconColor: 'text-emerald-600',
    dotColor: 'bg-emerald-50',
  },
  'invoice.email_bounced': {
    label: 'E-post studsade',
    icon: MailX,
    iconColor: 'text-red-600',
    dotColor: 'bg-red-50',
  },
  'invoice.email_spam': {
    label: 'Markerad som skräppost',
    icon: MailWarning,
    iconColor: 'text-amber-600',
    dotColor: 'bg-amber-50',
  },
  'invoice.email_opened': {
    label: 'E-post sannolikt öppnad',
    icon: Mail,
    iconColor: 'text-blue-500',
    dotColor: 'bg-blue-50',
    isSoftSignal: true,
  },
  'invoice.pdf_viewed': {
    label: 'PDF öppnad',
    icon: FileSearch,
    iconColor: 'text-indigo-600',
    dotColor: 'bg-indigo-50',
  },
  'invoice.payment_received': {
    label: 'Betalning registrerad',
    icon: CircleDollarSign,
    iconColor: 'text-emerald-600',
    dotColor: 'bg-emerald-50',
  },
  'invoice.payment_partial': {
    label: 'Delbetald',
    icon: CircleDollarSign,
    iconColor: 'text-amber-600',
    dotColor: 'bg-amber-50',
  },
  'invoice.payment_reversed': {
    label: 'Betalning återförd',
    icon: RefreshCcw,
    iconColor: 'text-red-600',
    dotColor: 'bg-red-50',
  },
  'invoice.overdue': {
    label: 'Förfallen',
    icon: AlertCircle,
    iconColor: 'text-red-600',
    dotColor: 'bg-red-50',
  },
  'invoice.reminder_sent': {
    label: 'Påminnelse skickad',
    icon: Bell,
    iconColor: 'text-amber-600',
    dotColor: 'bg-amber-50',
  },
  'invoice.debt_collection': {
    label: 'Skickad till inkasso',
    icon: Gavel,
    iconColor: 'text-red-700',
    dotColor: 'bg-red-50',
  },
  'invoice.voided': {
    label: 'Makulerad',
    icon: XCircle,
    iconColor: 'text-red-600',
    dotColor: 'bg-red-50',
  },
  'invoice.credit_note_created': {
    label: 'Kreditnota skapad',
    icon: FileMinus,
    iconColor: 'text-gray-600',
    dotColor: 'bg-gray-100',
  },
  'invoice.note_added': {
    label: 'Notering tillagd',
    icon: MessageSquare,
    iconColor: 'text-gray-600',
    dotColor: 'bg-gray-100',
  },
  'invoice.viewed_by_user': {
    label: 'Öppnad av handläggare',
    icon: Eye,
    iconColor: 'text-gray-400',
    dotColor: 'bg-gray-100',
  },
}

// ─── Händelse-payload ─────────────────────────────────────────────────────────

function EventDetail({ event }: { event: InvoiceEvent }) {
  const p = event.payload as Record<string, unknown>

  if (event.type === 'invoice.payment_received' || event.type === 'invoice.payment_partial') {
    return (
      <p className="mt-0.5 text-[12px] text-gray-500">
        {typeof p.amount === 'number'
          ? new Intl.NumberFormat('sv-SE', {
              style: 'currency',
              currency: 'SEK',
              minimumFractionDigits: 0,
            }).format(p.amount)
          : ''}
        {p.paymentMethod ? ` · ${p.paymentMethod}` : ''}
        {p.reference ? ` · OCR ${p.reference}` : ''}
      </p>
    )
  }

  if (event.type === 'invoice.email_bounced' || event.type === 'invoice.send_failed') {
    return (
      <p className="mt-0.5 text-[12px] text-red-500">
        {typeof p.detail === 'string' ? p.detail : typeof p.reason === 'string' ? p.reason : ''}
      </p>
    )
  }

  if (event.type === 'invoice.overdue') {
    return (
      <p className="mt-0.5 text-[12px] text-red-500">
        {typeof p.daysOverdue === 'number'
          ? `${p.daysOverdue} dag${p.daysOverdue !== 1 ? 'ar' : ''} försenad`
          : ''}
      </p>
    )
  }

  if (event.type === 'invoice.sent' && typeof p.email === 'string') {
    return <p className="mt-0.5 text-[12px] text-gray-500">{p.email}</p>
  }

  return null
}

// ─── Stagger animation ────────────────────────────────────────────────────────

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}
const item = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.18 } },
}

// ─── Formatera datum med tid ──────────────────────────────────────────────────

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))
}

// ─── Komponent ────────────────────────────────────────────────────────────────

interface InvoiceTimelineProps {
  events: InvoiceEvent[]
}

export function InvoiceTimeline({ events }: InvoiceTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <p className="text-[13px] text-gray-400">Ingen historik ännu</p>
      </div>
    )
  }

  return (
    <div className="relative pl-6">
      {/* Vertikal linje */}
      <div className="absolute bottom-3 left-[10px] top-3 w-px bg-[#EAEDF0]" />

      <motion.div variants={container} initial="hidden" animate="show" className="space-y-3">
        {events.map((event) => {
          const meta = EVENT_META[event.type] ?? {
            label: event.type,
            icon: FileText,
            iconColor: 'text-gray-400',
            dotColor: 'bg-gray-100',
          }
          const Icon = meta.icon

          return (
            <motion.div key={event.id} variants={item} className="relative flex gap-3">
              {/* Ikon-dot */}
              <div
                className={cn(
                  'relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                  'border border-gray-100',
                  meta.dotColor,
                )}
              >
                <Icon size={11} strokeWidth={2} className={meta.iconColor} />
              </div>

              {/* Innehåll */}
              <div className="flex-1 pb-2 pt-0.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium text-gray-900">{meta.label}</span>
                    {meta.isSoftSignal && (
                      <span title="Apple Mail och Gmail kan pre-fetcha e-postpixlar – detta är en indikation, inte en garanti.">
                        <Info size={11} className="cursor-help text-gray-300" />
                      </span>
                    )}
                  </div>
                  <time className="shrink-0 text-[11.5px] tabular-nums text-gray-400">
                    {formatDateTime(event.createdAt)}
                  </time>
                </div>

                {/* Aktör */}
                {event.actorLabel &&
                  event.type !== 'invoice.email_delivered' &&
                  event.type !== 'invoice.email_queued' && (
                    <p className="text-[12px] text-gray-400">{event.actorLabel}</p>
                  )}

                {/* Händelsespecifik detalj */}
                <EventDetail event={event} />
              </div>
            </motion.div>
          )
        })}
      </motion.div>
    </div>
  )
}
