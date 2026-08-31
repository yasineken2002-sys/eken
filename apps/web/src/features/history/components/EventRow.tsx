import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { formatCurrency, formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { HistoryEvent, HistorySeverity } from '../api/history.api'
import { eventLabel } from '../lib/categories'
import { shortId, sourceTarget } from '../lib/source-links'
import { ActorTag } from './ActorTag'

/**
 * EN HÄNDELSE SOM RAD — när · vad · aktör · beskrivning · belopp · källa.
 *
 * Allvarsgraden färgar PRICKEN i tidslinjen, inte kortet. Ett kort som byter
 * bakgrund för varje `WARNING` gör en normal kravtrappa till en vägg av gult,
 * och då säger färgen inget längre. Luckorna ovanför är de rader som ska
 * färgas — de är undantagen, händelserna är regeln.
 */
const DOT: Record<HistorySeverity, string> = {
  INFO: 'bg-gray-300',
  NOTICE: 'bg-gray-400',
  WARNING: 'bg-amber-400',
  CRITICAL: 'bg-red-500',
}

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

/** Klockslag utöver datum — flera händelser samma dag ska gå att ordna. */
function tid(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
}

export function EventRow({ event }: { event: HistoryEvent }) {
  const target = sourceTarget(event.source.table)

  return (
    <motion.li variants={item} className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex gap-3">
        {/* Tidslinjens prick — allvarsgraden, diskret */}
        <div className="flex flex-shrink-0 flex-col items-center pt-1.5">
          <span className={cn('h-2 w-2 rounded-full', DOT[event.severity] ?? DOT.INFO)} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* när */}
            <span className="text-[12px] tabular-nums text-gray-400">
              {formatDate(event.at)}
              {tid(event.at) && <span className="ml-1">{tid(event.at)}</span>}
            </span>
            {/* vad */}
            <span className="text-[13.5px] font-medium text-gray-900">
              {eventLabel(event.type)}
            </span>
            {/* aktör */}
            <ActorTag actor={event.actor} />
          </div>

          {/* beskrivning — API:ets svenska mening, oförändrad */}
          <p className="mt-1 text-[13px] leading-relaxed text-gray-600">{event.description}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* belopp */}
            {event.amount !== null && (
              <span className="text-[12.5px] font-medium tabular-nums text-gray-700">
                {formatCurrency(event.amount)}
              </span>
            )}

            {/* vad det gällde */}
            {event.subject.label && (
              <span className="text-[11.5px] text-gray-400">{event.subject.label}</span>
            )}

            {/* källa — klickbar bara när det finns någonstans att gå */}
            {target ? (
              <Link
                to={target.route}
                className="inline-flex items-center gap-1 rounded-md px-1 text-[11.5px] font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                title={`${event.source.table} ${event.source.id} — öppnar ${target.label}`}
              >
                {target.label}
                <ArrowUpRight size={11} strokeWidth={2} />
              </Link>
            ) : (
              <span
                className="text-[11.5px] text-gray-400"
                title={`${event.source.table} ${event.source.id} — den här källan har ingen egen vy i appen`}
              >
                {event.source.table} · {shortId(event.source.id)}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.li>
  )
}
