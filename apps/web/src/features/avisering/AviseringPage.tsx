import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FileText,
  Send,
  CheckCircle2,
  Download,
  Plus,
  AlertCircle,
  Clock,
  DollarSign,
  Mail,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { RentNoticeBadge } from './components/RentNoticeBadge'
import { GenerateModal } from './components/GenerateModal'
import { MarkPaidModal } from './components/MarkPaidModal'
import {
  useNotices,
  useNoticeStats,
  useSendNotices,
  useSendAllNotices,
  useDownloadPdf,
} from './hooks/useAvisering'
import { formatDate, formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { RentNotice, NoticeFilter, RentNoticeStatus } from './api/avisering.api'

const MONTHS = [
  'Januari',
  'Februari',
  'Mars',
  'April',
  'Maj',
  'Juni',
  'Juli',
  'Augusti',
  'September',
  'Oktober',
  'November',
  'December',
]

const STATUS_TABS: { value: RentNoticeStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Alla' },
  { value: 'PENDING', label: 'Väntande' },
  { value: 'SENT', label: 'Skickade' },
  { value: 'PAID', label: 'Betalda' },
  { value: 'OVERDUE', label: 'Försenade' },
]

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
}

function tenantName(notice: RentNotice): string {
  if (notice.tenant.type === 'INDIVIDUAL') {
    return (
      `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim() ||
      notice.tenant.email
    )
  }
  return notice.tenant.companyName ?? notice.tenant.email
}

export function AviseringPage() {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [statusTab, setStatusTab] = useState<RentNoticeStatus | 'ALL'>('ALL')
  const [generateOpen, setGenerateOpen] = useState(false)
  const [markPaidNotice, setMarkPaidNotice] = useState<RentNotice | null>(null)

  const filter: NoticeFilter = {
    month,
    year,
    ...(statusTab !== 'ALL' ? { status: statusTab } : {}),
  }

  const { data: notices = [], isLoading } = useNotices(filter)
  const { data: stats } = useNoticeStats(month, year)
  const sendNotices = useSendNotices()
  const sendAll = useSendAllNotices()
  const downloadPdf = useDownloadPdf()

  const currentYear = now.getFullYear()
  const years = [currentYear - 1, currentYear, currentYear + 1]

  return (
    <PageWrapper id="avisering">
      <div>
        <PageHeader
          title="Hyresavier"
          description={`${stats?.total ?? 0} avier för ${MONTHS[month - 1]} ${year}`}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={sendAll.isPending || notices.length === 0}
                loading={sendAll.isPending}
                onClick={() => void sendAll.mutateAsync({ month, year })}
              >
                <Mail size={13} strokeWidth={1.8} />
                Skicka alla
              </Button>
              <Button variant="primary" onClick={() => setGenerateOpen(true)}>
                <Plus size={14} strokeWidth={2} />
                Generera avier
              </Button>
            </div>
          }
        />

        {/* Period selector */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-[13px] text-gray-500">Period:</span>
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value, 10))}
            className="h-8 rounded-lg border border-[#DDDFE4] px-3 text-[13px] text-gray-700 focus:border-blue-500 focus:outline-none"
          >
            {MONTHS.map((m, i) => (
              <option key={i + 1} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="h-8 rounded-lg border border-[#DDDFE4] px-3 text-[13px] text-gray-700 focus:border-blue-500 focus:outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        {/* KPI Cards */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Totalt att fakturera"
            value={formatCurrency(stats?.totalAmount ?? 0)}
            icon={DollarSign}
            iconColor="#2563EB"
            delay={0}
          />
          <StatCard
            title="Inkasserat"
            value={formatCurrency(stats?.paidAmount ?? 0)}
            icon={CheckCircle2}
            iconColor="#059669"
            delay={0.04}
          />
          <StatCard
            title="Utestående"
            value={formatCurrency(stats?.outstandingAmount ?? 0)}
            icon={Clock}
            iconColor={(stats?.outstandingAmount ?? 0) > 0 ? '#D97706' : '#6B7280'}
            delay={0.08}
          />
          <StatCard
            title="Försenade"
            value={stats?.overdue ?? 0}
            icon={AlertCircle}
            iconColor={(stats?.overdue ?? 0) > 0 ? '#DC2626' : '#6B7280'}
            delay={0.12}
          />
        </div>

        {/* Status tabs */}
        <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusTab(tab.value)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                statusTab === tab.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="mt-4 overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
          {isLoading ? (
            <div className="py-16 text-center text-[13px] text-gray-400">Laddar avier...</div>
          ) : notices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Inga hyresavier"
              description={`Generera avier för ${MONTHS[month - 1]} ${year} för att komma igång`}
              action={
                <Button variant="primary" onClick={() => setGenerateOpen(true)}>
                  <Plus size={14} strokeWidth={2} />
                  Generera avier
                </Button>
              }
            />
          ) : (
            <motion.div variants={container} initial="hidden" animate="show">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#EAEDF0]">
                    {[
                      'OCR-nummer',
                      'Hyresgäst',
                      'Fastighet/Enhet',
                      'Belopp',
                      'Förfaller',
                      'Status',
                      'Åtgärder',
                    ].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notices.map((notice) => (
                    <motion.tr
                      key={notice.id}
                      variants={item}
                      className="border-b border-[#EAEDF0] transition-colors last:border-0 hover:bg-gray-50/80"
                    >
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-blue-50 px-2 py-0.5 font-mono text-[12px] font-semibold text-blue-700">
                          {notice.ocrNumber}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-[13px] font-medium text-gray-900">
                          {tenantName(notice)}
                        </p>
                        <p className="text-[11.5px] text-gray-400">{notice.tenant.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-[13px] font-medium text-gray-800">
                          {notice.lease?.unit?.property?.name}
                        </p>
                        <p className="text-[11.5px] text-gray-400">{notice.lease?.unit?.name}</p>
                      </td>
                      <td className="px-4 py-3 text-[13px] font-medium text-gray-900">
                        {formatCurrency(Number(notice.totalAmount))}
                      </td>
                      <td className="px-4 py-3 text-[12.5px] text-gray-500">
                        {formatDate(notice.dueDate)}
                      </td>
                      <td className="px-4 py-3">
                        <RentNoticeBadge status={notice.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {notice.status === 'PENDING' && (
                            <button
                              title="Skicka avi"
                              disabled={sendNotices.isPending}
                              onClick={() => void sendNotices.mutateAsync([notice.id])}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                            >
                              <Send size={12} strokeWidth={1.8} />
                            </button>
                          )}
                          {(notice.status === 'SENT' || notice.status === 'OVERDUE') && (
                            <button
                              title="Markera betald"
                              onClick={() => setMarkPaidNotice(notice)}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600"
                            >
                              <CheckCircle2 size={12} strokeWidth={1.8} />
                            </button>
                          )}
                          <button
                            title="Ladda ner PDF"
                            disabled={downloadPdf.isPending}
                            onClick={() =>
                              void downloadPdf.mutateAsync({
                                id: notice.id,
                                noticeNumber: notice.noticeNumber,
                              })
                            }
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                          >
                            <Download size={12} strokeWidth={1.8} />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {generateOpen && (
          <GenerateModal
            open={generateOpen}
            month={month}
            year={year}
            onClose={() => setGenerateOpen(false)}
            onSuccess={() => {}}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {markPaidNotice && (
          <MarkPaidModal
            notice={markPaidNotice}
            onClose={() => setMarkPaidNotice(null)}
            onSuccess={() => setMarkPaidNotice(null)}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
