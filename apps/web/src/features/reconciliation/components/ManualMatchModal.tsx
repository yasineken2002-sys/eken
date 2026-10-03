import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link2, Search } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge, InvoiceStatusBadge } from '@/components/ui/Badge'
import { useInvoices } from '@/features/invoices/hooks/useInvoiceQueries'
import { fetchNotices, type RentNotice } from '@/features/avisering/api/avisering.api'
import { formatCurrency, formatDate } from '@eken/shared'
import type { BankTransaction, Invoice } from '@eken/shared'
import { cn } from '@/lib/cn'
import { extractApiError } from '@/lib/api'
import { useManualMatch } from '../hooks/useReconciliation'

// G19 (FORTNOX-100): manuell matchning mot HYRESAVI. Tidigare listade dialogen bara
// kommersiella fakturor, så ett hyresbolag kunde inte koppla en omatchad bankbetalning (fel
// OCR, betalning utan OCR, oavgjord deposition/hyra) till rätt avi i webben — trots att
// API:t (`PATCH /reconciliation/transactions/:id/match { rentNoticeId }`) och dess spärrar
// (organisation, status, restskuld, delbetalning, kreditering) redan fanns.
//
// Dialogen väljer INGET åt operatören: ingen förvald avi och ingen ny prioritetsregel.
// "Belopp stämmer" är en upplysning, inte ett beslut.

/** Samma statusar som API:t låter ta emot en betalning (`BETALBARA_AVISTATUSAR`). */
const BETALBARA = new Set(['SENT', 'PENDING', 'OVERDUE', 'FAILED'])
const MÅNADER = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

const hyresgästnamn = (n: RentNotice) =>
  n.tenant.type === 'COMPANY'
    ? (n.tenant.companyName ?? '')
    : `${n.tenant.firstName ?? ''} ${n.tenant.lastName ?? ''}`.trim()

type Mål = { slag: 'avi'; id: string } | { slag: 'faktura'; id: string }

