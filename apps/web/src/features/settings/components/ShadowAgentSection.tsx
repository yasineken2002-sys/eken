import React from 'react'

import { cn } from '@/lib/cn'

interface Props {
  /** Inloggad roll. Bara OWNER får se växeln — grinden finns även i API:t. */
  roll: string | undefined
  pa: boolean
  onToggle: (varde: boolean) => void
  /** Antal skuggförslag hittills. `undefined` medan summan hämtas. */
  antalForslag: number | undefined
  /** Sant medan skrivningen pågår — knappen ska inte gå att dubbelklicka. */
  sparar?: boolean
}

/**
 * SKUGGAGENTEN — växeln, och vad den faktiskt gör.
 *
 * ── VÄXELN ÄR DOLD FÖR ALLA UTOM ÄGAREN ─────────────────────────────────────
 *
 * Och det är ANDRA halvan av grinden, inte hela. `OrganizationsService` avvisar
 * en icke-ägare med 403 oavsett vad gränssnittet visar — det här döljer bara en
 * knapp som ändå inte hade fungerat. En dold knapp är en artighet; spärren
 * ligger i API:t.
 *
 * En ADMIN ser alltså texten och antalet förslag, men ingen växel. Det är
 * avsiktligt: hen ska kunna se ATT agenten är på utan att kunna ändra det.
 *
 * ── TEXTEN SÄGER VAD DEN INTE GÖR ───────────────────────────────────────────
 *
 * "Föreslår, utför inget" står här av samma skäl som i inkorgens
 * bekräftelseruta. Att slå på något som heter "agent" utan att veta att den bara
 * föreslår är precis den missuppfattning som gör ett skuggläge farligt.
 */
export function ShadowAgentSection({ roll, pa, onToggle, antalForslag, sparar }: Props) {
  const arAgare = roll === 'OWNER'

  return (
    <div className="flex items-center justify-between" data-testid="skuggagent">
      <div>
        <p className="text-[13.5px] font-medium text-gray-800">Skuggagent på felanmälningar</p>
        <p className="text-[12px] text-gray-500">
          Agenten läser nya felanmälningar och föreslår en åtgärd i inkorgen. Den utför ingenting —
          du bestämmer.
        </p>
        <p className="mt-1 text-[12px] text-gray-400">
          {antalForslag === undefined
            ? 'Hämtar antal förslag…'
            : `${antalForslag} förslag hittills.`}
        </p>
        {!arAgare && (
          <p className="mt-1 text-[12px] text-gray-400">
            Bara organisationens ägare kan ändra den här inställningen.
          </p>
        )}
      </div>
      {arAgare && (
        <button
          type="button"
          aria-label="Slå på eller av skuggagenten"
          disabled={sparar}
          onClick={() => onToggle(!pa)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            pa ? 'bg-blue-600' : 'bg-gray-200',
            sparar && 'opacity-50',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
              pa ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      )}
    </div>
  )
}
