import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { History } from 'lucide-react'

import { formatDate } from '@eken/shared'
import { ActorTag } from '@/components/ui/ActorTag'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'

import type { EventActor } from '@/components/ui/ActorTag'
import type { RentNoticeEvent } from '../api/avisering.api'

/**
 * AVINS HÄNDELSELOGG (#648).
 *
 * ── MISSLYCKANDEN FÅR INTE SE UT SOM RUTIN ──────────────────────────────────
 *
 * Klassificeringen nedan är egen och inte lånad från historikvyns
 * `severityForRentNoticeEvent`. Skälet är mätt: den funktionen matchar på
 * delsträngar (`WRITTEN_OFF`, `COLLECTION`, `REMIND`, `OVERDUE`, `INTEREST`),
 * och alla tre MISSLYCKANDEN faller därför utanför och blir `INFO`:
 *
 *     SEND_FAILED            INFO
 *     EMAIL_BOUNCED          INFO      ← hårdstoppar hela kravtrappan
 *     NOTICE_EMAIL_BOUNCED   INFO
 *
 * En studs som ritas med grå prick är ett fönster mot samma tystnad vyn skulle
 * ta bort. Uppräkningen här är per TYP och inte per delsträng, så en ny typ
 * inte kan hamna i fel hink genom att råka innehålla ett ord.
 *
 * ── EN OKÄND TYP TAPPAS ALDRIG ──────────────────────────────────────────────
 *
 * En typ som saknas i tabellen renderas med sitt råa namn i stället för att
 * hoppas över. En ny händelsetyp i API:t syns då samma dag den finns — ful,
 * men synlig. Att tyst filtrera bort den hade varit den värsta varianten.
 *
 * ── VAD PANELEN INTE KAN VISA ───────────────────────────────────────────────
 *
 * Varför avin står still. Två av kravtrappans tre vägar vidare lämnar inget
 * event alls, så frånvaron går inte att läsa här — den beräknas mot en
 * förväntan i `CollectionStatusPanel` ovanför.
 */

type Niva = 'FEL' | 'VARNING' | 'OK' | 'INFO'

const TYPER: Record<string, { etikett: string; niva: Niva }> = {
  CREATED: { etikett: 'Avi skapad', niva: 'INFO' },
  SENT: { etikett: 'Avi skickad', niva: 'INFO' },
  SEND_FAILED: { etikett: 'Utskicket misslyckades', niva: 'FEL' },
  // AVINS respektive PÅMINNELSENS leverans — skilda typer, och etiketterna
  // måste säga vilken. INV-B läser bara påminnelsens (#651).
  NOTICE_EMAIL_DELIVERED: { etikett: 'Avin togs emot', niva: 'OK' },
  NOTICE_EMAIL_BOUNCED: { etikett: 'Avin studsade', niva: 'FEL' },
  EMAIL_DELIVERED: { etikett: 'Påminnelsen togs emot', niva: 'OK' },
  EMAIL_BOUNCED: { etikett: 'Påminnelsen studsade', niva: 'FEL' },
  PAYMENT_RECEIVED: { etikett: 'Betalning registrerad', niva: 'OK' },
  PAYMENT_REVERSED: { etikett: 'Betalning avmatchad', niva: 'VARNING' },
  OVERDUE: { etikett: 'Förfallen', niva: 'VARNING' },
  REMINDER_SENT: { etikett: 'Påminnelse skickad', niva: 'VARNING' },
  REMINDER_FEE_REVERSED: { etikett: 'Påminnelseavgift struken', niva: 'VARNING' },
  INTEREST_ACCRUED: { etikett: 'Dröjsmålsränta påförd', niva: 'VARNING' },
  COLLECTION_READY: { etikett: 'Redo för inkasso', niva: 'FEL' },
  WRITTEN_OFF: { etikett: 'Avskriven som kundförlust', niva: 'FEL' },
  CREDITED: { etikett: 'Avin nedsatt', niva: 'INFO' },
  NOTE_ADDED: { etikett: 'Anteckning', niva: 'INFO' },
}

const PRICK: Record<Niva, string> = {
  FEL: 'bg-red-500',
  VARNING: 'bg-amber-400',
  OK: 'bg-emerald-500',
  INFO: 'bg-gray-300',
}

const TEXT: Record<Niva, string> = {
  FEL: 'text-red-700',
  VARNING: 'text-amber-800',
  OK: 'text-emerald-800',
  INFO: 'text-gray-800',
}