export function ManualMatchModal({
  transaction,
  onClose,
}: {
  transaction: BankTransaction
  onClose: () => void
}) {
  const [flik, setFlik] = useState<'avi' | 'faktura'>('avi')
  // Förifyll med betalarens OCR: då visas just den hyresgästens avier. Fel OCR ger
  // tom träff, och operatören söker på namn i stället.
  const [sök, setSök] = useState(transaction.rawOcr ?? '')
  const [fördröjd, setFördröjd] = useState(sök)
  const [valt, setValt] = useState<Mål | null>(null)
  const matchMutation = useManualMatch()

  useEffect(() => {
    const t = setTimeout(() => setFördröjd(sök.trim()), 250)
    return () => clearTimeout(t)
  }, [sök])

  // Hyresavier hämtas först när det finns ett sökord (≥ 2 tecken): utan det skulle
  // dialogen ladda organisationens hela avihistorik.
  const aviSök = fördröjd.length >= 2 ? fördröjd : ''
  const avier = useQuery({
    queryKey: ['avisering', { search: aviSök }],
    queryFn: () => fetchNotices({ search: aviSök }),
    enabled: flik === 'avi' && aviSök !== '',
    staleTime: 30_000,
  })
  const { data: invoices = [], isLoading: laddarFakturor } = useInvoices()

  const aviKandidater = (avier.data ?? [])
    .filter((n) => BETALBARA.has(n.status) && n.payableTotal > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month)
  const fakturaKandidater = invoices.filter(
    (inv) =>
      ['SENT', 'OVERDUE', 'PARTIAL'].includes(inv.status) &&
      (sök === '' ||
        inv.invoiceNumber.toLowerCase().includes(sök.toLowerCase()) ||
        String(inv.total).includes(sök)),
  )

  const stämmer = (belopp: number) => Math.abs(belopp - transaction.amount) <= 1

  // G19-010: bara ett mål som SYNS i listan just nu kan matchas. Ett val som sökningen
  // dolt får aldrig skickas i bakgrunden (C2 MOTPROV-G19-010 REPRO-1–3).
  const valdFaktura =
    valt?.slag === 'faktura' ? fakturaKandidater.find((f) => f.id === valt.id) : undefined
  const valtSynligt =
    valt?.slag === 'avi'
      ? aviKandidater.some((n) => n.id === valt.id)
      : valt?.slag === 'faktura'
        ? valdFaktura !== undefined
        : false

  const handleMatch = () => {
    if (!valt || !valtSynligt) return
    matchMutation.mutate(
      valt.slag === 'avi'
        ? { transactionId: transaction.id, rentNoticeId: valt.id }
        : { transactionId: transaction.id, invoiceId: valt.id },
      { onSuccess: onClose },
    )
  }

  const valdAvi = valt?.slag === 'avi' ? aviKandidater.find((n) => n.id === valt.id) : undefined
  const delbetalning = valdAvi && transaction.amount < valdAvi.payableTotal - 1
  // API:ts skäl (t.ex. överbetalning eller redan reglerad avi) visas ordagrant.
  const fel = matchMutation.error
    ? extractApiError(matchMutation.error, 'Matchningen misslyckades.')
    : null

  return (
    <Modal open onClose={onClose} title="Matcha transaktion" size="md">
      <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Datum</p>
            <p className="mt-0.5 text-[13px] font-medium text-gray-800">
              {formatDate(transaction.date)}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Belopp
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-emerald-600">
              {formatCurrency(transaction.amount)}
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Beskrivning
            </p>
            <p className="mt-0.5 break-words text-[13px] text-gray-700">
              {transaction.description}
            </p>
          </div>
          {transaction.rawOcr && (
            <div className="col-span-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">OCR</p>
              <p className="mt-0.5 break-all font-mono text-[13px] text-gray-700">
                {transaction.rawOcr}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-1" role="tablist">
        {(
          [
            ['avi', 'Hyresavier'],
            ['faktura', 'Fakturor'],
          ] as const
        ).map(([id, namn]) => (
          <button
            key={id}
            role="tab"
            aria-selected={flik === id}
            onClick={() => {
              setFlik(id)
              setValt(null)
              // Betalarens OCR hör till avierna; fakturorna söks på fakturanummer/belopp.
              setSök(id === 'avi' ? (transaction.rawOcr ?? '') : '')
            }}
            className={cn(
              'h-8 flex-1 rounded-md text-[13px] font-medium',
              flik === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500',
            )}
          >
            {namn}
          </button>
        ))}
      </div>

      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={sök}
          onChange={(e) => {
            // G19-010: ny sökning = nytt urval; ett tidigare val gäller inte längre.
            setSök(e.target.value)
            setValt(null)
          }}
          placeholder={flik === 'avi' ? 'Sök hyresgäst, OCR eller avinummer...' : 'Sök faktura...'}
          aria-label={flik === 'avi' ? 'Sök hyresavi' : 'Sök faktura'}
          className="focus:border-brand focus:ring-brand/20 h-9 w-full rounded-lg border border-gray-200 pl-8 pr-3 text-[13px] focus:outline-none focus:ring-2"
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100">
        {flik === 'avi' ? (
          aviSök === '' ? (
            <div className="px-4 py-8 text-center text-[13px] text-gray-400">
              Sök på hyresgästens namn, OCR eller avinummer.
            </div>
          ) : avier.isLoading ? (
            <div className="py-8 text-center text-[13px] text-gray-400">Laddar hyresavier...</div>
          ) : avier.isError ? (
            <div className="py-8 text-center text-[13px] text-red-600">
              Hyresavierna kunde inte hämtas.
            </div>
          ) : aviKandidater.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-gray-400">
              Inga obetalda hyresavier matchar sökningen.
            </div>
          ) : (
            aviKandidater.map((n, i) => (
              <button
                key={n.id}
                onClick={() => setValt({ slag: 'avi', id: n.id })}
                aria-pressed={valt?.id === n.id}
                className={cn(
                  'flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors',
                  i !== aviKandidater.length - 1 && 'border-b border-gray-100',
                  valt?.id === n.id
                    ? 'bg-blue-600/8 ring-brand/30 ring-1 ring-inset'
                    : 'hover:bg-gray-50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-gray-800">
                      {hyresgästnamn(n)}
                    </span>
                    {n.type === 'DEPOSIT' && <Badge variant="info">Deposition</Badge>}
                    {n.status === 'FAILED' && <Badge variant="warning">Utskick misslyckades</Badge>}
                    {stämmer(n.payableTotal) && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700">
                        Belopp stämmer
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-gray-500">
                    {n.noticeNumber} · {MÅNADER[n.month - 1]} {n.year} · {n.lease.unit.name},{' '}
                    {n.lease.unit.property.name}
                  </p>
                  <p className="text-[12px] text-gray-500">
                    OCR {n.ocrNumber} · förfaller {formatDate(n.dueDate)}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end">
                  <span className="text-[13px] font-semibold text-gray-700">
                    {formatCurrency(n.payableTotal)}
                  </span>
                  <span className="text-[11px] text-gray-400">kvar att betala</span>
                </div>
              </button>
            ))
          )
        ) : laddarFakturor ? (
          <div className="py-8 text-center text-[13px] text-gray-400">Laddar fakturor...</div>
        ) : fakturaKandidater.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-gray-400">Inga fakturor hittades</div>
        ) : (
          fakturaKandidater.map((inv: Invoice, i) => (
            <button
              key={inv.id}
              onClick={() => setValt({ slag: 'faktura', id: inv.id })}
              aria-pressed={valt?.id === inv.id}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                i !== fakturaKandidater.length - 1 && 'border-b border-gray-100',
                valt?.id === inv.id
                  ? 'bg-blue-600/8 ring-brand/30 ring-1 ring-inset'
                  : stämmer(inv.total)
                    ? 'bg-emerald-50/60 hover:bg-emerald-50'
                    : 'hover:bg-gray-50',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-gray-800">
                    {inv.invoiceNumber}
                  </span>
                  {stämmer(inv.total) && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700">
                      Belopp stämmer
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-gray-500">Förfaller {formatDate(inv.dueDate)}</p>
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                <span className="text-[13px] font-semibold text-gray-700">
                  {formatCurrency(inv.total)}
                </span>
                <InvoiceStatusBadge status={inv.status} />
              </div>
            </button>
          ))
        )}
      </div>

      {delbetalning && (
        <p className="mt-3 text-[12px] text-gray-600">
          Beloppet är mindre än avins restskuld och registreras som en delbetalning. Avin står kvar
          med {formatCurrency(valdAvi.payableTotal - transaction.amount)} att betala.
        </p>
      )}
      {fel && (
        <p role="alert" className="mt-3 text-[12px] text-red-600">
          {fel}
        </p>
      )}

      {valtSynligt ? (
        <p className="mt-3 text-[12px] text-gray-700" aria-live="polite">
          Matchas mot:{' '}
          <strong>
            {valdAvi
              ? `${hyresgästnamn(valdAvi)} · ${valdAvi.noticeNumber} · ${MÅNADER[valdAvi.month - 1]} ${valdAvi.year}`
              : valdFaktura?.invoiceNumber}
          </strong>
        </p>
      ) : null}

      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={handleMatch}
          disabled={!valtSynligt}
          loading={matchMutation.isPending}
        >
          <Link2 size={14} /> Matcha
        </Button>
      </ModalFooter>
    </Modal>
  )
}
