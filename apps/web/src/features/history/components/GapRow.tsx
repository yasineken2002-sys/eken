import { motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ExpectationSource, GapResult, GapStatus } from '../api/history.api'

/**
 * EN FÖRVÄNTAN SOM RAD — i samma flöde som händelserna, inte i en varningsruta.
 *
 * Placeringen är inte kosmetik. En separat ruta ovanför tidslinjen blir en
 * banner, och bannrar läses inte — de klickas bort eller ses förbi. Luckorna
 * ligger därför i själva listan, med samma kortform och samma rytm som
 * händelserna, och blir en del av det man ändå läser.
 *
 * ── FÄRGVALET ÄR ETT PÅSTÅENDE, INTE EN SMAKSAK ────────────────────────────
 *
 *   LUCKA        röd    — något förväntat har inte hänt. En faktisk signal.
 *   ODEFINIERAD  gul    — en blind fläck. INTE grön, aldrig neutralt grå.
 *   UPPFYLLD     grön   — mätt och i sin ordning.
 *   GÄLLER_EJ    grå    — förväntan finns men rör inte objektet. Får vara tyst.
 *
 * Gult för ODEFINIERAD är det avgörande valet. Neutralgrått är designsystemets
 * färg för ett tillstånd som inte påstår något om utfallet — men en odefinierad
 * förväntan påstår något ganska starkt: *att vi inte vet*. Grått hade fått den
 * att smälta in bland de uppfyllda och därmed läsas som "inget att se här",
 * vilket är hela felet modulen finns för att undvika. Rött vore lika fel åt
 * andra hållet: ingenting har brustit, vi saknar en regel att mäta mot.
 *
 * Skälet — `source.why` från API:t — renderas alltid, aldrig bakom en
 * expandering. En dold förklaring är en förklaring som inte finns.
 */
interface StatusSpec {
  icon: LucideIcon
  /** Rubrikord före etiketten. Säger vad raden ÄR. */
  rubrik: string
  card: string
  ikonYta: string
  text: string
}

const SPECS: Record<GapStatus, StatusSpec> = {
  LUCKA: {
    icon: AlertTriangle,
    rubrik: 'Lucka',
    card: 'border-red-200 bg-red-50/40',
    ikonYta: 'bg-red-50 text-red-600',
    text: 'text-red-700',
  },
  ODEFINIERAD: {
    icon: CircleHelp,
    rubrik: 'Vi vet inte vad som borde ha hänt',
    card: 'border-amber-200 bg-amber-50/40',
    ikonYta: 'bg-amber-50 text-amber-600',
    text: 'text-amber-700',
  },
  UPPFYLLD: {
    icon: CheckCircle2,
    rubrik: 'Uppfylld',
    card: 'border-gray-100 bg-white',
    ikonYta: 'bg-emerald-50 text-emerald-600',
    text: 'text-emerald-700',
  },
  GÄLLER_EJ: {
    icon: MinusCircle,
    rubrik: 'Gäller ej',
    card: 'border-gray-100 bg-white',
    ikonYta: 'bg-gray-100 text-gray-400',
    text: 'text-gray-500',
  },
}

/**
 * En status gränssnittet inte känner igen får INTE se ut som ett godkännande.
 * Se `lib/gap-summary.ts` — samma fallback åt samma håll.
 */
const OKÄND: StatusSpec = {
  icon: CircleHelp,
  rubrik: 'Okänt utfall',
  card: 'border-amber-200 bg-amber-50/40',
  ikonYta: 'bg-amber-50 text-amber-600',
  text: 'text-amber-700',
}

/**
 * Varifrån förväntan kommer — utan den är en lucka en gissning.
 *
 * `null` för ODEFINIERAD: raden hade blivit "Ingen förväntan definierad" under
 * en rubrik som redan säger just det, och en upprepning läses som brus även när
 * den är sann.
 */
function källtext(source: ExpectationSource): string | null {
  if (source.kind === 'KONFIGURERAD') return `Konfigurerad · ${source.field}`
  if (source.kind === 'SYSTEMREGEL') return `Systemregel · ${source.rule}`
  return null
}

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function GapRow({ gap }: { gap: GapResult }) {
  const spec = SPECS[gap.status] ?? OKÄND
  const Icon = spec.icon

  return (
    <motion.li variants={item} className={cn('rounded-2xl border p-4', spec.card)}>
      <div className="flex gap-3">
        <div
          className={cn(
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
            spec.ikonYta,
          )}
        >
          <Icon size={16} strokeWidth={1.8} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className={cn('text-[13px] font-semibold', spec.text)}>{spec.rubrik}</p>
            <p className="text-[13.5px] font-medium text-gray-900">{gap.label}</p>
            {gap.missingCount !== undefined && gap.missingCount > 0 && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
                {gap.missingCount} saknas
              </span>
            )}
          </div>

          {/* Skälet. Alltid utskrivet — aldrig hopfällt, aldrig avkortat. */}
          <p className="mt-1 text-[13px] leading-relaxed text-gray-600">{gap.detail}</p>

          {källtext(gap.source) && (
            <p className="mt-2 text-[11.5px] text-gray-400">{källtext(gap.source)}</p>
          )}
        </div>
      </div>
    </motion.li>
  )
}
