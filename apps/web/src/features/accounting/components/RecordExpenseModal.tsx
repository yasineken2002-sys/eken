import { useMemo, useState } from 'react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useCreateExpense } from '../hooks/useAccounting'
import { momsAvBrutto, tolkaBelopp } from './entry-balance'
import { extractApiError } from '@/lib/api'
import { kontraktsfel } from './contract-gate'
import type { CreateExpenseInput } from '@eken/shared'
import { CreateExpenseSchema, formatCurrency, VAT_RATES } from '@eken/shared'
import type { Account } from '@eken/shared'

/**
 * REGISTRERA UTGIFT — människans väg till AI-verktyget `record_expense`.
 *
 * ── BELOPPET ÄR BRUTTO ──────────────────────────────────────────────────────
 *
 * Fältet är det som står på kvittot och det som lämnar bankkontot. Momsen bryts
 * UT ur det (`momsAvBrutto`), den läggs inte till. Konteringsförhandsvisningen
 * nedan visar de tre raderna innan man bokför, just därför att den riktningen är
 * lätt att missförstå — och ett verifikat med fel riktning BALANSERAR, så
 * varken balansgrinden eller ett radprov hade fångat det.
 *
 * Momssatsen kommer ur `VAT_RATES` (@eken/shared), aldrig ur en egen lista.
 * Servern tar emot både satsen och det framräknade beloppet: satsen för
 * spårbarhet, beloppet därför att avrundningen ska ske på ETT ställe.
 */

interface Props {
  open: boolean
  onClose: () => void
  accounts: readonly Account[]
}

