import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  fetchNotices,
  downloadNoticePdf,
  type RentNotice,
} from '@/features/avisering/api/avisering.api'
import { Button } from '@/components/ui/Button'
import { Download, Receipt, ShieldCheck, Info, RefreshCw } from 'lucide-react'
import { formatCurrency, formatDate } from '@eken/shared'
import { useCreateInitialNotices } from '../hooks/useLeases'
import { extractApiError } from '@/lib/api'

interface Props {
  leaseId: string
  startDate: string
  /** Kontraktets status — avgör om det tomma tillståndet är väntat eller ett fel. */
  status: string
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
export function LeaseNoticesSection({ leaseId, startDate, status }: Props) {
  const { data: allNotices } = useQuery({
    queryKey: ['avisering', 'list-by-lease', leaseId],
    queryFn: () => fetchNotices(),
    staleTime: 30_000,
  })
  const createInitial = useCreateInitialNotices()

  function handleCreateInitial() {
    createInitial.mutate(leaseId, {
      onSuccess: (res) => {
        const created = [res.deposit ? 'deposition' : null, res.firstRent ? 'hyresavi' : null]
          .filter(Boolean)
          .join(' + ')
        if (!created) {
          toast.success('Avierna fanns redan — inget nytt skapades.')
          return
        }
        // Depositionen hoppas medvetet över vid förnyelse/redan uttagen
        // deposition. Säg det rakt ut, annars ser det ut som ett fel.
        toast.success(
          `Skapade ${created}.` +
            (res.skippedDeposit
              ? res.skipDepositReason === 'succession'
                ? ' Depositionen hoppades över — den följer med från det tidigare avtalet.'
                : ' Depositionen hoppades över — den är redan uttagen.'
              : '') +
            (res.mailed ? ' Mejl till hyresgästen är köat.' : ''),
        )
      },
      onError: (err: unknown) =>
        toast.error(extractApiError(err, 'Kunde inte skapa avierna för kontraktet.')),
    })
  }

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

  // Nyckla åtgärden på att HYRESAVIN saknas, inte på "inga avier alls".
  // Motorn skapar depositionsavin först (egen commit) och hyresavin i en
  // transaktion — misslyckas den senare blir det vanligaste feltillståndet
  // "deposition finns, hyresavi saknas". Ett villkor på tomt tillstånd hade
  // därför dolt knappen i just det läge som notisen hänvisar till (FAR-fynd).
  // Depositionens frånvaro duger INTE som signal: en förnyelse har legitimt
  // ingen egen depositionsavi (den följer med från föregående avtal).
  const missingRentNotice = !initialNotices.some((n) => n.type !== 'DEPOSIT')
  const showRetrigger = status === 'ACTIVE' && missingRentNotice

  const retriggerButton = (
    <Button
      variant="secondary"
      size="sm"
      className="mt-3"
      disabled={createInitial.isPending}
      onClick={handleCreateInitial}
    >
      <RefreshCw size={13} strokeWidth={1.8} />
      {createInitial.isPending ? 'Skapar…' : 'Skapa avierna nu'}
    </Button>
  )

  return (
    <section className="border-line rounded-2xl border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-gray-900">Hyresavier</h3>
        <span className="text-[11px] text-gray-400">Auto-genererade</span>
      </div>

      {/* Delvis skapade avier: listan nedan visar det som finns, men hyresavin
          saknas — lyft åtgärden ovanför listan så den syns. */}
      {showRetrigger && initialNotices.length > 0 && (
        <div className="mb-3 rounded-xl bg-amber-50 p-4">
          <p className="text-[13px] text-amber-900">
            Hyresavin för tillträdesmånaden saknas. Den automatiska genereringen verkar ha avbrutits
            vid aktiveringen.
          </p>
          {retriggerButton}
        </div>
      )}

      {initialNotices.length === 0 ? (
        status === 'ACTIVE' ? (
          // Ett AKTIVT kontrakt utan initial-avier är inte ett väntat läge — det
          // betyder att aktiveringens avi-jobb aldrig blev av (#58). Dagens text
          // ("skapas vid aktivering") är då direkt missvisande: aktiveringen HAR
          // skett. Erbjud åtgärden i stället.
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-[13px] text-amber-900">
              Kontraktet är aktivt men saknar avier. Det betyder oftast att den automatiska
              genereringen inte gick igenom vid aktiveringen.
            </p>
            {retriggerButton}
          </div>
        ) : (
          <div className="rounded-xl bg-gray-50 p-4 text-[13px] text-gray-600">
            Inga avier ännu. Vid aktivering skapas deposition (om belopp angivet) och första
            hyresavi automatiskt och mejlas till hyresgästen.
          </div>
        )
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

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-gray-200/60 px-3 py-2.5 text-[12px] text-gray-500">
        <Info size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
        <span>
          Nästa avi ({nextLabel}) skapas automatiskt den 1:a kommande månad och mejlas till
          hyresgästen.
        </span>
      </div>
    </section>
  )
}
