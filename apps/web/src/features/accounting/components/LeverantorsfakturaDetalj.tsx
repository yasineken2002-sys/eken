import { useState } from 'react'
import { toast } from 'sonner'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { extractApiError } from '@/lib/api'
import { formatCurrency, formatDate } from '@eken/shared'
import type { SupplierVatTreatment } from '@eken/shared'
import {
  useAdjustSupplierInvoiceVat,
  useSupplierInvoiceDetails,
  useUndoSupplierPayment,
} from '../hooks/useAccounting'
import { momsvalText } from './Momsval'
import { idagIso } from './supplier-invoice-form'

/** Kort text för ett val (listor och historik). */
export const momsvalKort: Record<SupplierVatTreatment, string> = {
  INGEN_MOMS: 'Ingen moms',
  HELT_AVDRAG: 'Moms dras av',
  INGET_AVDRAG: 'Moms dras inte av',
}

const exportText = (s: string) =>
  ({
    CONFIRMED: 'exporterad till Fortnox',
    DRY_RUN_READY: 'inte exporterad (förhandskontrollerad)',
    BLOCKED: 'inte exporterad',
    SENDING: 'skickas',
    UNKNOWN: 'okänt utfall i Fortnox',
    REJECTED: 'avvisad av Fortnox',
    RECEIPT_IDENTIFIED: 'kvitto mottaget, ej kontrollerat',
    RECEIPT_MISMATCH: 'avviker i Fortnox',
  })[s] ?? s

/**
 * TESTKUND-041: en leverantörsfaktura med kundens momsval, källbundna momsjusteringar (MJ-8) och
 * betalningsregistreringar (BP1). Originalfakturan och historiken ändras aldrig; varje justering och
 * ångring är ett eget verifikat med egen exportstatus.
 */
