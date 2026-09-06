import React from 'react'

import { Input } from '@/components/ui/Input'
import { SEN_BOKFORING_MIN_SKAL, SEN_BOKFORING_MAX_SKAL } from '@eken/shared'

interface Props {
  /** Inloggad roll. Bara OWNER får bokföra sent — grinden finns även i API:t. */
  roll: string | undefined
  /** Räkenskapsårets namn för texten: `2025` eller `2025/2026`. */
  arsetikett: string
  skal: string
  onSkalChange: (v: string) => void
}

/** Är skälet långt nog för att API:t ska ta emot det? */
export function skalDugerForSenBokforing(skal: string): boolean {
  return skal.trim().length >= SEN_BOKFORING_MIN_SKAL
}

/**
 * RÄKENSKAPSÅRET ÄR STÄNGT — blocket i de två manuella betalningsdialogerna.
 *
 * ── EN KOMPONENT, TVÅ DIALOGER ──────────────────────────────────────────────
 *
 * Fakturan och avin ställer samma fråga och måste ge samma svar. Två kopior av
 * den här texten hade glidit isär, och den som glider är förklaringen av vad
 * som händer med pengarna — inte en etikett.
 *
 * ── MIN-LÄNGDEN LÄSES, DEN SKRIVS INTE ──────────────────────────────────────
 *
 * `SEN_BOKFORING_MIN_SKAL` kommer från @eken/shared, samma konstant som DTO:n
 * och Zod-schemat använder. Ett eget tal här hade betytt att klienten släpper
 * igenom något servern avvisar (eller tvärtom) första gången någon ändrar
 * gränsen på ett av ställena.
 *
 * ── VARFÖR ÄGAREN, OCH VAD ANDRA SER ────────────────────────────────────────
 *
 * Ett stängt räkenskapsår kan inte öppnas igen, så beslutet att lägga posten i
 * ett annat år går inte att ångra. API:t kräver OWNER (`assertFarBokforaSent`);
 * det här döljer bara ett fält som ändå hade gett 403. En MANAGER ser i stället
 * varför hen inte kan fortsätta — en tom dialog utan förklaring hade sett ut som
 * ett fel i systemet.
 *
 * ── STÄNGD MÅNAD ÄR NÅGOT ANNAT ─────────────────────────────────────────────
 *
 * Blocket visas BARA för ett stängt räkenskapsår. En stängd månad i ett öppet år
 * har en spårad återöppningsväg, och servern avvisar den med ett meddelande som
 * pekar dit. Att erbjuda en flytt förbi den hade kringgått ett medvetet
 * mänskligt beslut.
 */
export function SenBokforingBlock({ roll, arsetikett, skal, onSkalChange }: Props) {
  const arAgare = roll === 'OWNER'
  const forKort = skal.trim().length > 0 && !skalDugerForSenBokforing(skal)

  return (
    <div data-testid="sen-bokforing" className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <p className="text-[13px] font-medium text-amber-800">
        Räkenskapsåret {arsetikett} är stängt
      </p>
      <p className="mt-1 text-[12px] text-amber-700">
        Ett stängt räkenskapsår kan inte öppnas igen. Betalningen bokförs på{' '}
        <strong className="font-medium">första öppna dag</strong>, och betalningsdatumet du valt
        bevaras på verifikatet och i ett spår som visar varför.
      </p>

      {arAgare ? (
        <div className="mt-3">
          <Input
            label="Skäl"
            placeholder="Varför bokförs betalningen först nu?"
            value={skal}
            aria-label="Skäl till sen bokföring"
            maxLength={SEN_BOKFORING_MAX_SKAL}
            onChange={(e) => onSkalChange(e.target.value)}
            {...(forKort
              ? { error: `Skälet måste vara minst ${SEN_BOKFORING_MIN_SKAL} tecken` }
              : {})}
          />
          <p className="mt-1 text-[12px] text-amber-700">
            Skälet sparas i verifikatets spår och går inte att ändra efteråt.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-amber-700" data-testid="sen-bokforing-ej-agare">
          Bara organisationens ägare kan registrera en betalning i ett stängt räkenskapsår. Beslutet
          går inte att ångra.
        </p>
      )}
    </div>
  )
}
