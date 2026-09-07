import { useMemo, useState } from 'react'
import { Hammer } from 'lucide-react'
import type { AssignContractorInput, MaintenanceCategoryValue } from '@eken/shared'
import { AssignContractorSchema, MAINTENANCE_CATEGORY_ETIKETT } from '@eken/shared'

import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { kontraktsfel } from '@/lib/contract-gate'

import { useAssignContractor, useContractors } from '../hooks/useContractors'

interface Props {
  ticketId: string
  category: MaintenanceCategoryValue
  assigned: { id: string; name: string; email: string | null; phone: string | null } | null
}

/**
 * TILLDELA HANTVERKARE på felanmälans detaljvy.
 *
 * Listan filtreras på ärendets KATEGORI som förval — det är nästan alltid rätt
 * mängd, och att visa alla hade gjort valet till en sökning. Men filtret går
 * att stänga av: en hantverkare utan angiven kategori, eller en som råkar kunna
 * något utöver sina angivna, ska gå att välja utan att först redigeras.
 *
 * Bara AKTIVA hantverkare hämtas. En avaktiverad kan inte tilldelas (servern
 * avvisar), och att visa den i väljaren hade gjort felet till användarens.
 */
export function AssignContractorCard({ ticketId, category, assigned }: Props) {
  const [visaAlla, setVisaAlla] = useState(false)
  const [valt, setValt] = useState<string>(assigned?.id ?? '')
  const [fel, setFel] = useState<string | null>(null)

  const filter = useMemo(
    () => (visaAlla ? { activeOnly: true } : { activeOnly: true, category }),
    [visaAlla, category],
  )
  const { data: hantverkare = [], isLoading } = useContractors(filter)
  const tilldela = useAssignContractor()

  const skicka = (contractorId: string | null) => {
    setFel(null)
    const kropp: AssignContractorInput = { contractorId }
    const kontrakt = kontraktsfel(AssignContractorSchema, kropp)
    if (kontrakt) {
      setFel(kontrakt)
      return
    }
    tilldela.mutate({ ticketId, input: kropp })
  }

  return (
    <div className="border-line bg-surface rounded-2xl border p-4">
      <div className="flex items-center gap-2">
        <Hammer className="h-3.5 w-3.5 text-gray-400" strokeWidth={1.8} />
        <h4 className="text-[14px] font-semibold text-gray-900">Hantverkare</h4>
      </div>

      {assigned ? (
        <div className="mt-3 rounded-xl bg-gray-50 p-3">
          <p className="text-[13.5px] font-medium text-gray-900">{assigned.name}</p>
          <p className="text-[12px] text-gray-500">
            {assigned.email ?? 'Ingen e-post'}
            {assigned.phone ? ` · ${assigned.phone}` : ''}
          </p>
          <Button
            variant="ghost"
            size="xs"
            className="mt-2"
            disabled={tilldela.isPending}
            onClick={() => {
              setValt('')
              skicka(null)
            }}
          >
            Ta bort tilldelning
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-gray-400">Ingen hantverkare är tilldelad ännu.</p>
      )}

      <div className="mt-3 space-y-2">
        <label className="block text-[13px] font-medium text-gray-700" htmlFor="valj-hantverkare">
          {assigned ? 'Byt till' : 'Tilldela'}
        </label>
        <select
          id="valj-hantverkare"
          value={valt}
          onChange={(e) => setValt(e.target.value)}
          disabled={isLoading || tilldela.isPending}
          className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3.5 text-[13.5px] text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
        >
          <option value="">Välj hantverkare…</option>
          {hantverkare.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
              {h.email ? '' : ' (saknar e-post)'}
            </option>
          ))}
        </select>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setVisaAlla((v) => !v)}
            className="text-[12px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
          >
            {visaAlla
              ? `Visa bara ${MAINTENANCE_CATEGORY_ETIKETT[category]}`
              : 'Visa alla kategorier'}
          </button>
          {!visaAlla ? (
            <Badge variant="default">{MAINTENANCE_CATEGORY_ETIKETT[category]}</Badge>
          ) : null}
        </div>

        {!isLoading && hantverkare.length === 0 ? (
          <p className="text-[12px] text-gray-400">
            {visaAlla
              ? 'Registret är tomt. Lägg till hantverkare under Hantverkare.'
              : `Ingen hantverkare har ${MAINTENANCE_CATEGORY_ETIKETT[category]} som kategori.`}
          </p>
        ) : null}

        {fel ? <p className="text-[12px] text-red-500">{fel}</p> : null}

        <Button
          variant="primary"
          size="sm"
          disabled={!valt || valt === assigned?.id || tilldela.isPending}
          onClick={() => skicka(valt)}
        >
          {tilldela.isPending ? 'Tilldelar…' : 'Tilldela'}
        </Button>
      </div>
    </div>
  )
}
