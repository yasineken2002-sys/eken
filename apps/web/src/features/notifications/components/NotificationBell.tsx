import { useRef, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  useUnreadCount,
  useNotifications,
  useMarkNotificationRead,
  useMarkAllRead,
} from '../hooks/useNotifications'
import type { Route } from '@/App'
import type { Notification, NotificationType } from '../api/notifications.api'

interface Props {
  onNavigate: (r: Route) => void
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

const TYPE_ICON: Record<NotificationType, { icon: React.ElementType; color: string }> = {
  INVOICE_PAID: { icon: CheckCircle2, color: 'text-emerald-600' },
  INVOICE_OVERDUE: { icon: AlertCircle, color: 'text-red-600' },
  MAINTENANCE_NEW: { icon: Wrench, color: 'text-amber-600' },
  MAINTENANCE_UPDATED: { icon: Wrench, color: 'text-emerald-600' },
  LEASE_EXPIRING: { icon: Clock, color: 'text-amber-600' },
  LEASE_EXPIRED: { icon: Clock, color: 'text-red-600' },
  RENT_NOTICE_SENT: { icon: Receipt, color: 'text-blue-600' },
  RENT_NOTICE_OVERDUE: { icon: AlertTriangle, color: 'text-orange-600' },
  INSPECTION_SCHEDULED: { icon: ClipboardCheck, color: 'text-purple-600' },
  SYSTEM: { icon: Info, color: 'text-gray-400' },
}

function NotificationRow({
  notification,
  onRead,
}: {
  notification: Notification
  onRead: (id: string) => void
}) {
  const { icon: Icon, color } = TYPE_ICON[notification.type] ?? {
    icon: Bell,
    color: 'text-gray-400',
  }

  return (
    <div
      className={cn(
        'flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50/80',
        !notification.read && 'border-l-2 border-blue-500 bg-blue-50/30',
      )}
      onClick={() => onRead(notification.id)}
    >
      <div className={cn('mt-0.5 flex-shrink-0', color)}>
        <Icon size={14} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[13px]',
            notification.read ? 'font-normal text-gray-700' : 'font-semibold text-gray-900',
          )}
        >
          {notification.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-gray-500">{notification.message}</p>
        <p className="mt-1 text-[11px] text-gray-400">{timeAgo(notification.createdAt)}</p>
      </div>
    </div>
  )
}

export function NotificationBell({ onNavigate }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: countData } = useUnreadCount()
  const { data: notifications = [] } = useNotifications()
  const markOne = useMarkNotificationRead()
  const markAll = useMarkAllRead()

  const unreadCount = countData?.unread ?? 0

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleRead(id: string) {
    const n = notifications.find((x) => x.id === id)
    if (!n?.read) markOne.mutate(id)
    if (n?.link) {
      setOpen(false)
      onNavigate(n.link as Route)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-xl text-gray-500 transition-colors hover:bg-gray-100"
        aria-label="Notifikationer"
      >
        <Bell size={15} strokeWidth={1.8} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute right-0 top-10 z-50 w-80 rounded-2xl border border-[#EAEDF0] bg-white shadow-lg"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#EAEDF0] px-4 py-3">
              <span className="text-[14px] font-semibold text-gray-900">Notifikationer</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAll.mutate()}
                    className="text-[12px] text-blue-600 hover:text-blue-700"
                  >
                    Markera alla lästa
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            </div>

            {/* List */}
            <div className="max-h-[380px] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <BellOff size={24} strokeWidth={1.5} className="text-gray-300" />
                  <p className="text-[13px] font-medium text-gray-500">Inga notifikationer</p>
                  <p className="text-[12px] text-gray-400">Du är à jour!</p>
                </div>
              ) : (
                <div className="divide-y divide-[#EAEDF0]">
                  {notifications.map((n) => (
                    <NotificationRow key={n.id} notification={n} onRead={handleRead} />
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && (
              <div className="border-t border-[#EAEDF0] px-4 py-2.5">
                <button
                  onClick={() => {
                    setOpen(false)
                    onNavigate('notifications')
                  }}
                  className="w-full rounded-lg py-1.5 text-center text-[13px] text-blue-600 transition-colors hover:bg-blue-50"
                >
                  Visa alla
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