export function LeverantorsfakturaDetalj({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useSupplierInvoiceDetails(id)
  const justera = useAdjustSupplierInvoiceVat()
  const angra = useUndoSupplierPayment()
  const [skalJ, setSkalJ] = useState('')
  const [datumJ, setDatumJ] = useState(idagIso())
  const [nyckel, setNyckel] = useState(() => crypto.randomUUID())
  const [skalA, setSkalA] = useState('')
  const [fel, setFel] = useState<string | null>(null)
  const f = q.data
  const gallandeLed = f?.betalningsled.find((l) => l.gallande) ?? null
  const kanJustera =
    !!f && f.momsvalAngivet && f.vatAmount > 0 && !f.cancelledAt && f.vatTreatment !== 'INGEN_MOMS'
  const till: SupplierVatTreatment | null =
    f?.vatTreatmentCurrent === 'HELT_AVDRAG'
      ? 'INGET_AVDRAG'
      : f?.vatTreatmentCurrent === 'INGET_AVDRAG'
        ? 'HELT_AVDRAG'
        : null
  const senaste = f?.justeringar.at(-1)

  return (
    <Modal
      open
      onClose={onClose}
      title="Leverantörsfaktura"
      description={f ? `${f.supplierName} – ${f.description}` : ''}
    >
      {q.isLoading && <p className="text-[13px] text-gray-500">Laddar…</p>}
      {f && (
        <div className="min-w-0 space-y-4 text-[13px]" data-testid="supplier-invoice-detail">
          <section className="min-w-0 space-y-1">
            <p className="text-gray-900">
              {formatCurrency(f.totalAmount)} inkl. moms {formatCurrency(f.vatAmount)} (netto{' '}
              {formatCurrency(f.netAmount)})
            </p>
            {f.vatTreatment ? (
              <p className="break-words text-gray-700" data-testid="momsval-ursprung">
                Ursprungligt val: {momsvalText(f.vatTreatment, f.vatAmount, f.totalAmount)}
                {f.vatTreatmentDecidedAt ? ` (${formatDate(f.vatTreatmentDecidedAt)})` : ''}
              </p>
            ) : (
              <p className="break-words text-amber-700" data-testid="momsval-ej-angivet">
                Momsbehandling ej angiven (äldre, bokförd som avdragsgill). Den exporteras inte och
                kan inte justeras här.
              </p>
            )}
            {f.vatTreatmentCurrent && f.vatTreatmentCurrent !== f.vatTreatment && (
              <p className="break-words font-medium text-gray-900" data-testid="momsval-gallande">
                Gällande val: {momsvalKort[f.vatTreatmentCurrent]}
                {senaste && senaste.exportStatus !== 'CONFIRMED' ? ' – inte exporterad' : ''}
              </p>
            )}
          </section>

          {f.justeringar.length > 0 && (
            <section className="min-w-0 space-y-1" data-testid="momsjusteringar">
              <p className="font-medium text-gray-900">Momsjusteringar</p>
              {f.justeringar.map((j) => (
                <p key={j.id} className="break-words text-gray-700" data-justering={j.seq}>
                  {j.seq}. {momsvalKort[j.fran]} → {momsvalKort[j.till]}, {formatDate(j.datum)}:{' '}
                  {j.skal} – {exportText(j.exportStatus)}
                </p>
              ))}
            </section>
          )}

          {kanJustera && till && (
            <section className="min-w-0 space-y-2" data-testid="momsjustering-form">
              <p className="font-medium text-gray-900">
                Ändra till: {momsvalText(till, f.vatAmount, f.totalAmount)}
              </p>
              <p className="break-words text-gray-500">
                Fakturan, betalningen och momsbeloppet ändras inte. En justering bokförs som ett
                eget verifikat på datumet nedan och exporteras efter originalet.
              </p>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  label="Datum"
                  type="date"
                  value={datumJ}
                  onChange={(e) => setDatumJ(e.target.value)}
                />
                <Input
                  label="Skäl"
                  value={skalJ}
                  onChange={(e) => setSkalJ(e.target.value)}
                  data-testid="momsjustering-skal"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={skalJ.trim().length < 5 || justera.isPending}
                data-testid="momsjustering-submit"
                onClick={() =>
                  justera.mutate(
                    { id: f.id, till, date: datumJ, reason: skalJ.trim(), clientKey: nyckel },
                    {
                      onSuccess: () => {
                        setSkalJ('')
                        setNyckel(crypto.randomUUID())
                        setFel(null)
                        toast.success('Momsjusteringen är bokförd')
                        void q.refetch()
                      },
                      onError: (e) => setFel(extractApiError(e, 'Kunde inte justera momsen')),
                    },
                  )
                }
              >
                Bokför momsjustering
              </Button>
            </section>
          )}

          <section className="min-w-0 space-y-1" data-testid="betalningsled">
            <p className="font-medium text-gray-900">Betalningsregistreringar</p>
            {f.betalningshistorikFel && (
              <p className="break-words text-red-600">{f.betalningshistorikFel}</p>
            )}
            {f.betalningsled.length === 0 && (
              <p className="text-gray-500">Ingen betalning registrerad.</p>
            )}
            {f.betalningsled.map((l) => (
              <div
                key={l.journalEntryId}
                className="min-w-0 break-words text-gray-700"
                data-betalningsled={l.k}
              >
                {l.verifikat} {formatDate(l.datum)} – {exportText(l.exportStatus)}
                {l.angring
                  ? ` · ångrad (${l.angring.verifikat}, ${exportText(l.angring.exportStatus)}): ${l.angring.text}`
                  : ' · gällande'}
              </div>
            ))}
          </section>

          {gallandeLed && (
            <section className="min-w-0 space-y-2" data-testid="angra-betalning-form">
              <p className="break-words text-gray-500">
                Ångra betalningsregistreringen {gallandeLed.verifikat} om den registrerades fel.
                Inga pengar flyttas; bara registreringen ångras. Registrera sedan den rätta
                betalningen.
              </p>
              <Input
                label="Skäl"
                value={skalA}
                onChange={(e) => setSkalA(e.target.value)}
                data-testid="angra-skal"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={skalA.trim().length < 5 || angra.isPending}
                data-testid="angra-betalning-submit"
                onClick={() =>
                  angra.mutate(
                    { id: f.id, journalEntryId: gallandeLed.journalEntryId, reason: skalA.trim() },
                    {
                      onSuccess: () => {
                        setSkalA('')
                        setFel(null)
                        toast.success('Betalningsregistreringen är ångrad')
                        void q.refetch()
                      },
                      onError: (e) => setFel(extractApiError(e, 'Kunde inte ångra betalningen')),
                    },
                  )
                }
              >
                Ångra betalning
              </Button>
            </section>
          )}

          {fel && (
            <p className="break-words text-red-600" data-testid="detalj-fel">
              {fel}
            </p>
          )}
        </div>
      )}
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Stäng
        </Button>
      </ModalFooter>
    </Modal>
  )
}
