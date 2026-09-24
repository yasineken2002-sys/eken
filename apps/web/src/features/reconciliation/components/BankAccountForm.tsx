import { useRef, useState } from 'react'

import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { kontraktsfel } from '@/lib/contract-gate'
import { extractApiError, isForbidden } from '@/lib/api'
import { CreateBankAccountSchema } from '@eken/shared'

import { useCreateBankAccount } from '../hooks/useReconciliation'
import {
  BANKKONTO_NAMN_MAX,
  BANKKONTO_NUMMER_MAX,
  bankkontoFältfel,
  bankkontoNyttolast,
} from '../api/reconciliation.api'

import type { Bankkonto, BankkontoFältfel } from '../api/reconciliation.api'

/**
 * K1 — LÄGGA UPP IMPORTENS MÅLKONTO, FRÅN WEBBEN.
 *
 * EN komponent, två platser: importmodalens inline-panel och hanteringskortets
 * modal. Skrevs den två gånger räckte det att den ena missade dubbelklicksspärren
 * eller 409-beskedet för att just den vägen ska skapa dubbletter — och den vägen
 * hade sett ut precis som den riktiga.
 *
 * ── VARFÖR INLINE-PANEL OCH INTE EN MODAL INUTI IMPORTMODALEN ───────────────
 *
 * Den delade `<Modal>` lyssnar på Escape på DOCUMENT-nivå och renderar i en
 * portal. Två öppna modaler hade alltså stängts av samma Escape — operatören
 * hade tappat både formuläret och den påbörjade importen med ett tangenttryck.
 * Panelen ligger därför i importmodalens eget innehåll.
 *
 * ── DUBBELKLICK ────────────────────────────────────────────────────────────
 *
 * `isPending` från React Query räcker inte ensamt: två klick i samma tick hinner
 * båda läsa `false` innan omrenderingen. `pågår`-referensen nedan sätts
 * SYNKRONT i handlern och är det som gör spärren till en spärr. Knappens
 * `disabled` är den synliga halvan av samma sak.
 */
export function BankAccountForm({
  befintliga,
  onSkapat,
  onAvbryt,
  kompakt = false,
  idPrefix = 'bankkonto',
}: {
  /** Organisationens konton — används för dubblettkontrollen före skick. */
  befintliga: Bankkonto[] | undefined
  onSkapat: (konto: Bankkonto) => void
  onAvbryt?: () => void
  /** Tätare marginaler när panelen ligger inuti importmodalen. */
  kompakt?: boolean
  /** Fälten får unika id:n så två instanser på samma sida inte delar label. */
  idPrefix?: string
}) {
  const [name, setName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [fältfel, setFältfel] = useState<BankkontoFältfel | null>(null)
  const [serverfel, setServerfel] = useState<string | null>(null)
  const pågår = useRef(false)
  const mutation = useCreateBankAccount()

  /**
   * Tar bort ETT fälts fel när användaren börjar rätta det.
   *
   * Nyckeln RADERAS i stället för att sättas till `undefined`: `tsconfig` kör
   * `exactOptionalPropertyTypes`, så `{ name: undefined }` är inte samma typ som
   * ett objekt utan `name`. Och blir objektet tomt blir det `null` — ett tomt
   * felobjekt är inte "inga fel", det är ett tredje läge ingen läser.
   */
  const rensaFält = (nyckel: keyof BankkontoFältfel) =>
    setFältfel((f) => {
      if (!f?.[nyckel]) return f
      const kvar = { ...f }
      delete kvar[nyckel]
      return Object.keys(kvar).length > 0 ? kvar : null
    })

  const skicka = (e: React.FormEvent) => {
    e.preventDefault()
    if (pågår.current) return
    const fel = bankkontoFältfel({ name, accountNumber }, befintliga)
    setFältfel(fel)
    setServerfel(null)
    if (fel) return
    const kropp = bankkontoNyttolast({ name, accountNumber })
    // Sista grinden mot SAMMA schema som API:ts DTO deklarerar `implements` mot.
    // Talar den har formulärets egna regler och kontraktet glidit isär, och då
    // är det kontraktet som gäller.
    const kontrakt = kontraktsfel(CreateBankAccountSchema, kropp)
    if (kontrakt) {
      setServerfel(kontrakt)
      return
    }
    pågår.current = true
    mutation.mutate(kropp, {
      onSuccess: (konto) => {
        setName('')
        setAccountNumber('')
        setFältfel(null)
        onSkapat(konto)
      },
      onError: (err) => {
        // 403 är ett NEKANDE, inte ett haveri — se `isForbidden`. Knappen ska
        // egentligen inte finnas för den rollen; svaret här är skyddsnätet om
        // rollen ändras medan sidan är öppen.
        setServerfel(
          isForbidden(err)
            ? 'Din roll får inte lägga upp bankkonton. Be en administratör göra det.'
            : // Serverns egen text när den finns: 409 säger exakt vilket namn
              // som redan är taget, och att formulera om den här hade gett två
              // versioner av samma besked.
              extractApiError(err, 'Kontot kunde inte sparas. Försök igen.'),
        )
      },
      onSettled: () => {
        pågår.current = false
      },
    })
  }

  return (
    <form onSubmit={skicka} className={kompakt ? 'space-y-3' : 'space-y-4'} noValidate>
      <Input
        id={`${idPrefix}-namn`}
        label="Namn på kontot"
        placeholder="t.ex. Företagskonto SEB"
        value={name}
        maxLength={BANKKONTO_NAMN_MAX}
        onChange={(e) => {
          setName(e.target.value)
          rensaFält('name')
        }}
        error={fältfel?.name}
        hint="Namnet är det du väljer på när du importerar. Det måste vara unikt inom organisationen."
      />
      <Input
        id={`${idPrefix}-nummer`}
        label="Kontonummer (valfritt)"
        placeholder="clearing + kontonummer, bankgiro eller IBAN"
        value={accountNumber}
        maxLength={BANKKONTO_NUMMER_MAX}
        onChange={(e) => {
          setAccountNumber(e.target.value)
          rensaFält('accountNumber')
        }}
        error={fältfel?.accountNumber}
        hint="Används bara för att KONTROLLERA att filen hör till rätt konto — aldrig för att välja konto åt dig."
      />
      {serverfel && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
          {serverfel}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onAvbryt && (
          <Button type="button" variant="ghost" onClick={onAvbryt} disabled={mutation.isPending}>
            Avbryt
          </Button>
        )}
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          Spara konto
        </Button>
      </div>
    </form>
  )
}

/**
 * VAD ETT IMPORTKONTO ÄR — och vad det inte är.
 *
 * Kundprovet visade en operatör som hamnade på PSD2-sidan ("Bankkoppling") när
 * importen krävde ett konto. De två orden ligger nära varandra i menyn och i
 * huvudet, och den ena går inte att använda i stället för den andra. Texten står
 * på ETT ställe och renderas på båda.
 */
export function ImportkontoForklaring({ kompakt = false }: { kompakt?: boolean }) {
  return (
    <p className={`text-[12px] leading-relaxed text-gray-500 ${kompakt ? '' : 'mt-1'}`}>
      Ett importkonto är <strong className="font-semibold text-gray-600">målet för importen</strong>{' '}
      — kontot som kontoutdraget kommer från, så att raderna hör till rätt konto. Det är inte
      bankgirot som står på fakturan, och inte en bankkoppling (PSD2), som hämtar transaktioner
      automatiskt.
    </p>
  )
}
