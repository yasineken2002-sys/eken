import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { WorkOrderResponseInput } from '@eken/shared'
import { WorkOrderResponseSchema } from '@eken/shared'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { kontraktsfel } from '@/lib/contract-gate'

import { respondToWorkOrder } from './api/contractors.api'

/**
 * HANTVERKARENS SVARSSIDA — publik, utan inloggning.
 *
 * Token i URL:en är den enda behörigheten. Sidan visar MED FLIT ingenting om
 * ärendet: den som har länken ska kunna svara, inte läsa. Uppgifterna stod i
 * mejlet, som gick till en känd adress; en sida som återger dem hade gjort
 * länken till en läsyta för var och en den vidarebefordrats till.
 *
 * Alla avslag ser likadana ut — utgången, förbrukad, påhittad. Ett svar som
 * skiljer dem åt berättar för den som gissar vilka token som funnits.
 */
export function WorkOrderResponsePage() {
  const { token } = useParams({ strict: false }) as { token?: string }
  const [note, setNote] = useState('')
  const [proposedAt, setProposedAt] = useState('')
  const [utfall, setUtfall] = useState<'ACCEPTED' | 'DECLINED' | null>(null)
  const [fel, setFel] = useState<string | null>(null)
  const [skickar, setSkickar] = useState(false)

  const svara = async (accepterar: boolean) => {
    setFel(null)
    setSkickar(true)
    try {
      const kropp: WorkOrderResponseInput = {
        accepterar,
        ...(accepterar && proposedAt ? { proposedAt } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }
      const kontrakt = kontraktsfel(WorkOrderResponseSchema, kropp)
      if (kontrakt) {
        setFel(kontrakt)
        return
      }
      const svar = await respondToWorkOrder(token ?? '', kropp)
      setUtfall(svar.status === 'ACCEPTED' ? 'ACCEPTED' : 'DECLINED')
    } catch {
      setFel('Länken är inte längre giltig. Kontakta hyresvärden.')
    } finally {
      setSkickar(false)
    }
  }

  if (utfall) {
    return (
      <div className="border-line bg-surface mx-auto mt-16 max-w-md rounded-2xl border p-6 text-center">
        {utfall === 'ACCEPTED' ? (
          <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-600" strokeWidth={1.8} />
        ) : (
          <XCircle className="mx-auto h-6 w-6 text-gray-400" strokeWidth={1.8} />
        )}
        <h1 className="mt-3 text-[17px] font-semibold text-gray-900">Tack för svaret</h1>
        <p className="mt-1 text-[13px] text-gray-500">
          {utfall === 'ACCEPTED'
            ? 'Hyresvärden har fått besked om att du tar jobbet.'
            : 'Hyresvärden har fått besked om att du inte kan ta jobbet.'}
        </p>
      </div>
    )
  }

  return (
    <div className="border-line bg-surface mx-auto mt-16 max-w-md rounded-2xl border p-6">
      <h1 className="text-[17px] font-semibold text-gray-900">Arbetsorder</h1>
      <p className="mt-1 text-[13px] text-gray-500">
        Uppgifterna finns i mejlet du fick. Svara nedan.
      </p>

      <div className="mt-5 space-y-3">
        <Input
          label="Föreslagen tid (valfritt)"
          type="date"
          value={proposedAt}
          onChange={(e) => setProposedAt(e.target.value)}
          hint="Ett förslag — hyresvärden hör av sig om det inte passar."
        />
        <div>
          <label className="block text-[13px] font-medium text-gray-700" htmlFor="wo-note">
            Meddelande (valfritt)
          </label>
          <textarea
            id="wo-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-[13.5px] text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
          />
        </div>
      </div>

      {fel ? <p className="mt-3 text-[12px] text-red-500">{fel}</p> : null}

      <div className="border-line mt-5 flex gap-2 border-t pt-4">
        <Button variant="primary" disabled={skickar} onClick={() => void svara(true)}>
          Jag tar det
        </Button>
        <Button variant="secondary" disabled={skickar} onClick={() => void svara(false)}>
          Jag kan inte
        </Button>
      </div>
    </div>
  )
}
