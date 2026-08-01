import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, CircleAlert, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { formatCurrency, formatDate } from '@eken/shared'
import { extractApiError } from '@/lib/api'
import { useReverseJournalEntry } from '../hooks/useAccounting'
import type { JournalEntry } from '@eken/shared'

interface Props {
  entry: JournalEntry
  onClose: () => void
  onDone: () => void
}

const MIN_REASON = 10

/** `A12` — verifikationsnumret i sin serie. */
function verLabel(e: { series?: string; verNumber?: number }): string {
  return e.series != null && e.verNumber != null ? `${e.series}${e.verNumber}` : '—'
}

/**
 * Rättar ett verifikat genom att bokföra dess motsats.
 *
 * Dialogen visar VAD som kommer att skapas innan något händer — vilka konton,
 * vilka belopp och att datumet är idag. Poängen är att den som rättar inte ska
 * behöva kunna kontoplanen: raderna kommer från originalet, bara vända.
 *
 * Originalet rörs inte. Det är inte en detalj utan hela principen: det ska gå
 * att se vad som faktiskt bokfördes, när felet upptäcktes och hur det rättades.
 */
export function ReverseEntryModal({ entry, onClose, onDone }: Props) {
  const reverse = useReverseJournalEntry()
  const [reason, setReason] = useState('')

  const reasonOk = reason.trim().length >= MIN_REASON
  const alreadyReversed = entry.reversedBy != null
  const canSubmit = reasonOk && !alreadyReversed && !reverse.isPending

  // Förhandsvisningen är originalets rader med sidorna bytta — exakt vad
  // servern kommer att bokföra. Ingen egen beräkning, ingen kontovalslista.
  const preview = entry.lines.map((l) => ({
    account: l.account,
    debit: l.credit ?? null,
    credit: l.debit ?? null,
  }))
  const total = preview.reduce((sum, l) => sum + Number(l.debit ?? 0), 0)

  function handleReverse() {
    reverse.mutate(
      { id: entry.id, reason: reason.trim() },
      {
        onSuccess: (created) => {
          toast.success(`Rättelse bokförd som verifikat ${verLabel(created)}.`)
          onDone()
        },
        onError: (err: unknown) =>
          toast.error(extractApiError(err, 'Verifikatet kunde inte rättas.')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Rätta verifikatet"
      description={`${verLabel(entry)} · ${entry.description}`}
    >
      {alreadyReversed ? (
        <div className="flex gap-2 rounded-xl bg-gray-50 p-3">
          <Info size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-gray-400" />
          <p className="text-[13px] text-gray-600">
            Det här verifikatet är redan rättat, med verifikat{' '}
            <span className="font-medium text-gray-900">{verLabel(entry.reversedBy!)}</span> den{' '}
            {formatDate(entry.reversedBy!.date)}. Ett verifikat rättas en gång — behöver du ändra
            igen, rätta rättelsen i stället.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <section className="space-y-2.5 rounded-xl bg-blue-50/60 p-3.5 text-[13px] text-gray-700">
            <p>
              Rättelsen bokförs som ett <span className="font-medium">nytt verifikat idag</span>,
              med samma konton och belopp men omvända sidor. Originalet står kvar precis som det
              bokfördes — det ska gå att se vad som faktiskt hände och när felet upptäcktes.
            </p>
            <p className="text-[12px] text-gray-500">
              Är beloppet delvis fel bokför du därefter den korrekta posten på vanligt sätt.
            </p>
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-[14px] font-semibold text-gray-900">
              <ArrowRightLeft size={14} strokeWidth={1.8} className="text-gray-400" />
              Så här kommer rättelsen se ut
            </h3>
            <div className="border-line overflow-hidden rounded-xl border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-line border-b bg-gray-50/60 text-[11.5px] uppercase tracking-wider text-gray-400">
                    <th className="px-3 py-2 text-left font-semibold">Konto</th>
                    <th className="px-3 py-2 text-right font-semibold">Debet</th>
                    <th className="px-3 py-2 text-right font-semibold">Kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((l, i) => (
                    <tr key={i} className="border-line border-b last:border-0">
                      <td className="px-3 py-2 text-gray-900">
                        <span className="font-medium">{l.account?.number}</span>{' '}
                        <span className="text-gray-500">{l.account?.name}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                        {l.debit != null ? formatCurrency(Number(l.debit)) : ''}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                        {l.credit != null ? formatCurrency(Number(l.credit)) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[12px] text-gray-500">
              Datum: <span className="font-medium text-gray-700">{formatDate(new Date())}</span> ·
              Summa {formatCurrency(total)}
            </p>
          </section>

          <section>
            <label
              htmlFor="reverse-reason"
              className="mb-1.5 block text-[13px] font-medium text-gray-700"
            >
              Varför rättas verifikatet?
            </label>
            <textarea
              id="reverse-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="T.ex. Fel belopp — hyran var 8 400 kr, inte 9 400 kr"
              className="w-full rounded-lg border border-gray-200 p-2.5 text-[13.5px] transition-all duration-150 hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
            />
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-gray-500">
              <CircleAlert size={13} strokeWidth={1.8} className="mt-px shrink-0" />
              Skälet blir rättelsens beskrivning i huvudboken och går inte att ändra efteråt. Minst{' '}
              {MIN_REASON} tecken.
            </p>
          </section>
        </div>
      )}

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {alreadyReversed ? 'Stäng' : 'Avbryt'}
        </Button>
        {!alreadyReversed && (
          <Button variant="primary" disabled={!canSubmit} onClick={handleReverse}>
            {reverse.isPending ? 'Bokför…' : 'Bokför rättelsen'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  )
}
