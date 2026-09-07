import React from 'react'

import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/cn'

interface Props {
  /** Inloggad roll. Bara OWNER får se växeln — grinden finns även i API:t. */
  roll: string | undefined
  pa: boolean
  /** Skuggagentens läge. Skarpt läge kräver den, och API:t avvisar annars. */
  skuggaPa: boolean
  onToggle: (varde: boolean) => void
  sparar?: boolean
}

/**
 * SKARPT LÄGE — agenten UTFÖR delegerade åtgärder själv.
 *
 * ── DEN LIGGER UNDER SKUGGAGENTEN, OCH ORDNINGEN ÄR BUDSKAPET ───────────────
 *
 * Man läser den ena efter den andra: först "föreslår, utför ingenting", sedan
 * "utför det du redan delegerat". Placerad ovanför hade den lästs först, och då
 * hade den viktigaste förutsättningen — att man sett vad agenten föreslår innan
 * man låter den handla — kommit efteråt.
 *
 * ── VÄXELN ÄR AVSTÄNGD NÄR SKUGGAN ÄR AV, OCH DET SÄGS ─────────────────────
 *
 * API:t avvisar ett påslag utan skugga med 400, och stänger skarpt läge när
 * skuggan stängs. Att bara gråa ut knappen utan att säga varför hade lämnat
 * hyresvärden att gissa.
 *
 * ── LÄNKEN TILL /delegationer ÄR INTE PYNT ──────────────────────────────────
 *
 * Växeln ensam gör ingenting: utan delegationer finns ingen rätt att utöva, och
 * agenten kommer att fälla domen `NO_DELEGATION` på allt. Den som slår på det
 * här behöver se vad hen faktiskt gett bort, och den sidan är det enda stället
 * där det står.
 */
export function SkarptLageSection({ roll, pa, skuggaPa, onToggle, sparar }: Props) {
  const arAgare = roll === 'OWNER'
  const kanSlaPa = skuggaPa

  return (
    <div className="flex items-start justify-between" data-testid="skarpt-lage">
      <div>
        <p className="text-[13.5px] font-medium text-gray-800">Låt agenten utföra åtgärder själv</p>
        <p className="text-[12px] text-gray-500">
          Agenten utför då de åtgärder du redan delegerat till den, utan att fråga varje gång. Den
          gör bara det som täcks av en aktiv delegation — allt annat hamnar som förslag i inkorgen.
        </p>
        <p className="mt-1 text-[12px] text-gray-500">
          Du ser varje utförd åtgärd under <span className="font-medium">Gjort</span> i inkorgen,
          med vilken delegation den skedde enligt.
        </p>
        <p className="mt-1 text-[12px]">
          <Link to="/delegationer" className="text-brand hover:underline">
            Se och ändra dina delegationer
          </Link>
        </p>
        {!skuggaPa && (
          <p className="text-warning-600 mt-1 text-[12px]">
            Kräver att skuggagenten är på — agenten kan inte utföra något den inte har föreslagit.
          </p>
        )}
        {!arAgare && (
          <p className="mt-1 text-[12px] text-gray-400">
            Bara organisationens ägare kan ändra den här inställningen.
          </p>
        )}
      </div>
      {arAgare && (
        <button
          type="button"
          aria-label="Slå på eller av att agenten utför åtgärder själv"
          disabled={sparar || !kanSlaPa}
          onClick={() => onToggle(!pa)}
          className={cn(
            'relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            pa ? 'bg-brand' : 'bg-gray-200',
            (sparar || !kanSlaPa) && 'opacity-50',
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
