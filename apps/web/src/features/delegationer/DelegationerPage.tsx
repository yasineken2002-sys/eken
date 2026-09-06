import React, { useMemo, useState } from 'react'

import { Link } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { StatCard } from '@/components/ui/StatCard'
import {
  delegationFrekvenstext,
  delegationVerktygstext,
  delegationVillkorstext,
  formatDate,
} from '@eken/shared'
import { cn } from '@/lib/cn'

import { BekraftaAtgard } from './components/BekraftaAtgard'
import {
  useDelegationer,
  useExtendDelegation,
  usePauseDelegation,
  useResumeDelegation,
  useRevokeDelegation,
} from './hooks/useDelegationer'

import type { Atgard } from './components/BekraftaAtgard'
import type { Delegation, DelegationStatus } from './api/delegationer.api'

/**
 * Hur nära utgång som räknas som "snart".
 *
 * Fjorton dagar, därför att det är ungefär den tid det tar att märka att något
 * är på väg att sluta gälla och hinna ta ställning till det. Talet står HÄR och
 * inte i JSX:en, så KPI-kortets rubrik och filtret inte kan säga olika saker.
 */
const SNART_DAGAR = 14

const STATUSTEXT: Record<
  DelegationStatus,
  { text: string; variant: 'success' | 'warning' | 'danger' | 'default' }
> = {
  AKTIV: { text: 'Aktiv', variant: 'success' },
  PAUSAD: { text: 'Pausad', variant: 'warning' },
  ÅTERKALLAD: { text: 'Återkallad', variant: 'danger' },
  // NEUTRAL, inte röd. En utgången delegation är inte ett fel — det är
  // tidsgränsen som gjorde sitt jobb. Signalfärgerna är till för signaler.
  UTGÅNGEN: { text: 'Utgången', variant: 'default' },
}

const FLIKAR: Array<{ etikett: string; status?: DelegationStatus }> = [
  { etikett: 'Aktiva', status: 'AKTIV' },
  { etikett: 'Pausade', status: 'PAUSAD' },
  { etikett: 'Utgångna', status: 'UTGÅNGEN' },
  { etikett: 'Återkallade', status: 'ÅTERKALLAD' },
  { etikett: 'Alla' },
]

/**
 * Löper delegationen ut SNART?
 *
 * En återkallad eller redan utgången rad räknas aldrig som "snart": den första
 * gäller inte längre, och den andra har redan gått ut. Utan det villkoret hade
 * kortet räknat upp rader det inte finns något att göra åt, och siffran hade
 * slutat betyda "det här behöver du titta på".
 */
function löperUtSnart(d: Delegation): boolean {
  if (d.status === 'ÅTERKALLAD' || d.status === 'UTGÅNGEN') return false
  return d.löperUtInomDagar <= SNART_DAGAR
}

function felText(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { data?: { error?: { message?: string } } } }
    const msg = maybe.response?.data?.error?.message
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  return fallback
}

/**
 * DELEGATIONER — "vad systemet tror om hen" (planens etapp 7).
 *
 * ── EN LÄSYTA FÖR RÄTTIGHETER, INTE EN INSTÄLLNINGSSIDA ─────────────────────
 *
 * Sidan visar bara sådant hyresvärden själv har GETT: varje rad är född ur ett
 * godkänt förslag i inkorgen, och kolumnen "Född ur" pekar tillbaka på just det
 * beslutet. Utan den pekaren hade listan varit en uppsättning rättigheter någon
 * inte minns att hen gav — och då är den värre än ingen lista.
 *
 * Det finns därför INGEN väg att skapa en delegation här. Planens Del 6 är
 * uttrycklig om ordningen: observation → förslag → mänskligt tryck →
 * delegation. En "Ny delegation"-knapp hade varit en genväg förbi förslaget,
 * och det är hela mekanismen den hade gått förbi.
 *
 * ── VARFÖR INGA PREFERENSER HÄR ─────────────────────────────────────────────
 *
 * Planens Del 7 skiljer tre lager: preferens (hur agenten låter), observation
 * (vad den räknat ut) och befogenhet (vad den FÅR göra). Bara det tredje lagret
 * hör hemma på den här sidan. Att blanda in de två andra hade gjort det svårare,
 * inte lättare, att svara på den enda fråga sidan finns för: vad har jag gett
 * bort, och hur tar jag tillbaka det?
 */
