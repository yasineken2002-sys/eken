import React, { useEffect, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { delegationVerktygstext, delegationVillkorsnamn } from '@eken/shared'

import type { Frekvensvillkor } from '@eken/shared'
import type { KanDelegera } from '../api/inbox.api'

interface Props {
  status: string
  kan: KanDelegera | undefined
  toolName: string
  laddar?: boolean | undefined
  sparar?: boolean | undefined
  onSkapa: (
    villkor: Record<string, unknown> | undefined,
    frekvensvillkor: Frekvensvillkor | undefined,
  ) => void
}

/**
 * KARTAN BOR I `@eken/shared`, INTE HÄR.
 *
 * Den låg i den här filen fram till etapp 7 PR 3, då delegationssidan blev en
 * andra läsare av samma rättighet — den ena beskriver den innan den ges, den
 * andra efteråt. Två kopior hade glidit isär, och utfallet är det värsta
 * tänkbara just här: hyresvärden godkänner en mening och läser sedan en annan
 * om samma sak, utan att något blivit rött.
 *
 * `klartext` står kvar som en re-export därför att den är den här komponentens
 * publika yta och prövas av dess spec — men den är inte längre en egen karta.
 */
export const klartext = delegationVerktygstext

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

  // ── TAKET, FÖRIFYLLT AV SERVERN ──────────────────────────────────────────
  //
  // Fälten finns BARA för de verktyg vars deklaration är `DEDUPLICERBAR`, och
  // vilka de är avgör servern (`kan.kräverFrekvensvillkor`). Ingen lista här:
  // en uppräkning i webben hade blivit en andra källa till samma regel.
  //
  // Startvärdet läses ur serverns förifyllda tak. Ett hårdkodat tal här hade
  // kunnat glida från konstanten i API:t, och glidningen hade betytt att
  // hyresvärden godkänner ett annat tak än det som sedan gäller.
  const [maxAntal, setMaxAntal] = useState('')
  const [periodDagar, setPeriodDagar] = useState('')

  useEffect(() => {
    const f = kan?.förifylltFrekvensvillkor
    if (!f) return
    setMaxAntal(String(f.maxAntal))
    setPeriodDagar(String(f.periodDagar))
  }, [kan?.förifylltFrekvensvillkor?.maxAntal, kan?.förifylltFrekvensvillkor?.periodDagar])

  // Bara för GODKÄNDA förslag. Ett avslaget eller väntande har inget mönster att
  // bygga en vana på.
  if (status !== 'APPROVED') return null

  const villkor = kan?.förifylltVillkor ?? {}

  // TALEN TOLKAS EN GÅNG, och giltigheten är samma regel som serverns
  // `giltigFrekvens`: heltal, minst 1. Ett tak på noll är inte ett tak — det är
  // en avstängning i förklädnad, och den formen avvisas av schemat.
  // `Number`, INTE `parseInt`. `parseInt('2,5')` ger 2 och trunkerar tyst — och
  // en tyst trunkering i just det här fältet betyder att hyresvärden godkänner
  // ett annat tak än det hen skrev. `Number('2.5')` ger 2.5, som faller på
  // `Number.isInteger` nedan, och då SYNS felet.
  const antal = maxAntal.trim() === '' ? Number.NaN : Number(maxAntal)
  const period = periodDagar.trim() === '' ? Number.NaN : Number(periodDagar)
  const frekvensGiltig =
    Number.isInteger(antal) && antal >= 1 && Number.isInteger(period) && period >= 1
  const krävsTak = kan?.kräverFrekvensvillkor === true

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
            <dt className="w-40 shrink-0 text-gray-500">{delegationVillkorsnamn(nyckel)}</dt>
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
        {krävsTak && (
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-gray-500">Högst</dt>
            <dd className="flex items-center gap-1.5 text-gray-900">
              <input
                aria-label="Högsta antal"
                type="number"
                min={1}
                value={maxAntal}
                onChange={(e) => setMaxAntal(e.target.value)}
                className="h-8 w-16 rounded-lg border border-gray-200 bg-white px-2 text-[13px] text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
              />
              <span>gånger per</span>
              <input
                aria-label="Antal dagar"
                type="number"
                min={1}
                value={periodDagar}
                onChange={(e) => setPeriodDagar(e.target.value)}
                className="h-8 w-16 rounded-lg border border-gray-200 bg-white px-2 text-[13px] text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
              />
              <span>dagar</span>
            </dd>
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
      {krävsTak && (
        <p className="mt-3 text-[12px] text-gray-500">
          {/* VARFÖR TAKET FINNS, i klartext. Utan meningen ser fälten ut som en
              inställning man kan hoppa över — och servern avvisar då hela
              delegationen med ett fel som läses som ett gränssnittsfel. */}
          Det här verktyget kan skapa en ny rad varje gång det körs. Taket finns för att en obevakad
          körning inte ska kunna bli obegränsad.
          {!frekvensGiltig && (
            <span className="ml-1 text-red-500">Ange minst 1 gång och minst 1 dag.</span>
          )}
        </p>
      )}
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
          // SPÄRRAD PÅ SAMMA REGEL SOM SERVERN. Ett ogiltigt tak ska inte kunna
          // skickas — men gråheten är en artighet: `skapa` prövar `giltigFrekvens`
          // på nytt, och det är den kontrollen som bär.
          disabled={sparar || (krävsTak && !frekvensGiltig)}
          onClick={() =>
            onSkapa(
              Object.keys(villkor).length > 0 ? villkor : undefined,
              krävsTak ? { maxAntal: antal, periodDagar: period } : undefined,
            )
          }
        >
          Ja, delegera
        </Button>
      </div>
    </div>
  )
}
