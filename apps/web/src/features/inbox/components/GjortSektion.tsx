import React, { useState } from 'react'

import { Link } from '@tanstack/react-router'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatDate } from '@eken/shared'

import { useBegarAngra, useGjorda } from '../hooks/useInbox'

import type { GjortItem } from '../api/inbox.api'

/**
 * "GJORT" — vad agenten faktiskt har utfört.
 *
 * ── ALLA TRE UTFALLEN, INTE BARA DET LYCKADE ────────────────────────────────
 *
 * `EXECUTED`, `FAILED` och `LAPSED` står i samma lista. En sektion som bara
 * visade det som gick bra hade sagt att agenten aldrig misslyckas, och det är
 * precis motsatsen till vad som gör en växel möjlig att lita på. `LAPSED` är
 * dessutom den enda platsen där planens Del 12 syns för hyresvärden: *"Skulle
 * bokat rörmokare — du hade redan gjort det 08:14."*
 *
 * ── ÅNGRA ÄR EN BEGÄRAN, OCH DET STÅR I KLARTEXT ────────────────────────────
 *
 * Knappen backar ingenting. Den skriver en händelse och visar vägen att göra det
 * för hand. Att kalla den "Ångra" och sedan inte ångra vore ett löfte systemet
 * inte håller — därför säger texten vad som händer INNAN man trycker, och
 * bekräftelsen efteråt säger vad som återstår.
 *
 * Vägen kommer från SERVERN (`ångra`), härledd ur effektkatalogen. En kopia av
 * den kartan här hade varit en andra källa till samma regel.
 */
const STATUSTEXT: Record<string, { etikett: string; ton: 'success' | 'danger' | 'warning' }> = {
  EXECUTED: { etikett: 'Utförd', ton: 'success' },
  FAILED: { etikett: 'Misslyckades', ton: 'danger' },
  LAPSED: { etikett: 'Utfördes inte', ton: 'warning' },
}

function GjortRad({ rad }: { rad: GjortItem }) {
  const [visaAngra, setVisaAngra] = useState(false)
  const angra = useBegarAngra()
  const status = STATUSTEXT[rad.status] ?? { etikett: rad.status, ton: 'warning' as const }

  return (
    <div className="border-b border-[var(--ev-row-border)] px-5 py-4 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13.5px] font-medium text-gray-900">{rad.title}</p>
            <Badge variant={status.ton} dot>
              {status.etikett}
            </Badge>
          </div>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {/* VAD: verktygsnamnet i klartext duger inte som enda uppgift, men
                det är det enda som är sant för ALLA verktyg. Motiveringen står
                bredvid och säger varför. */}
            {rad.toolName} · {rad.decidedAt ? formatDate(rad.decidedAt) : '—'}
          </p>
          {/* ENLIGT VILKEN DELEGATION. Utan den raden är "agenten gjorde det"
              ett påstående utan grund — och grunden är hela poängen med att
              `authorityKind` finns. */}
          {rad.status === 'EXECUTED' && (
            <p className="mt-1 text-[12px] text-gray-500">
              {rad.delegationId ? (
                <>
                  Enligt din delegation{' '}
                  <Link to="/delegationer" className="text-brand hover:underline">
                    för {rad.delegation?.toolName ?? rad.toolName}
                  </Link>
                  .
                </>
              ) : (
                'Utan delegation — den här raden bör granskas.'
              )}
            </p>
          )}
          {/* SKÄLET vid FAILED och LAPSED, ordagrant från servern. */}
          {rad.statusReason && rad.status !== 'EXECUTED' && (
            <p className="mt-1 text-[12px] text-gray-600">{rad.statusReason}</p>
          )}
          {rad.ångraBegärd && (
            <p className="text-warning-600 mt-1 text-[12px]">
              Du har begärt att den här ska backas ({formatDate(rad.ångraBegärd)}).
            </p>
          )}
        </div>

        {/* ÅNGRA finns BARA på en utförd åtgärd. En misslyckad eller förfallen
            har ingen effekt att backa, och en knapp där hade lovat något som
            inte finns. API:t avvisar det också, med 400. */}
        {rad.status === 'EXECUTED' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisaAngra((v) => !v)}
            aria-expanded={visaAngra}
          >
            Ångra
          </Button>
        )}
      </div>

      {visaAngra && rad.status === 'EXECUTED' && (
        <div className="border-line bg-canvas mt-3 rounded-xl border p-3">
          <p className="text-[12.5px] text-gray-700">{rad.ångra.text}</p>
          {rad.ångra.möjlig && (
            <p className="mt-1 text-[12px]">
              <Link to={rad.ångra.rutt} className="text-brand hover:underline">
                Gå till {rad.ångra.rutt}
              </Link>
            </p>
          )}
          <p className="mt-2 text-[12px] text-gray-500">
            {/* SÄG VAD KNAPPEN GÖR, INNAN den trycks. Systemet backar ingenting
                självt — se `undo-hint.ts` i API:t för varför. */}
            Systemet backar ingenting åt dig. Trycker du nedan noteras att du vill ha åtgärden
            backad, så att det syns i historiken — själva backningen gör du enligt vägen ovan.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={angra.isPending}
              onClick={() => angra.mutate({ id: rad.id })}
            >
              {angra.isPending ? 'Noterar…' : 'Notera att jag vill backa det'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setVisaAngra(false)}>
              Avbryt
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function GjortSektion() {
  const { data, isLoading } = useGjorda()

  // TOM SEKTION DÖLJS. Skarpt läge är av i varje organisation, och en rubrik
  // som alltid står tom lär läsaren att sektionen är oviktig.
  if (isLoading || !data || data.rader.length === 0) return null

  return (
    <div className="mt-8" data-testid="gjort">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold text-gray-900">Gjort</h2>
        <p className="text-[12px] text-gray-500">
          {data.total} åtgärd{data.total === 1 ? '' : 'er'} agenten utfört själv
        </p>
      </div>
      <div className="border-line bg-surface overflow-hidden rounded-2xl border">
        {data.rader.map((r) => (
          <GjortRad key={r.id} rad={r} />
        ))}
      </div>
    </div>
  )
}
