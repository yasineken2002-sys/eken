import React, { useEffect, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'

export type Slag = 'pausa' | 'aterta' | 'forlang' | 'aterkalla'

export interface Atgard {
  slag: Slag
  id: string
  /** Verktyget i klartext — en bekräftelse visar aldrig ett tekniskt namn. */
  klartext: string
}

const TEXT: Record<Slag, { titel: string; brodtext: string; knapp: string; farlig: boolean }> = {
  pausa: {
    titel: 'Pausa delegationen',
    brodtext:
      'Agenten slutar handla på egen hand, men rättigheten finns kvar och slutdatumet ligger still. Du kan återuppta den när som helst.',
    knapp: 'Pausa',
    farlig: false,
  },
  aterta: {
    titel: 'Återuppta delegationen',
    brodtext:
      'Agenten får handla på egen hand igen — inom samma villkor och fram till samma slutdatum som förut.',
    knapp: 'Återuppta',
    farlig: false,
  },
  forlang: {
    titel: 'Förläng delegationen',
    brodtext:
      'Slutdatumet flyttas 90 dagar framåt, räknat från i dag. Nästa förlängning går tidigast om 30 dagar: utgångsdatumet finns för att tvinga fram ett omtag, och ett tak som går att kringgå med två klick är inget tak.',
    knapp: 'Förläng 90 dagar',
    farlig: false,
  },
  aterkalla: {
    titel: 'Återkalla delegationen',
    brodtext:
      'Rättigheten upphör permanent. En återkallad delegation går inte att väcka — den måste i så fall födas på nytt ur ett nytt godkännande i inkorgen. Raden blir kvar i listan: historiken ska kunna visa att rättigheten har funnits.',
    knapp: 'Återkalla',
    farlig: true,
  },
}

interface Props {
  atgard: Atgard | null
  sparar: boolean
  fel: string | null
  onClose: () => void
  onBekrafta: (skäl?: string) => void
}

/**
 * BEKRÄFTELSEN — alla fyra åtgärderna passerar den.
 *
 * ── OCKSÅ DE REVERSIBLA, OCH SKÄLET ÄR INTE SYMMETRI ────────────────────────
 *
 * En radåtgärd i en tabell träffar fel rad ungefär lika ofta som man klickar
 * fel. En pausad delegation som ingen märkte pausades ser inte ut som ett
 * felklick — den ser ut som en agent som slutade fungera, och den felsökningen
 * börjar någon annanstans.
 *
 * Farlighetsgraden skiljer sig däremot: bara återkallandet får `danger`, därför
 * att bara det är oåterkalleligt. Att färga alla fyra röda hade gjort rött
 * betydelselöst just där det behöver betyda något.
 */
export function BekraftaAtgard({ atgard, sparar, fel, onClose, onBekrafta }: Props) {
  const [skäl, setSkäl] = useState('')

  // Skälet hör till EN återkallelse, inte till modalen. Utan nollställningen
  // hade nästa återkallelse ärvt förra radens motivering — en historikrad som
  // ser ifylld ut och beskriver fel beslut.
  useEffect(() => {
    setSkäl('')
  }, [atgard?.id, atgard?.slag])

  if (!atgard) return null
  const t = TEXT[atgard.slag]

  return (
    <Modal open onClose={onClose} title={t.titel} size="sm">
      <p className="text-[13px] leading-relaxed text-gray-600">
        Gäller rättigheten att <span className="font-medium text-gray-900">{atgard.klartext}</span>.
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-gray-600">{t.brodtext}</p>

      {atgard.slag === 'aterkalla' && (
        <div className="mt-4">
          <label htmlFor="delegation-skal" className="text-[13px] font-medium text-gray-700">
            Varför? (frivilligt)
          </label>
          <input
            id="delegation-skal"
            type="text"
            value={skäl}
            maxLength={500}
            onChange={(e) => setSkäl(e.target.value)}
            placeholder="T.ex. vi sköter det manuellt igen"
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3.5 text-[13.5px] text-gray-900 placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
          />
          {/* FRIVILLIGT MED FLIT. Ett obligatoriskt fritextfält blir "x" efter
              tredje gången, och då är historiken sämre än om fältet varit tomt:
              den ser ifylld ut. Det obligatoriska är HÄNDELSEN. */}
          <p className="mt-1 text-[12px] text-gray-400">Sparas i delegationens historik.</p>
        </div>
      )}

      {fel && (
        <p role="alert" className="mt-3 text-[12px] text-red-500">
          {fel}
        </p>
      )}

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={sparar}>
          Avbryt
        </Button>
        <Button
          variant={t.farlig ? 'danger' : 'primary'}
          disabled={sparar}
          onClick={() => onBekrafta(skäl.trim() ? skäl.trim() : undefined)}
        >
          {sparar ? 'Sparar…' : t.knapp}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
