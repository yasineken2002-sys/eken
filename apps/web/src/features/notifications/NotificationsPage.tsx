import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bell,
  BellOff,
  CheckCircle2,
  AlertCircle,
  Wrench,
  Clock,
  AlertTriangle,
  Receipt,
  ClipboardCheck,
  Info,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useNotifications, useMarkNotificationRead, useMarkAllRead } from './hooks/useNotifications'
import type { Route } from '@/App'
import type { Notification, NotificationType } from './api/notifications.api'

interface Props {
  onNavigate: (r: Route) => void
}

type Tab = 'all' | 'unread'

const TYPE_ICON: Record<NotificationType, { icon: React.ElementType; color: string; bg: string }> =
  {
    INVOICE_PAID: { icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    INVOICE_OVERDUE: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50' },
    MAINTENANCE_NEW: { icon: Wrench, color: 'text-amber-600', bg: 'bg-amber-50' },
    MAINTENANCE_UPDATED: { icon: Wrench, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    LEASE_EXPIRING: { icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
    LEASE_EXPIRED: { icon: Clock, color: 'text-red-600', bg: 'bg-red-50' },
    RENT_NOTICE_SENT: { icon: Receipt, color: 'text-blue-600', bg: 'bg-blue-50' },
    RENT_NOTICE_OVERDUE: { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50' },
    INSPECTION_SCHEDULED: { icon: ClipboardCheck, color: 'text-purple-600', bg: 'bg-purple-50' },
    SYSTEM: { icon: Info, color: 'text-gray-500', bg: 'bg-gray-50' },
  }

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just nu'
  if (m < 60) return `${m} min sedan`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h sedan`
  return `${Math.floor(h / 24)} d sedan`
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
}

function NotificationRow({
  notification,
  onRead,
  onNavigate,
}: {
  notification: Notification
  onRead: (id: string) => void
  onNavigate: (r: Route) => void
}) {
  const {
    icon: Icon,
    color,
    bg,
  } = TYPE_ICON[notification.type] ?? { icon: Bell, color: 'text-gray-400', bg: 'bg-gray-50' }

  function handleClick() {
    if (!notification.read) onRead(notification.id)
    if (notification.link) onNavigate(notification.link as Route)
  }

  return (
    <motion.div
      variants={item}
      onClick={handleClick}
      className={cn(
        'flex cursor-pointer items-start gap-4 px-5 py-4 transition-colors hover:bg-gray-50/80',
        'border-b border-[#EAEDF0] last:border-0',
        !notification.read && 'border-l-2 border-blue-500 bg-blue-50/20',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl',
          bg,
          color,
        )}
      >
        <Icon size={15} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-[13.5px]',
            notification.read ? 'font-normal text-gray-700' : 'font-semibold text-gray-900',
          )}
        >
          {notification.title}
        </p>
        <p className="mt-0.5 text-[13px] text-gray-500">{notification.message}</p>
        <p className="mt-1.5 text-[12px] text-gray-400">{timeAgo(notification.createdAt)}</p>
      </div>
      {!notification.read && (
        <div className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-500" />
      )}
    </motion.div>
  )
}

export function NotificationsPage({ onNavigate }: Props) {
  const [tab, setTab] = useState<Tab>('all')
  const { data: notifications = [], isLoading } = useNotifications(tab === 'unread')
  const markOne = useMarkNotificationRead()
  const markAll = useMarkAllRead()

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2 }}
      className="mx-auto max-w-2xl px-6 py-6"
    >
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">Notifikationer</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Händelser och uppdateringar för din organisation
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-[#DDDFE4] bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <Check size={13} strokeWidth={2} />
            Markera alla lästa
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="mb-4 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {(['all', 'unread'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t === 'all' ? 'Alla' : 'Olästa'}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="border-b border-[#EAEDF0] px-5 py-4 last:border-0">
              <div className="flex items-start gap-4">
                <div className="h-8 w-8 animate-pulse rounded-xl bg-gray-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-gray-100" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-gray-100" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-[#EAEDF0] bg-white py-16 text-center">
          <BellOff size={28} strokeWidth={1.5} className="text-gray-300" />
          <p className="text-[14px] font-semibold text-gray-500">Inga notifikationer</p>
          <p className="text-[13px] text-gray-400">Du är à jour!</p>
        </div>
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white"
        >
          {notifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              onRead={(id) => markOne.mutate(id)}
              onNavigate={onNavigate}
            />
          ))}
        </motion.div>
      )}
    </motion.div>
  )
}
