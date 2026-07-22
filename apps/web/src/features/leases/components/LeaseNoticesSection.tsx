import { useQuery } from '@tanstack/react-query'
import {
  fetchNotices,
  downloadNoticePdf,
  type RentNotice,
} from '@/features/avisering/api/avisering.api'
import { Button } from '@/components/ui/Button'
import { Download, Receipt, ShieldCheck, Info } from 'lucide-react'
import { formatCurrency, formatDate } from '@eken/shared'

interface Props {
  leaseId: string
  startDate: string
}

interface NoticeWithType extends RentNotice {
  type?: 'RENT' | 'DEPOSIT'
  isProrated?: boolean
  daysCharged?: number | null
  totalDays?: number | null
  periodStart?: string | null
  periodEnd?: string | null
}

// Visa de avier som auto-genererats för detta kontrakt: deposition + första
// hyresavi vid aktivering. När månadscronen kör läggs framtida månader till
// här efter hand. För DRAFT-kontrakt visas en informativ text om vad som
// händer vid aktivering, så administratören vet att flödet är automatiskt.
export function LeaseNoticesSection({ leaseId, startDate }: Props) {
  const { data: allNotices } = useQuery({
    queryKey: ['avisering', 'list-by-lease', leaseId],
    queryFn: () => fetchNotices(),
    staleTime: 30_000,
  })

  const notices = (allNotices ?? []).filter((n) => n.leaseId === leaseId) as NoticeWithType[]

  const start = new Date(startDate)
  const startMonth = start.getMonth() + 1
  const startYear = start.getFullYear()
  const initialNotices = notices.filter((n) => n.month === startMonth && n.year === startYear)

  const nextMonth = startMonth === 12 ? 1 : startMonth + 1
  const nextYear = startMonth === 12 ? startYear + 1 : startYear
  const nextLabel = new Date(nextYear, nextMonth - 1, 1).toLocaleDateString('sv-SE', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <section className="border-line rounded-2xl border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-gray-900">Hyresavier</h3>
        <span className="text-[11px] text-gray-400">Auto-genererade</span>
      </div>

      {initialNotices.length === 0 ? (
        <div className="rounded-xl bg-gray-50 p-4 text-[13px] text-gray-600">
          Inga avier ännu. Vid aktivering skapas deposition (om belopp angivet) och första hyresavi
          automatiskt och mejlas till hyresgästen.
        </div>
      ) : (
        <div className="space-y-2">
          {initialNotices
            .sort((a) => (a.type === 'DEPOSIT' ? -1 : 1))
            .map((n) => (
              <div
                key={n.id}
                className="border-line flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                  {n.type === 'DEPOSIT' ? (
                    <ShieldCheck size={16} strokeWidth={1.8} />
                  ) : (
                    <Receipt size={16} strokeWidth={1.8} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-gray-900">
                    {n.type === 'DEPOSIT'
                      ? 'Deposition'
                      : n.isProrated
                        ? `Hyra (delmånad ${n.daysCharged}/${n.totalDays})`
                        : 'Hyra'}
                    <span className="ml-2 font-normal text-gray-500">{n.noticeNumber}</span>
                  </p>
                  <p className="text-[11.5px] text-gray-500">
                    {formatCurrency(Number(n.totalAmount))} · förfaller {formatDate(n.dueDate)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void downloadNoticePdf(n.id, n.noticeNumber)}
                >
                  <Download size={13} strokeWidth={1.8} />
                  PDF
                </Button>
              </div>
            ))}
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-blue-50/60 px-3 py-2.5 text-[12px] text-blue-700">
        <Info size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
        <span>
          Nästa avi ({nextLabel}) skapas automatiskt den 1:a kommande månad och mejlas till
          hyresgästen.
        </span>
      </div>
    </section>
  )
}