export function RecordExpenseModal({ open, onClose, accounts }: Props) {
  const idag = new Date().toISOString().slice(0, 10)
  const [datum, setDatum] = useState(idag)
  const [leverantor, setLeverantor] = useState('')
  const [beskrivning, setBeskrivning] = useState('')
  const [belopp, setBelopp] = useState('')
  const [momssats, setMomssats] = useState<number>(25)
  const [konto, setKonto] = useState('')
  const [bilaga, setBilaga] = useState('')
  const [nyckel, setNyckel] = useState(() => crypto.randomUUID())
  const [serverfel, setServerfel] = useState<string | null>(null)

  const mutation = useCreateExpense()

  const kontonamn = useMemo(() => {
    const karta = new Map<number, string>()
    for (const k of accounts) karta.set(k.number, k.name)
    return karta
  }, [accounts])

  const brutto = tolkaBelopp(belopp)
  const moms = momsAvBrutto(brutto, momssats)
  const netto = brutto - moms
  const kontonummer = Number(konto)
  const kontoFinns = Number.isFinite(kontonummer) && kontonamn.has(kontonummer)

  const fel = !datum
    ? 'Välj ett datum.'
    : beskrivning.trim().length < 3
      ? 'Beskrivningen måste vara minst 3 tecken.'
      : brutto <= 0
        ? 'Ange ett belopp större än noll.'
        : !konto.trim()
          ? 'Välj ett kostnadskonto.'
          : !kontoFinns
            ? `Konto ${konto} finns inte i kontoplanen.`
            : null

  const stang = () => {
    setDatum(idag)
    setLeverantor('')
    setBeskrivning('')
    setBelopp('')
    setMomssats(25)
    setKonto('')
    setBilaga('')
    setServerfel(null)
    setNyckel(crypto.randomUUID())
    onClose()
  }

  const bokfor = () => {
    if (fel) return
    setServerfel(null)
    // ANNOTERAD med flit. Utan typen är `kropp` en inferrerad const, och då
    // körs INGEN överskottskontroll: ett fält som finns här men inte i
    // kontraktet passerar tyst. Uppmätt i negativkontrollen — API-sidan blev
    // röd, webben inte, förrän den här raden fanns.
    const kropp: CreateExpenseInput = {
      date: datum,
      description: beskrivning.trim(),
      ...(leverantor.trim() ? { supplier: leverantor.trim() } : {}),
      amount: brutto,
      vatRate: momssats,
      vatAmount: moms,
      accountNumber: kontonummer,
      idempotencyKey: nyckel,
      ...(bilaga.trim() ? { attachmentUrl: bilaga.trim() } : {}),
    }

    // SISTA GRINDEN: nyttolasten prövas mot det DELADE schemat innan den lämnar
    // webbläsaren. Formulärets egna regler har redan talat ovan; den här fångar
    // det de missar — och det är samma form som i #795 blev ett 400-svar.
    const kontrakt = kontraktsfel(CreateExpenseSchema, kropp)
    if (kontrakt) {
      setServerfel(kontrakt)
      return
    }

    mutation.mutate(kropp, {
      onSuccess: stang,
      onError: (err) => setServerfel(extractApiError(err, 'Kunde inte bokföra utgiften')),
    })
  }

  return (
    <Modal
      open={open}
      onClose={stang}
      title="Registrera utgift"
      description="För en REDAN BETALD utgift. Bokförs som kostnad mot bankkontot, beloppet inklusive moms."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Betalningsdatum"
            type="date"
            value={datum}
            onChange={(e) => setDatum(e.target.value)}
            hint="Dagen pengarna lämnade kontot — inte fakturadatumet."
            data-testid="expense-date"
          />
          <Input
            label="Leverantör (valfri)"
            value={leverantor}
            onChange={(e) => setLeverantor(e.target.value)}
            placeholder="t.ex. Rörjouren AB"
          />
        </div>

        <Input
          label="Beskrivning"
          value={beskrivning}
          onChange={(e) => setBeskrivning(e.target.value)}
          placeholder="Vad avser utgiften?"
          data-testid="expense-description"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Belopp inkl. moms"
            value={belopp}
            onChange={(e) => setBelopp(e.target.value)}
            inputMode="decimal"
            placeholder="0,00"
            data-testid="expense-amount"
          />
          <div>
            <label className="mb-1 block text-[13px] font-medium text-gray-700" htmlFor="momssats">
              Moms
            </label>
            <select
              id="momssats"
              className="border-input h-10 w-full rounded-xl border bg-white px-3.5 text-[13.5px] text-gray-900"
              value={momssats}
              onChange={(e) => setMomssats(Number(e.target.value))}
              data-testid="expense-vat-rate"
            >
              {VAT_RATES.map((sats) => (
                <option key={sats} value={sats}>
                  {sats} %
                </option>
              ))}
            </select>
          </div>
          <div>
            <Input
              label="Kostnadskonto"
              value={konto}
              onChange={(e) => setKonto(e.target.value)}
              inputMode="numeric"
              placeholder="5070"
              data-testid="expense-account"
            />
            {kontoFinns && (
              <p className="mt-1 text-[12px] text-gray-400">{kontonamn.get(kontonummer)}</p>
            )}
          </div>
        </div>

        {/* KONTERINGEN INNAN MAN BOKFÖR. Riktningen brutto → netto + moms är
            hela poängen med att visa den: ett verifikat med omvänd tolkning
            balanserar, och felet syns bara här. */}
        {brutto > 0 && (
          <div
            className="border-line rounded-2xl border bg-gray-50/60 p-4"
            data-testid="expense-preview"
          >
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-gray-400">
              Kontering
            </p>
            <dl className="space-y-1.5 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-gray-500">
                  {konto || '—'} {kontonamn.get(kontonummer) ?? ''} (debet)
                </dt>
                <dd className="text-gray-900">{formatCurrency(netto)}</dd>
              </div>
              {moms > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">2641 Ingående moms (debet)</dt>
                  <dd className="text-gray-900">{formatCurrency(moms)}</dd>
                </div>
              )}
              <div className="border-line flex justify-between border-t pt-1.5">
                <dt className="text-gray-500">1930 Företagskonto (kredit)</dt>
                <dd className="font-medium text-gray-900">{formatCurrency(brutto)}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* BEGRÄNSNINGEN, utskriven. Verktyget konterar i ETT steg direkt mot
            1930 — kontantmetoden. En leverantörsfaktura som mottagits men inte
            betalats ska bokföras i två steg via 2440 Leverantörsskulder, annars
            saknas skulden i balansräkningen mellan faktura- och betaldatum och
            kostnaden kan hamna i fel period över ett bokslut. Den vägen finns
            inte här, och det ska synas i gränssnittet i stället för att
            upptäckas av en revisor. */}
        <p className="border-line rounded-xl border bg-gray-50/60 px-4 py-3 text-[12px] text-gray-500">
          Obetalda leverantörsfakturor hör inte hemma här — de ska bokföras mot leverantörsskuld
          (2440) i två steg. Den vägen finns ännu inte i Eveno.
        </p>

        <Input
          label="Bilaga (valfri)"
          value={bilaga}
          onChange={(e) => setBilaga(e.target.value)}
          placeholder="Länk till kvitto"
          hint="Underlaget ska gå att hitta i sju år (BFL 7 kap)."
        />

        {(serverfel ?? fel) && (
          <p
            className={
              serverfel
                ? 'rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600'
                : 'text-[12px] text-gray-400'
            }
            data-testid="expense-error"
          >
            {serverfel ?? fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={stang}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={bokfor}
          disabled={fel !== null || mutation.isPending}
          data-testid="expense-submit"
        >
          {mutation.isPending ? 'Bokför…' : 'Bokför utgift'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
