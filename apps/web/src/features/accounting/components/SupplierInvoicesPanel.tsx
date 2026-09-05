import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CircleAlert, FileX, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable'
import { extractApiError } from '@/lib/api'
import { formatCurrency, formatDate } from '@eken/shared'
import {
  useSupplierInvoices,
  usePaySupplierInvoice,
  useCancelSupplierInvoice,
} from '../hooks/useAccounting'
import { idagIso, makuleringKorsarRakenskapsar } from './supplier-invoice-form'
import type { SupplierInvoice } from '../api/accounting.api'

/**
 * LEVERANTÖRSSKULDER — de obetalda fakturorna och summan på 2440.
 *
 * ── STATUS ÄR BERÄKNAD, INTE EN FLAGGA ──────────────────────────────────────
 *
 * Raderna har ingen statuskolumn i databasen. Servern räknar fram `status` och
 * `overdue` ur `paidAt`/`cancelledAt` och dagens datum, precis som skulden i
 * kravtrappan är ett beräknat tillstånd. Panelen VISAR det svaret — den räknar
 * inte om det, och kan därför inte råka räkna annorlunda.
 *
 * SUMMAN längst upp är summan av det som visas i vyn "Öppna", vilket är samma
 * mängd som saldot på 2440 hade visat. Skiljer de sig åt är det ett verkligt
 * fynd, inte ett avrundningsfel — därför står den här.
 */

type Vy = 'OPEN' | 'PAID' | 'CANCELLED'

