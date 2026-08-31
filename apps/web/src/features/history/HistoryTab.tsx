import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, ChevronDown, History } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { isForbidden } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { HistoryDimension } from './api/history.api'
import { useHistoryEvents, useHistoryGaps } from './hooks/useHistory'
import {
  CATEGORY_LABELS,
  categoriesPresent,
  categoryOf,
  type EventCategory,
} from './lib/categories'
import { summarizeGaps } from './lib/gap-summary'
import { GapRow } from './components/GapRow'
import { EventRow } from './components/EventRow'

/** Hur många händelser som renderas innan "Visa fler". */
const SIDSTORLEK = 40

const container = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }

interface Props {
  dimension: HistoryDimension
  id: string | null
  /** Bestämd form: "hyresgästens historik", "lägenhetens historik". */
  vad: string
}

/**
 * HISTORIKFLIKEN — samma komponent för hyresgäst, lägenhet och fastighet.
 *
 * Dimensionen är en parameter, precis som i API:t. Tre kopior av den här filen
 * hade garanterat att de tre vyerna glider isär, och luckhanteringen — som är
 * det enda här som är svårt att få rätt — hade behövt bli rätt tre gånger.
 *
 * ── ORDNINGEN I FLÖDET ──────────────────────────────────────────────────────
 *
 * Luckorna först, händelserna sedan, i EN lista. Inte för att luckorna är
 * viktigast i största allmänhet, utan för att de är det enda i vyn som handlar
 * om vad som INTE finns — och det som inte finns har ingen egen plats i en
 * tidslinje att dyka upp på. Läggs de sist eller vid sidan om läses de aldrig.
 *
 * ── FILTRET RÖR INTE LUCKORNA ───────────────────────────────────────────────
 *
 * Kategoriflikarna filtrerar händelserna. Luckorna står kvar oavsett vald flik,
 * därför att en filtrerad vy annars kunde visa noll luckor utan att något
 * saknades i filtret — ett falskt lugn som är svårt att upptäcka just därför
 * att man själv valde filtret.
 */
export function HistoryTab({ dimension, id, vad }: Props) {
  const events = useHistoryEvents(dimension, id)
  const gaps = useHistoryGaps(dimension, id)

  const [kategori, setKategori] = useState<EventCategory | 'ALLA'>('ALLA')
  const [visade, setVisade] = useState(SIDSTORLEK)
  const [visaVilande, setVisaVilande] = useState(false)

  const alla = useMemo(() => events.data ?? [], [events.data])
  const kategorier = useMemo(() => categoriesPresent(alla), [alla])
  const filtrerade = useMemo(
    () => (kategori === 'ALLA' ? alla : alla.filter((e) => categoryOf(e.type) === kategori)),
    [alla, kategori],
  )
  const sammanfattning = useMemo(() => summarizeGaps(gaps.data ?? []), [gaps.data])

  if (events.isLoading) {
    return <div className="py-16 text-center text-[13px] text-gray-400">Laddar historik…</div>
  }
  if (events.isError) {
    return isForbidden(events.error) ? (
      <PermissionDeniedState vad={vad} />
    ) : (
      <LoadErrorState vad={vad} onRetry={() => void events.refetch()} />
    )
  }

  const synliga = filtrerade.slice(0, visade)
  const kvar = filtrerade.length - synliga.length

  return (
    <div>
      {/* ── Förväntningarnas sammanfattning ────────────────────────────────── */}
      <GapHeader
        gaps={gaps}
        sammanfattning={sammanfattning}
        visaVilande={visaVilande}
        onToggleVilande={() => setVisaVilande((v) => !v)}
      />

      {/* ── Kategoriflikar — härledda ur datan, aldrig ur en konstant ─────── */}
      {kategorier.length > 1 && (
        <div className="mt-5 flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
          <FilterTab
            aktiv={kategori === 'ALLA'}
            onClick={() => {
              setKategori('ALLA')
              setVisade(SIDSTORLEK)
            }}
            label="Alla"
            antal={alla.length}
          />
          {kategorier.map((c) => (
            <FilterTab
              key={c}
              aktiv={kategori === c}
              onClick={() => {
                setKategori(c)
                setVisade(SIDSTORLEK)
              }}
              label={CATEGORY_LABELS[c]}
              antal={alla.filter((e) => categoryOf(e.type) === c).length}
            />
          ))}
        </div>
      )}

      {/* ── Ett flöde: luckorna överst, händelserna under ─────────────────── */}
      <motion.ul variants={container} initial="hidden" animate="show" className="mt-4 space-y-2">
        {sammanfattning.framhävda.map((g) => (
          <GapRow key={g.key} gap={g} />
        ))}
        {visaVilande && sammanfattning.vilande.map((g) => <GapRow key={g.key} gap={g} />)}
        {synliga.map((e) => (
          <EventRow key={`${e.source.table}:${e.source.id}:${e.type}:${e.at}`} event={e} />
        ))}
      </motion.ul>

      {kvar > 0 && (
        <button
          type="button"
          onClick={() => setVisade((v) => v + SIDSTORLEK)}
          className="mt-3 h-9 w-full rounded-[10px] border border-gray-200 bg-white text-[13px] font-medium text-gray-600 transition-all duration-150 hover:bg-gray-50 active:scale-[0.99]"
        >
          Visa fler ({kvar} kvar)
        </button>
      )}

      {filtrerade.length === 0 && (
        <EmptyState
          icon={History}
          title={alla.length === 0 ? 'Ingen historik ännu' : 'Inga händelser i den här kategorin'}
          description={
            alla.length === 0
              ? 'Historiken sammanställs ur avtal, avier, fakturor, underhåll och besiktningar. Så fort något händer syns det här.'
              : 'Byt kategori för att se resten. Förväntningarna ovanför gäller oavsett filter.'
          }
        />
      )}
    </div>
  )
}

