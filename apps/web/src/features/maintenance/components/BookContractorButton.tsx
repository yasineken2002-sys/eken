import { useState } from 'react'
import { Send } from 'lucide-react'
import type { SendWorkOrderInput } from '@eken/shared'
import { SendWorkOrderSchema } from '@eken/shared'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { kontraktsfel } from '@/lib/contract-gate'

import { useSendWorkOrder } from '@/features/contractors/hooks/useContractors'

interface Props {
  ticketId: string
  ticketNumber: string
  contractor: { id: string; name: string; email: string | null }
  tenantHasContact: boolean
}

/**
 * BOKA — bekräftelse FÖRE skick, och det är inte en artighet.
 *
 * Mejlet lämnar organisationen och når en utomstående. Det går inte att ta
 * tillbaka; en avbokning är ett NYTT mejl, inte en ångring (se
 * `EFFECT_DECLARATIONS.book_contractor`, klassad IRREVERSIBEL). Dialogen visar
 * därför exakt vad som skickas och till vem innan något händer.
 *
 * Den här knappen är också verktygets `humanPath` — `HUMAN_PATHS.book_contractor`
 * pekar på `/maintenance` med åtgärden "Boka hantverkare". Försvinner den bryts
 * delmängdsregeln: agenten skulle kunna något hyresvärden inte kan.
 *
 * DÄRFÖR BOR FILEN I `features/maintenance/`, inte i `features/contractors/`:
 * `check-tool-human-path.mjs` letar efter åtgärdstexten i den feature-katalog
 * rutten pekar på. Den hittade den inte när knappen låg under contractors, och
 * det var inte en vaktbugg — knappen ÄR en åtgärd på ett ärende, och att den
 * går att hitta där man använder den är hela poängen med regeln.
 */
export function BookContractorButton({
  ticketId,
  ticketNumber,
  contractor,
  tenantHasContact,
}: Props) {
  const [oppen, setOppen] = useState(false)
  const [meddelande, setMeddelande] = useState('')
  const [delaKontakt, setDelaKontakt] = useState(false)
  const [fel, setFel] = useState<string | null>(null)
  const boka = useSendWorkOrder()

  const skicka = () => {
    setFel(null)
    const kropp: SendWorkOrderInput = {
      contractorId: contractor.id,
      ...(meddelande.trim() ? { meddelande: meddelande.trim() } : {}),
      ...(delaKontakt ? { delaHyresgastKontakt: true } : {}),
    }
    const kontrakt = kontraktsfel(SendWorkOrderSchema, kropp)
    if (kontrakt) {
      setFel(kontrakt)
      return
    }
    boka.mutate(
      { ticketId, input: kropp },
      {
        onSuccess: () => {
          setOppen(false)
          setMeddelande('')
          setDelaKontakt(false)
        },
        onError: (e) => setFel(e instanceof Error ? e.message : 'Arbetsordern kunde inte skickas.'),
      },
    )
  }

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={!contractor.email}
        onClick={() => setOppen(true)}
      >
        <Send className="h-3.5 w-3.5" strokeWidth={1.8} />
        Boka hantverkare
      </Button>
      {!contractor.email ? (
        <p className="mt-1 text-[12px] text-amber-700">
          {contractor.name} saknar e-postadress och kan inte bokas.
        </p>
      ) : null}

      <Modal
        open={oppen}
        onClose={() => setOppen(false)}
        title="Skicka arbetsorder"
        description="Mejlet går till hantverkaren och kan inte tas tillbaka."
      >
        <div className="space-y-4">
          <div className="rounded-xl bg-gray-50 p-3 text-[13px]">
            <p className="text-gray-900">
              <span className="font-medium">{contractor.name}</span> — {contractor.email}
            </p>
            <p className="mt-1 text-gray-500">
              Ärende {ticketNumber}. Hantverkaren får titel, beskrivning och adress, samt en länk
              för att tacka ja eller nej.
            </p>
          </div>

          <div>
            <label
              className="block text-[13px] font-medium text-gray-700"
              htmlFor="bokning-meddelande"
            >
              Meddelande (valfritt)
            </label>
            <textarea
              id="bokning-meddelande"
              value={meddelande}
              onChange={(e) => setMeddelande(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-[13.5px] text-gray-900 placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
              placeholder="Nyckel finns hos vaktmästaren…"
            />
          </div>

          {tenantHasContact ? (
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={delaKontakt}
                onChange={(e) => setDelaKontakt(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300"
              />
              <span className="text-[13px] text-gray-700">
                Dela hyresgästens kontaktuppgift så hantverkaren kan boka tid direkt
                <span className="mt-0.5 block text-[12px] text-gray-400">
                  Hyresgästen ser i sin portal att uppgiften delades, och med vem.
                </span>
              </span>
            </label>
          ) : null}

          {fel ? <p className="text-[12px] text-red-500">{fel}</p> : null}

          <div className="border-line mt-5 flex justify-end gap-2 border-t pt-4">
            <Button variant="secondary" onClick={() => setOppen(false)} disabled={boka.isPending}>
              Avbryt
            </Button>
            <Button variant="primary" onClick={skicka} disabled={boka.isPending}>
              {boka.isPending ? 'Skickar…' : 'Skicka arbetsorder'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
