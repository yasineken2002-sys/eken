import React, { useEffect, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Props {
  /** Inloggad roll. Bara OWNER får ändra; grinden finns även i API:t. */
  roll: string | undefined
  /** Nuvarande gräns i ÖREN, som den ligger i organisationen. */
  gransOre: number
  /** Spara. Får ÖREN — omräkningen från kronor bor här, inte hos anroparen. */
  onSpara: (gransOre: number) => void
  sparar?: boolean
}

/**
 * VÄSENTLIGHETSGRÄNSEN FÖR SEN BOKFÖRING.
 *
 * ── HJÄLPTEXTEN ÄR MÄTT, INTE GISSAD ────────────────────────────────────────
 *
 * Gränsen styr EN sak: om en sent bokförd post får `materialityFlagged` i sitt
 * spår. Uppräkningen av vad som läser den flaggan gav noll träffar utanför
 * skrivningen — ingen spärr, ingen varning, inget extra krav på operatören.
 * Texten nedan säger därför "markeras för granskning" och INTE "varnar" eller
 * "stoppar". En hjälptext som lovar en spärr som inte finns är värre än ingen
 * hjälptext: den får någon att tro att systemet vaktar åt dem.
 *
 * ── KRONOR I FÄLTET, ÖREN I DATABASEN ───────────────────────────────────────
 *
 * Operatören tänker i kronor; kolumnen är ören (heltal, av samma skäl som
 * beloppen i övrigt). Omräkningen sker HÄR och på ett ställe, så att ingen
 * anropare behöver känna till att fältet har en annan enhet än det som visas.
 */
export function LateBookingMaterialitySection({ roll, gransOre, onSpara, sparar }: Props) {
  const arAgare = roll === 'OWNER'
  const [kronor, setKronor] = useState(String(Math.round(gransOre / 100)))

  // Följ med när organisationen laddats om — annars visar fältet ett gammalt
  // värde efter att någon annan ändrat gränsen.
  useEffect(() => {
    setKronor(String(Math.round(gransOre / 100)))
  }, [gransOre])

  const talet = Number(kronor.replace(/\s/g, '').replace(',', '.'))
  const giltigt = Number.isFinite(talet) && talet >= 0
  const andrat = giltigt && Math.round(talet * 100) !== gransOre

  return (
    <div data-testid="vasentlighetsgrans">
      <p className="text-[13.5px] font-medium text-gray-800">
        Väsentlighetsgräns för sen bokföring
      </p>
      <p className="text-[12px] text-gray-500">
        En betalning som inträffade i ett stängt räkenskapsår bokförs på första öppna dag, med
        betalningsdatumet bevarat. Är beloppet minst den här gränsen{' '}
        <strong className="font-medium">markeras posten för granskning</strong> — ett väsentligt
        belopp kan behöva justera ingående eget kapital i stället för att löpa genom årets resultat.
      </p>
      <p className="mt-1 text-[12px] text-gray-400">
        Gränsen varken stoppar eller varnar vid registreringen. Den avgör bara vilka poster som
        pekas ut för efterhandsgranskning.
      </p>

      {arAgare ? (
        <div className="mt-3 flex items-end gap-2">
          <div className="w-40">
            <Input
              label="Gräns (kr)"
              type="number"
              min={0}
              step="1"
              value={kronor}
              aria-label="Väsentlighetsgräns i kronor"
              onChange={(e) => setKronor(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="primary"
            disabled={!andrat || sparar}
            onClick={() => onSpara(Math.round(talet * 100))}
          >
            {sparar ? 'Sparar…' : 'Spara'}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-gray-400">
          Nuvarande gräns: {Math.round(gransOre / 100).toLocaleString('sv-SE')} kr. Bara
          organisationens ägare kan ändra den här inställningen.
        </p>
      )}
    </div>
  )
}
