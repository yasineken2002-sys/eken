import React from 'react'

import { Button } from '@/components/ui/Button'

import { fraganInnehall } from '../api/inbox.api'

import type { InboxItem } from '../api/inbox.api'

/**
 * AGENTENS FRÅGA — svaras med ETT VÄRDE, aldrig med ja/nej.
 *
 * ── VARFÖR EGNA KNAPPAR OCH INTE BESLUTSVÄGEN ───────────────────────────────
 *
 * Ett beslut är ja eller nej; ett svar är ett val ur en mängd. Att trycka in
 * det i `godkänn`/`avvisa` hade krävt att skälet bar två olika saker beroende på
 * radens sort — och då kan ingen fråga besvaras utan att först veta vilken sorts
 * rad det är.
 *
 * ── ALTERNATIVEN KOMMER FRÅN SERVERN ────────────────────────────────────────
 *
 * De härleds ur fältets register i API:t. En lista här hade blivit fel första
 * gången någon lade till en kategori, och felet hade varit tyst: det rätta
 * svaret saknas bland knapparna, och hyresvärden tvingas välja något hen inte
 * menar.
 */
export function FragaKort({
  item,
  sparar,
  onSvara,
}: {
  item: InboxItem
  sparar?: boolean | undefined
  onSvara: (svar: string) => void
}) {
  const fråga = fraganInnehall(item)
  // FAIL-CLOSED: en fråga utan giltiga alternativ visas inte som besvarbar.
  if (!fråga) return null

  return (
    <div className="border-line mt-4 border-t pt-4" data-testid="fragekort">
      <p className="text-[13px] font-medium text-gray-800">Agenten frågar:</p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600">{item.title}</p>
      {fråga.användsTill && (
        <p className="mt-1 text-[12px] text-gray-500">
          {/* VAD SVARET LÅSER UPP. Planens Del 11: en fråga som inte låser upp
              något ska inte ställas — och den som svarar ska kunna se vad den
              låser upp innan hen lägger tid på den. */}
          Används till: {fråga.användsTill}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {fråga.alternativ.map((a) => (
          <Button
            key={a}
            variant="secondary"
            size="sm"
            disabled={sparar}
            onClick={() => onSvara(a)}
          >
            {a}
          </Button>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-gray-500">
        Ditt svar sparas som en bekräftad uppgift om ärendet och används av agentens nästa förslag.
        Ingenting utförs av att du svarar.
      </p>
    </div>
  )
}