export function SupplierInvoicesPanel() {
  const [vy, setVy] = useState<Vy>('OPEN')
  const [betalar, setBetalar] = useState<SupplierInvoice | null>(null)
  const [makulerar, setMakulerar] = useState<SupplierInvoice | null>(null)

  const fakturor = useSupplierInvoices(vy)

  const summa = useMemo(
    () => (fakturor.data ?? []).reduce((s, f) => s + Number(f.totalAmount), 0),
    [fakturor.data],
  )
  const antalForfallna = (fakturor.data ?? []).filter((f) => f.overdue).length

  // Den DELADE tabellen (@eken/ui), inte en handrullad <table>. Rubrikstil,
  // radhöjd, hover och fokusring kommer därifrån — en egen kopia hade blivit
  // ett andra ställe designen kan glida på.
  const kolumner: DataTableColumn<SupplierInvoice>[] = [
    {
      key: 'supplier',
      header: 'Leverantör',
      cell: (f) => (
        <>
          <span className="font-medium text-gray-900">{f.supplierName}</span>
          {f.invoiceNumber && (
            <span className="block text-[12px] text-gray-400">{f.invoiceNumber}</span>
          )}
        </>
      ),
    },
    { key: 'description', header: 'Beskrivning', cell: (f) => f.description },
    { key: 'invoiceDate', header: 'Fakturadatum', cell: (f) => formatDate(f.invoiceDate) },
    { key: 'dueDate', header: 'Förfaller', cell: (f) => formatDate(f.dueDate) },
    {
      key: 'amount',
      header: 'Belopp',
      align: 'right',
      cellClassName: 'font-medium text-gray-900 tabular-nums',
      cell: (f) => formatCurrency(Number(f.totalAmount)),
    },
    { key: 'status', header: 'Status', cell: (f) => <Statusmarke faktura={f} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (f) =>
        f.status === 'OPEN' ? (
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setMakulerar(f)}
              data-testid="cancel-supplier-invoice"
            >
              Makulera
            </Button>
            <Button
              size="xs"
              variant="primary"
              onClick={() => setBetalar(f)}
              data-testid="pay-supplier-invoice"
            >
              Markera betald
            </Button>
          </div>
        ) : null,
    },
  ]

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
          {(
            [
              { id: 'OPEN', label: 'Öppna' },
              { id: 'PAID', label: 'Betalda' },
              { id: 'CANCELLED', label: 'Makulerade' },
            ] as const
          ).map((v) => (
            <button
              key={v.id}
              onClick={() => setVy(v.id)}
              className={
                vy === v.id
                  ? 'h-8 rounded-lg bg-white px-4 text-[13px] font-medium text-gray-900 shadow-sm'
                  : 'h-8 rounded-lg px-4 text-[13px] font-medium text-gray-500 hover:text-gray-700'
              }
              data-testid={`supplier-tab-${v.id}`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {vy === 'OPEN' && (fakturor.data?.length ?? 0) > 0 && (
          <div className="text-right">
            <p className="text-ink-muted text-[12px]">Obetalt totalt (konto 2440)</p>
            <p className="text-[20px] font-semibold tracking-tight text-gray-900">
              {formatCurrency(summa)}
            </p>
          </div>
        )}
      </div>

      {antalForfallna > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
          <CircleAlert size={14} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-red-600" />
          <p className="text-[13px] text-red-600">
            {antalForfallna === 1
              ? '1 faktura har passerat förfallodatum.'
              : `${antalForfallna} fakturor har passerat förfallodatum.`}
          </p>
        </div>
      )}

      {fakturor.isLoading && (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      )}

      {fakturor.isError && (
        <div className="mt-4">
          <EmptyState
            icon={FileX}
            title="Något gick fel"
            description="Kunde inte ladda leverantörsfakturorna. Försök igen."
          />
        </div>
      )}

      {!fakturor.isLoading && !fakturor.isError && (fakturor.data?.length ?? 0) === 0 && (
        <div className="mt-4">
          <EmptyState
            icon={Wallet}
            title={
              vy === 'OPEN'
                ? 'Inga obetalda leverantörsfakturor'
                : vy === 'PAID'
                  ? 'Inga betalda leverantörsfakturor'
                  : 'Inga makulerade leverantörsfakturor'
            }
            description={
              vy === 'OPEN'
                ? 'Registrera en faktura som ska betalas senare med knappen ovanför.'
                : 'Listan fylls när fakturor får det här läget.'
            }
          />
        </div>
      )}

      {!fakturor.isLoading && (fakturor.data?.length ?? 0) > 0 && (
        <div className="mt-4">
          <DataTable columns={kolumner} data={fakturor.data ?? []} keyExtractor={(f) => f.id} />
        </div>
      )}

      {betalar && <BetalningsModal faktura={betalar} onClose={() => setBetalar(null)} />}
      {makulerar && <MakuleringsModal faktura={makulerar} onClose={() => setMakulerar(null)} />}
    </div>
  )
}

/**
 * FÖRFALLEN är ingen egen status — det är en öppen faktura vars datum passerat.
 * Märket säger därför "Förfallen" i danger-färg i stället för "Öppen", men det
 * är samma tillstånd i modellen.
 */
function Statusmarke({ faktura }: { faktura: SupplierInvoice }) {
  if (faktura.status === 'PAID') {
    return (
      <Badge variant="success" dot>
        Betald
      </Badge>
    )
  }
  if (faktura.status === 'CANCELLED') return <Badge variant="ghost">Makulerad</Badge>
  if (faktura.overdue) {
    return (
      <Badge variant="danger" dot>
        Förfallen
      </Badge>
    )
  }
  return <Badge variant="info">Obetald</Badge>
}

/**
 * MARKERA BETALD — bokför betalningen och sätter `paidAt` i SAMMA transaktion
 * server-side. Datumet är dagen pengarna lämnade kontot, inte dagen någon
 * klickar; en betalning som registreras i efterhand ska bokföras på sin egen
 * dag, annars hamnar den i fel period.
 */
function BetalningsModal({ faktura, onClose }: { faktura: SupplierInvoice; onClose: () => void }) {
  const [datum, setDatum] = useState(idagIso())
  const [fel, setFel] = useState<string | null>(null)
  const mutation = usePaySupplierInvoice()

  const bekrafta = () => {
    if (!datum) {
      setFel('Välj ett betalningsdatum.')
      return
    }
    setFel(null)
    mutation.mutate(
      { id: faktura.id, paidDate: datum },
      {
        onSuccess: () => {
          toast.success(`${faktura.supplierName} markerad som betald`)
          onClose()
        },
        onError: (err) => setFel(extractApiError(err, 'Kunde inte bokföra betalningen')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Markera som betald"
      description={`${faktura.supplierName} · ${formatCurrency(Number(faktura.totalAmount))}`}
    >
      <div className="space-y-4">
        <Input
          label="Betalningsdatum"
          type="date"
          value={datum}
          onChange={(e) => setDatum(e.target.value)}
          hint="Dagen pengarna lämnade kontot."
          data-testid="payment-date"
        />
        <div className="border-line bg-canvas rounded-xl border p-4 text-[13px]">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-gray-400">
            Kontering
          </p>
          <div className="mt-2 flex items-center justify-between text-gray-600">
            <span>2440 Leverantörsskulder</span>
            <span>Debet {formatCurrency(Number(faktura.totalAmount))}</span>
          </div>
          <div className="flex items-center justify-between text-gray-600">
            <span>1930 Företagskonto</span>
            <span>Kredit {formatCurrency(Number(faktura.totalAmount))}</span>
          </div>
          {/* Momsen togs vid FAKTURERINGEN. Att ta den igen här hade
              balanserat och därför varit osynlig i verifikatet. */}
          <p className="text-ink-muted mt-2 text-[12px]">
            Ingen moms i det här steget — den drogs av när fakturan registrerades.
          </p>
        </div>
        {fel && <p className="text-[12px] text-red-500">{fel}</p>}
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            onClick={bekrafta}
            disabled={mutation.isPending}
            data-testid="confirm-payment"
          >
            {mutation.isPending ? 'Bokför…' : 'Bokför betalning'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

/**
 * MAKULERING tar bort skulden genom att vända ursprungsverifikatet — den
 * raderar ingenting. En bokförd affärshändelse får inte försvinna (BFL 5 kap),
 * och därför säger texten att en rättelse bokförs, inte att fakturan tas bort.
 */
function MakuleringsModal({ faktura, onClose }: { faktura: SupplierInvoice; onClose: () => void }) {
  const [fel, setFel] = useState<string | null>(null)
  const mutation = useCancelSupplierInvoice()
  const korsarAr = makuleringKorsarRakenskapsar(faktura.invoiceDate.slice(0, 10), idagIso())

  const bekrafta = () => {
    setFel(null)
    mutation.mutate(
      { id: faktura.id },
      {
        onSuccess: () => {
          toast.success(`${faktura.supplierName} makulerad`)
          onClose()
        },
        onError: (err) => setFel(extractApiError(err, 'Kunde inte makulera fakturan')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Makulera leverantörsfaktura"
      description={`${faktura.supplierName} · ${formatCurrency(Number(faktura.totalAmount))}`}
    >
      <div className="space-y-4">
        <p className="text-[13px] text-gray-600">
          Skulden på konto 2440 tas bort genom ett rättelseverifikat, daterat i dag.
          Ursprungsverifikatet ligger kvar i journalen — en bokförd händelse raderas aldrig.
        </p>

        {korsarAr && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <CircleAlert
              size={14}
              strokeWidth={1.8}
              className="mt-0.5 flex-shrink-0 text-amber-700"
            />
            <p className="text-[13px] text-amber-700">
              Fakturan bokfördes {formatDate(faktura.invoiceDate)}, i ett annat räkenskapsår.
              Rättelsen påverkar <strong>årets</strong> resultat — inte det år kostnaden uppstod. Är
              beloppet väsentligt ska rättelsen i stället göras mot balanserat resultat; stäm av med
              din revisor först.
            </p>
          </div>
        )}
        {fel && <p className="text-[12px] text-red-500">{fel}</p>}
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={bekrafta}
            disabled={mutation.isPending}
            data-testid="confirm-cancel"
          >
            {mutation.isPending ? 'Makulerar…' : 'Makulera'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