/** Speglar API:ets `actorFromEventActorType` — WEBHOOK och SYSTEM är samma nivå. */
function tillAktor(e: RentNoticeEvent): EventActor {
  const kind = e.actorType === 'USER' ? 'HUMAN' : e.actorType === 'AI' ? 'AGENT' : 'SYSTEM'
  return { kind, id: e.actorId, label: e.actorLabel }
}

function klockslag(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
}

/** En kort detaljrad ur payloaden, för de nycklar som betyder något för en läsare. */
function detalj(e: RentNoticeEvent): string | null {
  const p = e.payload ?? {}
  if (p['action'] === 'inkasso-ready-blocked') {
    const saknas = Array.isArray(p['missing']) ? (p['missing'] as string[]) : []
    return saknas.length > 0 ? `Nekad: ${saknas.join(' · ')}` : 'Nekad av inkassogrinden'
  }
  if (typeof p['provider'] === 'string') return `Via ${p['provider']}`
  if (typeof p['reason'] === 'string') return p['reason']
  return null
}

/**
 * En rad, eller flera identiska hopslagna.
 *
 * Kravtrappan prövar en blockerad avi VARJE DYGN och skriver en anteckning varje
 * gång. En avi som stått still i tre månader hade gett nittio identiska rader
 * som trycker ner allt annat ur bild. De slås därför ihop till EN rad med ett
 * antal — vilket dessutom är den upplysning man faktiskt vill ha: hur länge.
 */
interface Rad {
  event: RentNoticeEvent
  antal: number
  forsta: string
}

function slaIhop(events: RentNoticeEvent[]): Rad[] {
  const rader: Rad[] = []
  for (const e of events) {
    const sist = rader[rader.length - 1]
    const nyckel = (x: RentNoticeEvent) => `${x.type}|${detalj(x) ?? ''}`
    if (sist && nyckel(sist.event) === nyckel(e)) {
      sist.antal++
      sist.event = e // senaste tidpunkten vinner — "senast" är det man vill se
      continue
    }
    rader.push({ event: e, antal: 1, forsta: e.createdAt })
  }
  return rader
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

/** Hur många rader som renderas innan "Visa fler". */
const SIDSTORLEK = 25

export function RentNoticeEventsPanel({ events }: { events: RentNoticeEvent[] }) {
  const rader = useMemo(() => slaIhop(events), [events])
  const [visade, setVisade] = useState(SIDSTORLEK)

  if (rader.length === 0) {
    return (
      <div className="border-line rounded-2xl border bg-white p-4">
        <EmptyState
          icon={History}
          title="Inga händelser"
          description="Avin har ingen registrerad historik ännu."
        />
      </div>
    )
  }

  // NYAST FÖRST. API:t levererar stigande; en operatör som undrar varför något
  // står still frågar om det SENASTE, inte om det första.
  const ordnade = [...rader].reverse()

  return (
    <div className="border-line rounded-2xl border bg-white p-4">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-900">
        <History size={14} strokeWidth={1.8} className="text-gray-400" />
        Händelser
        <span className="text-[12px] font-normal text-gray-400">({events.length})</span>
      </p>

      <motion.ul variants={container} initial="hidden" animate="show" className="mt-3 space-y-2">
        {ordnade.slice(0, visade).map((rad) => {
          const spec = TYPER[rad.event.type]
          const niva = spec?.niva ?? 'INFO'
          const text = detalj(rad.event)
          return (
            <motion.li key={rad.event.id} variants={item} className="flex gap-3">
              <span
                className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', PRICK[niva])}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className={cn('text-[13px] font-medium', TEXT[niva])}>
                    {spec?.etikett ?? rad.event.type}
                  </span>
                  <span className="text-[12px] text-gray-400">
                    {formatDate(rad.event.createdAt)} {klockslag(rad.event.createdAt)}
                  </span>
                  <ActorTag actor={tillAktor(rad.event)} />
                  {rad.antal > 1 && (
                    <span
                      title={`Upprepad ${rad.antal} gånger, första gången ${formatDate(rad.forsta)}`}
                      className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-500"
                    >
                      {rad.antal}× sedan {formatDate(rad.forsta)}
                    </span>
                  )}
                </div>
                {text && <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{text}</p>}
              </div>
            </motion.li>
          )
        })}
      </motion.ul>

      {ordnade.length > visade && (
        <button
          type="button"
          onClick={() => setVisade((n) => n + SIDSTORLEK)}
          className="mt-3 w-full rounded-lg py-2 text-[12.5px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        >
          Visa fler ({ordnade.length - visade} kvar)
        </button>
      )}
    </div>
  )
}