// ─── Sammanfattningen över luckorna ───────────────────────────────────────────

interface GapHeaderProps {
  gaps: ReturnType<typeof useHistoryGaps>
  sammanfattning: ReturnType<typeof summarizeGaps>
  visaVilande: boolean
  onToggleVilande: () => void
}

/**
 * ATT LUCKORNA INTE GICK ATT HÄMTA ÄR INTE DETSAMMA SOM ATT DET INTE FINNS
 * NÅGRA.
 *
 * Utan den här grenen hade ett fel i luckberäkningen renderats som en ren
 * tidslinje utan förväntningar — alltså exakt som ett objekt där allt står
 * rätt till. Det felet syns inte för den som tittar, och det är därför det
 * skrivs ut i klartext i stället.
 */
function GapHeader({ gaps, sammanfattning, visaVilande, onToggleVilande }: GapHeaderProps) {
  if (gaps.isLoading) {
    return <p className="text-[13px] text-gray-400">Beräknar förväntningar…</p>
  }

  if (gaps.isError) {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
        <AlertTriangle
          size={16}
          strokeWidth={1.8}
          className="mt-0.5 flex-shrink-0 text-amber-600"
        />
        <div>
          <p className="text-[13px] font-semibold text-amber-700">
            Förväntningarna kunde inte beräknas
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
            {isForbidden(gaps.error)
              ? 'Din roll får inte se luckberäkningen.'
              : 'Luckberäkningen svarade inte.'}{' '}
            Tidslinjen nedan visar vad som HAR hänt — men just nu går det inte att säga vad som
            borde ha hänt. Läs den inte som att inget saknas.
          </p>
          <button
            type="button"
            onClick={() => void gaps.refetch()}
            className="mt-2.5 h-8 rounded-[10px] border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition-all duration-150 hover:bg-gray-50 active:scale-[0.97]"
          >
            Försök igen
          </button>
        </div>
      </div>
    )
  }

  const { antalUppfyllda, antalGällerEj, alltUppfyllt, mening } = sammanfattning
  const antalVilande = sammanfattning.vilande.length

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-gray-700">Förväntningar</p>
        {antalVilande > 0 && (
          <button
            type="button"
            onClick={onToggleVilande}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-500 transition-colors hover:text-gray-800"
          >
            {visaVilande ? 'Dölj' : 'Visa'} {vilandeText(antalUppfyllda, antalGällerEj)}
            <ChevronDown
              size={13}
              strokeWidth={2}
              className={cn('transition-transform', visaVilande && 'rotate-180')}
            />
          </button>
        )}
      </div>
      <p
        className={cn(
          'mt-1 text-[13px] leading-relaxed',
          alltUppfyllt ? 'text-emerald-700' : 'text-gray-600',
        )}
      >
        {mening}
      </p>
    </div>
  )
}

/**
 * Etiketten för de hopfällda raderna — utan nollor.
 *
 * "Visa 0 uppfyllda och 3 ej tillämpliga" är sant men läses som ett fel. Ett
 * antal som är noll ska inte nämnas alls; knappen visas ändå bara när det finns
 * något att fälla ut.
 */
function vilandeText(antalUppfyllda: number, antalGällerEj: number): string {
  const delar: string[] = []
  if (antalUppfyllda > 0) delar.push(`${antalUppfyllda} uppfyllda`)
  if (antalGällerEj > 0) delar.push(`${antalGällerEj} ej tillämpliga`)
  return delar.join(' och ')
}

// ─── Filterflik ───────────────────────────────────────────────────────────────

function FilterTab({
  aktiv,
  onClick,
  label,
  antal,
}: {
  aktiv: boolean
  onClick: () => void
  label: string
  antal: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
        aktiv ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
      )}
    >
      {label}
      <span className="ml-1.5 text-[11.5px] tabular-nums text-gray-400">{antal}</span>
    </button>
  )
}
