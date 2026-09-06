import React, { useState } from 'react'

import { Button } from '@/components/ui/Button'

import type { KanDelegera } from '../api/inbox.api'

interface Props {
  status: string
  kan: KanDelegera | undefined
  toolName: string
  laddar?: boolean | undefined
  sparar?: boolean | undefined
  onSkapa: (villkor: Record<string, unknown> | undefined) => void
}

/** Verktygsnamn i klartext. Aldrig en teknisk term i en bekräftelse. */
const KLARTEXT: Record<string, string> = {
  create_property: 'lägga upp en fastighet',
  create_unit: 'lägga upp en lägenhet',
  create_invoice: 'skapa ett fakturautkast',
  create_inspection: 'planera en besiktning',
  create_maintenance_ticket: 'lägga upp ett ärende',
  update_maintenance_status: 'ändra status på ett ärende',
  generate_rent_notices: 'skapa månadens hyresavier',
  import_bgmax_file: 'läsa in en bankfil',
}

/** Villkorets fält i klartext, i den ordning en människa läser dem. */
const VILLKORSNAMN: Record<string, string> = {
  category: 'Typ av ärende',
  propertyId: 'Fastighet',
  unitId: 'Lägenhet',
  maxBelopp: 'Högsta belopp',
}

export function klartext(toolName: string): string {
  return KLARTEXT[toolName] ?? toolName
}

/**
 * "GÖR ALLTID SÅ HÄR" — knappen som föder en delegation.
 *
 * ── GRÅ TILLS MÖNSTRET FINNS, OCH SKÄLET STÅR UTSKRIVET ─────────────────────
 *
 * Planens Del 6 talar om ett MÖNSTER — *"du har godkänt det här sju gånger"* —
 * inte om en enskild händelse. Ett enda ja kan vara ett undantag; två är en vana.
 *
 * Knappen är därför grå efter det första godkännandet, med serverns egen text
 * som förklaring. En grå knapp utan skäl läses som ett fel i gränssnittet.
 *
 * ── OCH GRÅHETEN ÄR EN ARTIGHET, INTE SPÄRREN ───────────────────────────────
 *
 * `POST` prövar samma villkor på nytt. Det står i tjänsten, och det är därför
 * knappen får läsa serverns svar rakt av i stället för att räkna själv.
 */
export function GorAlltidSaHar({ status, kan, toolName, laddar, sparar, onSkapa }: Props) {
  const [bekraftar, setBekraftar] = useState(false)

  // Bara för GODKÄNDA förslag. Ett avslaget eller väntande har inget mönster att
  // bygga en vana på.
  if (status !== 'APPROVED') return null

  const villkor = kan?.förifylltVillkor ?? {}

  if (!bekraftar) {
    return (
      <div className="border-line mt-4 border-t pt-4">
        <Button
          variant="secondary"
          disabled={!kan?.kan || laddar}
          onClick={() => setBekraftar(true)}
        >
          Gör alltid så här
        </Button>
        {!kan?.kan && (
          <p className="mt-1 text-[12px] text-gray-500">
            {laddar ? 'Kontrollerar…' : (kan?.skäl ?? 'Kan inte delegeras.')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="border-line mt-4 border-t pt-4" data-testid="delegationsbekraftelse">
      <p className="text-[13px] font-medium text-gray-800">Det här delegerar du:</p>
      <dl className="mt-2 space-y-1 text-[13px]">
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-gray-500">Agenten får</dt>
          <dd className="text-gray-900">{klartext(toolName)}</dd>
        </div>
        {Object.entries(villkor).map(([nyckel, varde]) => (
          <div key={nyckel} className="flex gap-2">
            <dt className="w-40 shrink-0 text-gray-500">{VILLKORSNAMN[nyckel] ?? nyckel}</dt>
            <dd className="text-gray-900">{String(varde)}</dd>
          </div>
        ))}
        {Object.keys(villkor).length === 0 && (
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-gray-500">Avgränsning</dt>
            {/* NULL BETYDER UTAN AVGRÄNSNING, och det ska SYNAS. En tom rad hade
                fått den bredaste möjliga rätten att se ut som en detalj. */}
            <dd className="text-gray-900">Utan avgränsning — gäller hela organisationen</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-gray-500">Löper ut</dt>
          <dd className="text-gray-900">om 90 dagar</dd>
        </div>
      </dl>
      {/* MENINGEN LÄSES UR SERVERNS KONSTANT, inte ur prosa här. Den dag
          utföraren finns sätts flaggan i samma PR som bygger den, och texten
          försvinner av sig själv i stället för att bli en osanning. */}
      {kan && !kan.utförareFinns && (
        <p className="mt-3 text-[12px] text-gray-500">
          Agenten utför fortfarande ingenting förrän utföraren finns.
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setBekraftar(false)}>
          Tillbaka
        </Button>
        <Button
          variant="primary"
          disabled={sparar}
          onClick={() => onSkapa(Object.keys(villkor).length > 0 ? villkor : undefined)}
        >
          Ja, delegera
        </Button>
      </div>
    </div>
  )
}
