import { useMemo, useState } from 'react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useCreateSupplierInvoice } from '../hooks/useAccounting'
import { beraknaBelopp, fakturaFel, type LeverantorsfakturaUtkast } from './supplier-invoice-form'
import { extractApiError } from '@/lib/api'
import { formatCurrency, VAT_RATES } from '@eken/shared'
import type { Account } from '@eken/shared'

/**
 * NY LEVERANTÖRSFAKTURA — fakturametoden, till skillnad från "Registrera
 * utgift" som är kontantmetoden.
 *
 * Skillnaden i bokföringen är EN rad och hela innebörden: utgiften krediterar
 * bankkontot (1930, pengarna är borta), fakturan krediterar
 * leverantörsskulden (2440, pengarna ska betalas). Modalen säger det i klartext
 * i förhandsvisningen, eftersom valet mellan de två knapparna annars ser ut som
 * en smaksak.
 *
 * Reglerna — beloppsuppdelning och vad som hindrar registrering — bor i
 * `supplier-invoice-form.ts` och prövas där. Den här filen kopierar dem inte.
 */

interface Props {
  open: boolean
  onClose: () => void
  accounts: readonly Account[]
}

export function NewSupplierInvoiceModal({ open, onClose, accounts }: Props) {
  const idag = new Date().toISOString().slice(0, 10)
  const tomtUtkast: LeverantorsfakturaUtkast = {
    supplierName: '',
    invoiceNumber: '',
    description: '',
    invoiceDate: idag,
    dueDate: '',
    expenseAccount: '',
    amount: '',
    vatRate: 25,
  }
  const [utkast, setUtkast] = useState<LeverantorsfakturaUtkast>(tomtUtkast)
  // Bilagan ligger utanför utkastet: den är verifikationsUNDERLAG, inte en
  // uppgift reglerna räknar på. Fakturametoden är just det flöde där underlaget
  // betyder mest — det är en riktig leverantörsfaktura som ska bevaras i sju år
  // (BFL 7 kap 2 §), inte ett kvitto man redan har i banken.
  const [bilaga, setBilaga] = useState('')
  const [serverfel, setServerfel] = useState<string | null>(null)

  const mutation = useCreateSupplierInvoice()

  const kontonamn = useMemo(() => {
    const karta = new Map<number, string>()
    for (const k of accounts) karta.set(k.number, k.name)
    return karta
  }, [accounts])

  const satt = <K extends keyof LeverantorsfakturaUtkast>(
    nyckel: K,
    varde: LeverantorsfakturaUtkast[K],
  ) => setUtkast((f) => ({ ...f, [nyckel]: varde }))

  const { brutto, moms, netto } = beraknaBelopp(utkast)
  const fel = fakturaFel(utkast, (n) => kontonamn.has(n))
  const kontonummer = Number(utkast.expenseAccount)

  const stang = () => {
    setUtkast(tomtUtkast)
    setBilaga('')
    setServerfel(null)
    onClose()
  }

  const registrera = () => {
    if (fel) return
    setServerfel(null)
    mutation.mutate(
      {
        supplierName: utkast.supplierName.trim(),
        ...(utkast.invoiceNumber.trim() ? { invoiceNumber: utkast.invoiceNumber.trim() } : {}),
        description: utkast.description.trim(),
        invoiceDate: utkast.invoiceDate,
        dueDate: utkast.dueDate,
        expenseAccount: kontonummer,
        amount: brutto,
        vatRate: utkast.vatRate,
        // Skickas som en AVSTÄMNING, inte som fakta: servern räknar om samma
        // sak och avvisar om talen skiljer sig mer än ett öre. Det som visas i
        // konteringen ovan är därför bevisligen det som bokförs.
        vatAmount: moms,
        ...(bilaga.trim() ? { attachmentUrl: bilaga.trim() } : {}),
      },
      {
        onSuccess: stang,
        onError: (err) =>
          setServerfel(extractApiError(err, 'Kunde inte registrera leverantörsfakturan')),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={stang}
      title="Ny leverantörsfaktura"
      description="För en faktura som ska betalas senare. Bokförs som kostnad mot leverantörsskuld — betalningen bokförs när den sker."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Leverantör"
            value={utkast.supplierName}
            onChange={(e) => satt('supplierName', e.target.value)}
            placeholder="t.ex. Rörjouren AB"
            data-testid="supplier-name"
          />
          <Input
            label="Fakturanummer (valfritt)"
            value={utkast.invoiceNumber}
            onChange={(e) => satt('invoiceNumber', e.target.value)}
            placeholder="t.ex. 2026-4471"
          />
        </div>

        <Input
          label="Beskrivning"
          value={utkast.description}
          onChange={(e) => satt('description', e.target.value)}
          placeholder="Vad avser fakturan?"
          data-testid="supplier-description"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Fakturadatum"
            type="date"
            value={utkast.invoiceDate}
            onChange={(e) => satt('invoiceDate', e.target.value)}
            hint="Dagen fakturan utfärdades — det är då kostnaden uppstår."
            data-testid="supplier-invoice-date"
          />
          <Input
            label="Förfallodatum"
            type="date"
            value={utkast.dueDate}
            onChange={(e) => satt('dueDate', e.target.value)}
            hint="Sista betalningsdag enligt fakturan."
            data-testid="supplier-due-date"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Belopp inkl. moms"
            value={utkast.amount}
            onChange={(e) => satt('amount', e.target.value)}
            placeholder="0,00"
            hint="Totalen på fakturan."
            data-testid="supplier-amount"
          />
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Momssats</label>
            <select
              value={utkast.vatRate}
              onChange={(e) => satt('vatRate', Number(e.target.value))}
              className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3.5 text-[13.5px] text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
              data-testid="supplier-vat-rate"
            >
              {VAT_RATES.map((sats) => (
                <option key={sats} value={sats}>
                  {sats} %
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Kostnadskonto
            </label>
            <input
              list="supplier-expense-accounts"
              value={utkast.expenseAccount}
              onChange={(e) => satt('expenseAccount', e.target.value)}
              placeholder="t.ex. 5070"
              className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3.5 text-[13.5px] text-gray-900 placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
              data-testid="supplier-account"
            />
            <datalist id="supplier-expense-accounts">
              {accounts.map((k) => (
                <option key={k.number} value={String(k.number)}>
                  {k.number} – {k.name}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        <Input
          label="Bilaga (valfri länk)"
          value={bilaga}
          onChange={(e) => setBilaga(e.target.value)}
          placeholder="https://…"
          hint="Länk till fakturan. Underlaget ska kunna visas i sju år."
          data-testid="supplier-attachment"
        />

        {/* KONTERINGEN INNAN MAN BOKFÖR. Den enda raden som skiljer den här
            vägen från "Registrera utgift" är den sista — och det är den som
            avgör om skulden syns i balansräkningen. */}
        <div className="border-line bg-canvas rounded-xl border p-4">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-gray-400">
            Kontering
          </p>
          <div className="mt-2 space-y-1 text-[13px]">
            <Konteringsrad
              konto={utkast.expenseAccount || '—'}
              namn={kontonamn.get(kontonummer) ?? 'Kostnad'}
              sida="Debet"
              belopp={netto}
            />
            {moms > 0 && (
              <Konteringsrad konto="2641" namn="Ingående moms" sida="Debet" belopp={moms} />
            )}
            <Konteringsrad
              konto="2440"
              namn="Leverantörsskulder"
              sida="Kredit"
              belopp={brutto}
              framhavd
            />
          </div>
          <p className="text-ink-muted mt-2 text-[12px]">
            Ingen betalning bokförs nu — skulden ligger kvar på 2440 tills du markerar fakturan som
            betald.
          </p>
          {/* EN momssats och ETT kostnadskonto per post. En faktura med både
              25 % och 12 %, eller med material och arbete på olika konton, ska
              delas upp — annars måste ett av talen bli fel. Det står här i
              stället för i en manual, eftersom det är här valet görs. */}
          <p className="text-ink-muted mt-1 text-[12px]">
            En momssats och ett kostnadskonto per post. Har fakturan flera — registrera den som
            flera poster med samma fakturanummer.
          </p>
        </div>

        {(fel || serverfel) && (
          <p className="text-[12px] text-red-500" data-testid="supplier-invoice-error">
            {serverfel ?? fel}
          </p>
        )}

        <ModalFooter>
          <Button variant="secondary" onClick={stang}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            onClick={registrera}
            disabled={!!fel || mutation.isPending}
            data-testid="submit-supplier-invoice"
          >
            {mutation.isPending ? 'Registrerar…' : 'Registrera faktura'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

function Konteringsrad({
  konto,
  namn,
  sida,
  belopp,
  framhavd,
}: {
  konto: string
  namn: string
  sida: 'Debet' | 'Kredit'
  belopp: number
  framhavd?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={framhavd ? 'font-medium text-gray-900' : 'text-gray-600'}>
        {konto} {namn}
      </span>
      <span className={framhavd ? 'font-medium text-gray-900' : 'text-gray-600'}>
        {sida} {formatCurrency(belopp)}
      </span>
    </div>
  )
}
