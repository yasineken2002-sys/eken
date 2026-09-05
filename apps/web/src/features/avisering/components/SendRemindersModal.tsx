import { Bell } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@eken/shared'
import { bekräftelsetext, spärrskäl, type PaminnelseForhandsbesked } from './reminder-preview'

/**
 * SKICKA PÅMINNELSER NU — människans väg till `send_overdue_reminders`.
 *
 * Kravtrappan går automatiskt; det här är knappen för att göra det manuellt.
 * Endpointen fanns sedan tidigare (`POST /notifications/send-overdue-reminders`,
 * ADMIN/OWNER) — ingen rad i apps/web anropade den, vilket är exakt vad
 * baslinjens skäl sade.
 *
 * ── VAD SOM VISAS INNAN NÅGOT SKICKAS ───────────────────────────────────────
 *
 * Antal, sammanlagd restskuld, och raderna. Breven går till människor utanför
 * systemet och går inte att ta tillbaka. Antalet är ett TAK: dedupen sker per
 * faktura på servern, så några kan hoppas över för att de redan påmindes i dag.
 *
 * ── FÄRSKHETSGRINDEN ────────────────────────────────────────────────────────
 *
 * Är betalningsdatan inaktuell är knappen spärrad MED SKÄLET, inte tyst.
 * Servern verkställer samma regel med 409 — spärren här är ett besked, inte
 * skyddet.
 */

interface Props {
  open: boolean
  onClose: () => void
  besked: PaminnelseForhandsbesked | undefined
  onSkicka: () => void
  skickar: boolean
  fel: string | null
}

export function SendRemindersModal({ open, onClose, besked, onSkicka, skickar, fel }: Props) {
  const skäl = spärrskäl(besked)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Skicka påminnelser nu"
      description="Förfallna fakturor som väntar på en påminnelse."
    >
      <div className="space-y-4">
        {besked && (
          <div className="grid grid-cols-2 gap-4">
            <div className="border-line rounded-2xl border p-4">
              <p className="text-[12px] text-gray-400">Fakturor</p>
              <p className="mt-0.5 text-[26px] font-semibold tracking-tight text-gray-900">
                {besked.count}
              </p>
            </div>
            <div className="border-line rounded-2xl border p-4">
              <p className="text-[12px] text-gray-400">Sammanlagd restskuld</p>
              <p className="mt-0.5 text-[26px] font-semibold tracking-tight text-gray-900">
                {formatCurrency(besked.totalOutstanding)}
              </p>
            </div>
          </div>
        )}

        {skäl ? (
          <p
            className={
              besked?.freshness.stale
                ? 'rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-[13px] text-amber-700'
                : 'rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-[13px] text-gray-600'
            }
            data-testid="reminders-blocked"
          >
            {skäl}
          </p>
        ) : (
          besked && (
            <p className="text-[13px] text-gray-600" data-testid="reminders-summary">
              {bekräftelsetext(besked)}
            </p>
          )
        )}

        {besked && besked.invoices.length > 0 && (
          <div className="border-line max-h-64 overflow-y-auto rounded-2xl border">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="px-4 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Faktura
                  </th>
                  <th className="px-4 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Mottagare
                  </th>
                  <th className="px-4 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Restskuld
                  </th>
                </tr>
              </thead>
              <tbody>
                {besked.invoices.map((i) => (
                  <tr
                    key={i.id}
                    className="border-b border-[var(--ev-row-border)] last:border-0"
                    data-testid={`reminder-row-${i.id}`}
                  >
                    <td className="px-4 py-2.5">
                      <span className="text-gray-900">{i.invoiceNumber}</span>
                      <span className="ml-2 text-[12px] text-gray-400">
                        förföll {formatDate(i.dueDate)}
                      </span>
                    </td>
                    <td className="truncate px-4 py-2.5 text-gray-700">{i.recipient}</td>
                    <td className="px-4 py-2.5 text-right text-gray-900">
                      {formatCurrency(i.outstanding)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {fel && (
          <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
            {fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={onSkicka}
          disabled={skäl !== null || skickar}
          data-testid="reminders-send"
        >
          <Bell size={14} strokeWidth={1.8} />
          {skickar ? 'Skickar…' : 'Skicka påminnelser'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/** Liten statusflagga för sidhuvudet — visar om vägen är spärrad utan att öppna modalen. */
export function ReminderFreshnessBadge({
  besked,
}: {
  besked: PaminnelseForhandsbesked | undefined
}) {
  if (!besked?.freshness.stale) return null
  return (
    <Badge variant="warning" dot>
      Inaktuell betalningsdata
    </Badge>
  )
}
