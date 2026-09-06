import React from 'react'

import { Lightbulb } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { formatDate } from '@eken/shared'

import { useAntaganden, useAvvisaAntagande, useBekraftaAntagande } from '../hooks/useAntaganden'

import type { Antagande } from '../api/delegationer.api'

const TYPTEXT: Record<Antagande['type'], string> = {
  preference: 'Preferens',
  fact: 'Fakta',
  relationship: 'Relation',
  convention: 'Konvention',
}

/**
 * ANTAGANDEN — vad systemet TROR, men ingen har sagt.
 *
 * ── DEN ANDRA HALVAN AV "SE VAD SYSTEMET TROR OM HEN" ───────────────────────
 *
 * Tabellen ovanför visar vad hyresvärden HAR gett bort. Den här visar vad som
 * ligger och väntar på ett ja eller ett nej — poster som en modell skrev när den
 * sammanfattade ett samtal, och som därför INTE läses in i någon agentprompt
 * förrän någon svarat på dem.
 *
 * Att de inte läses är inte synligt i sig, och därför står det i texten: annars
 * ser sektionen ut som en lista över vad agenten redan använder.
 *
 * ── AVVISA RADERAR INTE ─────────────────────────────────────────────────────
 *
 * Planens Del 7: *"Att säga nej är också lärande."* Raden står kvar med en
 * tidsstämpel och försvinner ur listan — men extraktionen upsertar på nyckeln,
 * så en raderad post hade återuppstått nästa gång ämnet kom upp, och nejet hade
 * varit borta utan att någon märkte det.
 */
export function Antaganden() {
  const lista = useAntaganden()
  const bekräfta = useBekraftaAntagande()
  const avvisa = useAvvisaAntagande()

  const rader = lista.data ?? []
  const sparar = bekräfta.isPending || avvisa.isPending

  // TOMT ÄR ETT UTFALL. Att sektionen försvinner helt hade gjort det omöjligt
  // att skilja "inget att svara på" från "funktionen finns inte".
  const kolumner = [
    {
      key: 'key',
      header: 'Systemet tror',
      cell: (a: Antagande) => (
        <div className="leading-tight">
          <div className="font-medium">{a.key}</div>
          <div className="mt-0.5 text-[12px] text-gray-500">{a.value}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Slag',
      cell: (a: Antagande) => <Badge variant="default">{TYPTEXT[a.type]}</Badge>,
    },
    {
      key: 'updatedAt',
      header: 'Senast sett',
      cell: (a: Antagande) => <span className="text-gray-700">{formatDate(a.updatedAt)}</span>,
    },
    {
      key: 'svar',
      header: '',
      align: 'right' as const,
      cell: (a: Antagande) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="xs" disabled={sparar} onClick={() => bekräfta.mutate(a.id)}>
            Bekräfta
          </Button>
          <Button variant="ghost" size="xs" disabled={sparar} onClick={() => avvisa.mutate(a.id)}>
            Avvisa
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="mt-10">
      <div className="flex items-start gap-2">
        <Lightbulb size={16} strokeWidth={1.8} className="mt-0.5 text-gray-400" />
        <div>
          <h2 className="text-[14px] font-semibold text-gray-900">Antaganden</h2>
          <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-gray-500">
            Det här har systemet gissat sig till ur era samtal. Ingenting av det används av agenten
            förrän du bekräftat det — och det du avvisar sparas som ett nej, så att samma gissning
            inte kommer tillbaka.
          </p>
        </div>
      </div>

      <div className="mt-4">
        {rader.length === 0 && !lista.isLoading ? (
          <p className="text-[13px] text-gray-500">Inga antaganden väntar på svar.</p>
        ) : (
          <DataTable
            columns={kolumner}
            data={rader}
            keyExtractor={(a) => a.id}
            loading={lista.isLoading}
          />
        )}
      </div>
    </div>
  )
}
