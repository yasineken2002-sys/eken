import { useState } from 'react'
import type { CreateContractorInput, MaintenanceCategoryValue } from '@eken/shared'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_ETIKETT } from '@eken/shared'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { kontraktsfel } from '@/lib/contract-gate'
import { CreateContractorSchema } from '@eken/shared'
import { cn } from '@/lib/cn'

interface Props {
  initial?: Partial<CreateContractorInput>
  sparar: boolean
  onSubmit: (input: CreateContractorInput) => void
  onCancel: () => void
}

/**
 * `useState`-formulär, inte react-hook-form. Det är husets vanligaste mönster
 * (36 av 56 formulär), och kategorivalet är en knappmatris snarare än ett fält
 * en resolver har något att fästa i.
 *
 * Grinden nedan ger ändå samma RUNTIME-egenskap som en resolver: nyttolasten
 * prövas mot SAMMA schema som API:ts DTO är bunden till. Fältvisa fel ägs av
 * `fel()`, som körs före — grinden är ett sista nej, inte vägledningen.
 */
export function ContractorForm({ initial, sparar, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [contactPerson, setContactPerson] = useState(initial?.contactPerson ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [orgNumber, setOrgNumber] = useState(initial?.orgNumber ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [categories, setCategories] = useState<MaintenanceCategoryValue[]>(
    initial?.categories ?? [],
  )
  const [serverfel, setServerfel] = useState<string | null>(null)

  const namnFel = name.trim().length > 0 && name.trim().length < 2 ? 'Minst 2 tecken' : undefined

  const vaxla = (k: MaintenanceCategoryValue) =>
    setCategories((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]))

  const skicka = () => {
    setServerfel(null)
    if (!name.trim() || namnFel) return
    // ANNOTERAD literal — utan `: CreateContractorInput` kör TypeScript ingen
    // överskottskontroll, och ett fält som finns här men inte i kontraktet hade
    // passerat tyst.
    const kropp: CreateContractorInput = {
      name: name.trim(),
      ...(contactPerson.trim() ? { contactPerson: contactPerson.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(orgNumber.trim() ? { orgNumber: orgNumber.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(categories.length ? { categories } : {}),
    }
    const kontrakt = kontraktsfel(CreateContractorSchema, kropp)
    if (kontrakt) {
      setServerfel(kontrakt)
      return
    }
    onSubmit(kropp)
  }

  return (
    <div className="space-y-4">
      <Input
        label="Namn"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Rör & Värme AB"
        {...(namnFel ? { error: namnFel } : {})}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Kontaktperson"
          value={contactPerson}
          onChange={(e) => setContactPerson(e.target.value)}
        />
        <Input
          label="Organisationsnummer"
          value={orgNumber}
          onChange={(e) => setOrgNumber(e.target.value)}
          placeholder="556000-0001"
        />
        <Input
          label="E-post"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="Krävs för att kunna skicka arbetsorder"
        />
        <Input label="Telefon" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>

      <div>
        <span className="mb-2 block text-[13px] font-medium text-gray-700">Yrkeskategorier</span>
        <div className="flex flex-wrap gap-2">
          {MAINTENANCE_CATEGORIES.map((k) => {
            const vald = categories.includes(k)
            return (
              <button
                key={k}
                type="button"
                onClick={() => vaxla(k)}
                aria-pressed={vald}
                className={cn(
                  'rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-150',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
                  vald
                    ? 'bg-brand text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900',
                )}
              >
                {MAINTENANCE_CATEGORY_ETIKETT[k]}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[12px] text-gray-400">
          Styr vilka hantverkare som föreslås när ett ärende ska tilldelas. Utan kategori föreslås
          hantverkaren bara under &quot;Alla&quot;.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-[13px] font-medium text-gray-700" htmlFor="notes">
          Anteckningar
        </label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-[13.5px] text-gray-900 placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
          placeholder="Jour dygnet runt, fakturerar per påbörjad timme…"
        />
      </div>

      {serverfel ? <p className="text-[12px] text-red-500">{serverfel}</p> : null}

      <div className="border-line mt-5 flex justify-end gap-2 border-t pt-4">
        <Button variant="secondary" onClick={onCancel} disabled={sparar}>
          Avbryt
        </Button>
        <Button variant="primary" onClick={skicka} disabled={sparar || !name.trim()}>
          {sparar ? 'Sparar…' : 'Spara'}
        </Button>
      </div>
    </div>
  )
}