export function DelegationerPage() {
  const [flik, setFlik] = useState(0)
  const [atgard, setAtgard] = useState<Atgard | null>(null)
  const [fel, setFel] = useState<string | null>(null)

  const lista = useDelegationer()
  const pausa = usePauseDelegation()
  const återuppta = useResumeDelegation()
  const förläng = useExtendDelegation()
  const återkalla = useRevokeDelegation()

  const alla = useMemo(() => lista.data ?? [], [lista.data])
  const status = FLIKAR[flik]?.status
  const rader = status ? alla.filter((d) => d.status === status) : alla

  const sparar = pausa.isPending || återuppta.isPending || förläng.isPending || återkalla.isPending

  const öppna = (slag: Atgard['slag'], d: Delegation) => {
    setFel(null)
    setAtgard({ slag, id: d.id, klartext: delegationVerktygstext(d.toolName) })
  }

  const bekräfta = (skäl?: string) => {
    if (!atgard) return
    setFel(null)
    const klart = { onSuccess: () => setAtgard(null) }
    const misslyckades = (fallback: string) => (e: unknown) => setFel(felText(e, fallback))
    switch (atgard.slag) {
      case 'pausa':
        return pausa.mutate(atgard.id, {
          ...klart,
          onError: misslyckades('Kunde inte pausa delegationen.'),
        })
      case 'aterta':
        return återuppta.mutate(atgard.id, {
          ...klart,
          onError: misslyckades('Kunde inte återuppta delegationen.'),
        })
      case 'forlang':
        return förläng.mutate(atgard.id, {
          ...klart,
          onError: misslyckades('Kunde inte förlänga delegationen.'),
        })
      case 'aterkalla':
        return återkalla.mutate(
          { id: atgard.id, skäl },
          { ...klart, onError: misslyckades('Kunde inte återkalla delegationen.') },
        )
    }
  }

  const kolumner = [
    {
      key: 'toolName',
      header: 'Agenten får',
      cell: (d: Delegation) => (
        // KLARTEXT, aldrig `create_property`. Kartan är delad med inkorgens
        // bekräftelse (`@eken/shared`), så meningen hyresvärden godkände är
        // ordagrant den hen läser här.
        <span className="font-medium">{delegationVerktygstext(d.toolName)}</span>
      ),
    },
    {
      key: 'villkor',
      header: 'Avgränsning',
      cell: (d: Delegation) => (
        <span className={cn(d.villkor ? 'text-gray-700' : 'text-gray-500')}>
          {delegationVillkorstext(d.villkor)}
        </span>
      ),
    },
    {
      key: 'frekvens',
      header: 'Frekvens',
      cell: (d: Delegation) => (
        <span className="text-gray-700">{delegationFrekvenstext(d.frekvensvillkor)}</span>
      ),
    },
    {
      key: 'kalla',
      header: 'Född ur',
      cell: (d: Delegation) => (
        <div className="leading-tight">
          {d.bornFromAssignment ? (
            // LÄNKEN ÄR POÄNGEN. Rätten går att spåra tillbaka till det enskilda
            // beslut den föddes ur — inte bara till listan där beslutet togs.
            <Link
              to="/inkorg"
              search={{ forslag: d.bornFromAssignment.id }}
              className="text-brand hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {d.bornFromAssignment.title}
            </Link>
          ) : (
            <span className="text-gray-500">Skapad utan förslag</span>
          )}
          <div className="mt-0.5 text-[12px] text-gray-400">
            {d.createdByUser
              ? `${d.createdByUser.firstName} ${d.createdByUser.lastName} · ${formatDate(d.createdAt)}`
              : formatDate(d.createdAt)}
          </div>
        </div>
      ),
    },
    {
      // ── VAD RÄTTEN FAKTISKT HADE BETYTT (etapp 8) ──────────────────────
      //
      // Talet är torrlägets facit: antal skuggförslag som HADE utförts enligt
      // just den här delegationen. En nolla är inte ett fel — den betyder att
      // rätten är för snäv eller att fallet inte dykt upp — och det är precis
      // vad hyresvärden behöver veta innan skarpt läge slås på.
      key: 'skulleHaUtlost',
      header: 'Skulle ha utlöst',
      align: 'right' as const,
      cell: (d: Delegation) => (
        <span
          className={cn('tabular-nums', d.skulleHaUtlöst > 0 ? 'text-gray-900' : 'text-gray-400')}
        >
          {d.skulleHaUtlöst}
        </span>
      ),
    },
    {
      key: 'expiresAt',
      header: 'Löper ut',
      cell: (d: Delegation) => (
        <div className="leading-tight">
          <div className="text-gray-700">{formatDate(d.expiresAt)}</div>
          {löperUtSnart(d) && (
            <div className="mt-0.5 text-[12px] text-amber-700">
              {d.löperUtInomDagar <= 0 ? 'i dag' : `om ${d.löperUtInomDagar} dagar`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d: Delegation) => (
        <Badge variant={STATUSTEXT[d.status].variant}>{STATUSTEXT[d.status].text}</Badge>
      ),
    },
    {
      key: 'atgarder',
      header: '',
      align: 'right' as const,
      cell: (d: Delegation) => (
        <div className="flex justify-end gap-1">
          {d.status === 'AKTIV' && (
            <Button variant="ghost" size="xs" onClick={() => öppna('pausa', d)}>
              Pausa
            </Button>
          )}
          {d.status === 'PAUSAD' && (
            <Button variant="ghost" size="xs" onClick={() => öppna('aterta', d)}>
              Återuppta
            </Button>
          )}
          {d.status !== 'ÅTERKALLAD' && (
            <Button variant="ghost" size="xs" onClick={() => öppna('forlang', d)}>
              Förläng
            </Button>
          )}
          {/* ÅTERKALLA VISAS BARA MEDAN DET BETYDER NÅGOT. En utgången
              delegation är redan verkningslös, och en knapp som inte ändrar
              något gör listan svårare att läsa, inte säkrare. */}
          {(d.status === 'AKTIV' || d.status === 'PAUSAD') && (
            <Button variant="ghost" size="xs" onClick={() => öppna('aterkalla', d)}>
              Återkalla
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <PageWrapper id="delegationer">
      <PageHeader
        title="Delegationer"
        description="Vad du har gett agenten rätt att göra på egen hand — och hur du tar tillbaka det."
      />

      <div
        data-testid="delegationer-kpi"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatCard title="Aktiva" value={alla.filter((d) => d.status === 'AKTIV').length} />
        <StatCard title="Pausade" value={alla.filter((d) => d.status === 'PAUSAD').length} />
        <StatCard
          title={`Löper ut inom ${SNART_DAGAR} dagar`}
          value={alla.filter(löperUtSnart).length}
        />
        <StatCard
          title="Återkallade"
          value={alla.filter((d) => d.status === 'ÅTERKALLAD').length}
        />
      </div>

      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {FLIKAR.map((f, i) => (
          <button
            key={f.etikett}
            type="button"
            onClick={() => setFlik(i)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              i === flik ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {f.etikett}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {lista.isError ? (
          <LoadErrorState vad="delegationerna" onRetry={() => void lista.refetch()} />
        ) : rader.length === 0 && !lista.isLoading ? (
          // TOMT ÄR ETT UTFALL, inte en tom tabell — och texten säger VÄGEN dit
          // i stället för att erbjuda en genväg förbi den.
          <EmptyState
            icon={ShieldCheck}
            title={
              alla.length === 0
                ? 'Du har inte delegerat något än'
                : 'Inga delegationer i den här vyn'
            }
            description={
              alla.length === 0
                ? 'En delegation föds när du godkänner ett förslag i inkorgen och trycker "Gör alltid så här". Fram till dess frågar agenten varje gång.'
                : 'Byt flik för att se de övriga.'
            }
            {...(alla.length === 0
              ? {
                  action: (
                    <Link to="/inkorg">
                      <Button variant="secondary">Till inkorgen</Button>
                    </Link>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable
            columns={kolumner}
            data={rader}
            keyExtractor={(d) => d.id}
            loading={lista.isLoading}
          />
        )}
      </div>

      <BekraftaAtgard
        atgard={atgard}
        sparar={sparar}
        fel={fel}
        onClose={() => {
          setAtgard(null)
          setFel(null)
        }}
        onBekrafta={bekräfta}
      />
    </PageWrapper>
  )
}
