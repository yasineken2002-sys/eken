import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CircleAlert, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { extractApiError } from '@/lib/api'
import { bekräftelseGiltig } from './fiscal-year-status'
import { useCloseFiscalYear, useFiscalYearClosePreview } from '../hooks/useAccounting'
import { formatCurrency, formatDate } from '@eken/shared'
import type { FiscalYearEntryLine } from '../api/accounting.api'

interface Props {
  fiscalYear: number
  label: string
  onClose: () => void
}

/**
 * BEKRÄFTELSEDIALOGEN FÖR ÅRSSTÄNGNING (#704 PR 3).
 *
 * ── VARFÖR VERIFIKATET VISAS RAD FÖR RAD ──────────────────────────────────
 *
 * Årsstängningen bokför ett verifikat som nollställer varje resultatkonto mot
 * Årets resultat och låser året OÅTERKALLELIGT. Det finns ingen återöppning —
 * varken i UI:t eller i backend. En dialog som bara säger "är du säker?" ber
 * användaren bekräfta något hen inte sett.
 *
 * Raderna kommer från `close-preview`, som gör EXAKT samma beräkning som
 * stängningen sedan bokför (de delar kod i tjänstelagret, och ett db-prov kräver
 * att de föreslagna raderna är identiska med de bokförda). Det är därför den här
 * listan är ett löfte och inte en illustration.
 *
 * ── VARFÖR ANVÄNDAREN MÅSTE SKRIVA ÅRTALET ────────────────────────────────
 *
 * Maskinen föreslår, människan bekräftar det bindande — och det här är det mest
 * bindande i hela bokföringsflödet. Att skriva årtalet skiljer "jag klickade" från
 * "jag menade det". Samma sorts krav som en radering av något oersättligt.
 *
 * ── VAD DIALOGEN INTE GÖR ─────────────────────────────────────────────────
 *
 * Den grindar inte. `canClose` från förhandsvisningen styr knappen, men backend
 * kör om varenda förutsättning i samma transaktion som stängningen — dialogen kan
 * inte släppa igenom något tjänsten nekar. Den finns för att förklara, inte för
 * att skydda.
 */
export function CloseFiscalYearModal({ fiscalYear, label, onClose }: Props) {
  const preview = useFiscalYearClosePreview(fiscalYear)
  const stäng = useCloseFiscalYear()
  const [bekräftelse, setBekräftelse] = useState('')

  const data = preview.data
  const blockerande = (data?.checks ?? []).filter((c) => c.severity === 'blocking')
  const varningar = (data?.checks ?? []).filter((c) => c.severity === 'warning')
  const får = data?.canClose === true && bekräftelseGiltig(bekräftelse, fiscalYear)

  function handleClose() {
    stäng.mutate(
      { fiscalYear },
      {
        onSuccess: (res) => {
          toast.success(
            res.journalEntryId
              ? `Räkenskapsåret ${label} är stängt. Resultat ${formatCurrency(res.summary.result)}.`
              : `Räkenskapsåret ${label} är stängt. Inget verifikat behövdes — inget resultatkonto hade saldo.`,
          )
          onClose()
        },
        onError: (err: unknown) =>
          toast.error(extractApiError(err, 'Räkenskapsåret kunde inte stängas.')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Stäng räkenskapsåret ${label}`}
      description="Resultatkontona nollställs mot Årets resultat och året låses. Detta går inte att ångra."
    >
      {preview.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      ) : !data ? (
        <div className="flex gap-2 rounded-xl bg-red-50 p-3">
          <CircleAlert size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red-600" />
          <p className="text-[13px] text-red-700">
            Underlaget kunde inte hämtas. Försök igen om en stund.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── Förutsättningarna ───────────────────────────────────────── */}
          {blockerande.map((c) => (
            <div key={c.code} className="flex gap-2 rounded-xl bg-red-50 p-3">
              <CircleAlert size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red-600" />
              <p className="text-[13px] text-red-700">{c.message}</p>
            </div>
          ))}
          {varningar.map((c) => (
            <div key={c.code} className="flex gap-2 rounded-xl bg-amber-50 p-3">
              <AlertTriangle
                size={15}
                strokeWidth={1.8}
                className="mt-0.5 shrink-0 text-amber-600"
              />
              <p className="text-[13px] text-amber-900">{c.message}</p>
            </div>
          ))}

          {/* ── Det föreslagna verifikatet ──────────────────────────────── */}
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[14px] font-semibold text-gray-900">Årsavslutsverifikat</h3>
              <span className="text-[12px] text-gray-500">
                Dateras {formatDate(data.entry.date)}
              </span>
            </div>

            {data.entry.lines.length === 0 ? (
              <p className="border-line rounded-xl border bg-gray-50 p-3 text-[13px] text-gray-600">
                Inget resultatkonto har saldo för räkenskapsåret. Året stängs utan verifikat.
              </p>
            ) : (
              <div className="border-line overflow-hidden rounded-xl border">
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50/60">
                        <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                          Konto
                        </th>
                        <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                          Debet
                        </th>
                        <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                          Kredit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.entry.lines.map((rad: FiscalYearEntryLine) => (
                        <tr
                          key={rad.accountId}
                          data-testid="year-end-line"
                          className="border-b border-gray-100 last:border-0"
                        >
                          <td className="px-3 py-2 text-gray-900">
                            <span className="font-medium">{rad.accountNumber}</span>{' '}
                            <span className="text-gray-600">{rad.accountName}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                            {rad.debit != null ? formatCurrency(rad.debit) : ''}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                            {rad.credit != null ? formatCurrency(rad.credit) : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-[13px] text-gray-600">
                {data.entry.result >= 0 ? 'Årets resultat (vinst)' : 'Årets resultat (förlust)'} —
                konto {data.entry.resultAccountNumber}
              </span>
              <span
                data-testid="year-end-result"
                className="text-[15px] font-semibold tabular-nums text-gray-900"
              >
                {formatCurrency(data.entry.result)}
              </span>
            </div>
          </div>

          {/* ── Vad stängningen INTE gör ───────────────────────────────── */}
          <div className="flex gap-2 rounded-xl bg-gray-100 p-3">
            <Info size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-gray-500" />
            <p className="text-[12px] text-gray-600">
              Momskonton avräknas inte — ett kvarstående saldo där är väntat. Dispositionen av årets
              resultat till balanserat resultat bokförs inte heller; den fattas på bolagsstämma och
              görs som en egen post.
            </p>
          </div>

          {/* ── Bekräftelsen ───────────────────────────────────────────── */}
          {data.canClose && (
            <div className="border-line border-t pt-4">
              <Input
                label={`Skriv ${fiscalYear} för att bekräfta`}
                hint="Ett stängt räkenskapsår kan inte öppnas igen."
                value={bekräftelse}
                onChange={(e) => setBekräftelse(e.target.value)}
                data-testid="fiscal-year-confirm"
                autoComplete="off"
              />
            </div>
          )}
        </div>
      )}

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          data-testid="fiscal-year-close-submit"
          disabled={!får || stäng.isPending}
          onClick={handleClose}
        >
          {stäng.isPending ? 'Stänger…' : 'Stäng räkenskapsåret'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
