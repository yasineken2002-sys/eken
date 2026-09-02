import { motion } from 'framer-motion'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  MailCheck,
  MailWarning,
  MailX,
  PauseCircle,
  XCircle,
} from 'lucide-react'

import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'

import type { RentCollectionState, RentCollectionStatus } from '../api/avisering.api'

/**
 * VARFÖR STÅR DEN HÄR AVIN STILL?
 *
 * ── DEN ENDA FRÅGA PANELEN FINNS FÖR ────────────────────────────────────────
 *
 * En avi i `REMINDED` som ligger kvar ser likadan ut oavsett orsak. Mätt i
 * koden 2026-09-02 går kravtrappans cron vidare på TRE sätt, och bara ETT av
 * dem lämnar ett spår i avins logg:
 *
 *     under tröskeln              inget event   = VÄNTAR
 *     INV-B saknar något          ett per dygn  = FASTNAT
 *     betalningsdatan inaktuell   inget event   = PAUSAD
 *
 * Två av tre är alltså osynliga i händelselistan nedanför. Panelen är därför
 * inte en sammanfattning av loggen — den är det som loggen inte kan visa.
 *
 * ── BRISTERNA VISAS ÄVEN NÄR AVIN VÄNTAR ────────────────────────────────────
 *
 * En avi som väntar och vars påminnelse studsat är inte ett problem först den
 * dag tröskeln passeras. Ingen kan rätta en adress hen inte vet är fel, och
 * visas felet först när det redan blivit ett stopp har vyn kommit för sent.
 */

interface Props {
  status: RentCollectionStatus
}

const LAGE: Record<
  RentCollectionState,
  { rubrik: string; ikon: typeof Info; ram: string; text: string; prick: string }
> = {
  NOT_APPLICABLE: {
    rubrik: 'Ingen eskalering väntar',
    ikon: Info,
    ram: 'border-gray-200 bg-gray-50',
    text: 'text-gray-600',
    prick: 'bg-gray-300',
  },
  REMINDERS_OFF: {
    rubrik: 'Påminnelser är avstängda',
    ikon: PauseCircle,
    ram: 'border-gray-200 bg-gray-50',
    text: 'text-gray-600',
    prick: 'bg-gray-400',
  },
  PAUSED_STALE: {
    rubrik: 'Kravtrappan är pausad',
    ikon: PauseCircle,
    ram: 'border-amber-100 bg-amber-50',
    text: 'text-amber-800',
    prick: 'bg-amber-400',
  },
  WAITING: {
    rubrik: 'Väntar',
    ikon: Clock,
    ram: 'border-gray-200 bg-gray-50',
    text: 'text-gray-600',
    prick: 'bg-gray-400',
  },
  BLOCKED: {
    rubrik: 'Står stilla',
    ikon: XCircle,
    ram: 'border-red-100 bg-red-50',
    text: 'text-red-700',
    prick: 'bg-red-500',
  },
  READY: {
    rubrik: 'Redo för nästa steg',
    ikon: CheckCircle2,
    ram: 'border-emerald-100 bg-emerald-50',
    text: 'text-emerald-800',
    prick: 'bg-emerald-500',
  },
}

/** En mening som säger vad som händer härnäst — inte bara vad som är fel. */
function harnast(s: RentCollectionStatus): string {
  switch (s.state) {
    case 'NOT_APPLICABLE':
      return 'Avin är inte i det steg där inkassoeskaleringen prövas.'
    case 'REMINDERS_OFF':
      return 'Organisationen har stängt av påminnelser, så kravtrappan prövas inte alls. Slå på dem i Inställningar för att återuppta den.'
    case 'PAUSED_STALE':
      return `Betalningsdatan är ${s.freshness.ageDays ?? '?'} dygn gammal (gräns ${s.freshness.thresholdDays}). Kravtrappan pausas tills ny betalningsdata lästs in — annars kunde ett krav drivas vidare mot en skuld som redan är betald.`
    case 'WAITING':
      return s.daysUntilEvaluation === 0
        ? 'Prövas vid nästa dygnskörning.'
        : `Prövas om ${s.daysUntilEvaluation} dygn (${s.daysOverdue} av ${s.thresholdDays} dygn efter förfall).`
    case 'BLOCKED':
      return s.blockedDays !== null
        ? `Tröskeln passerades för ${s.daysOverdue - s.thresholdDays} dygn sedan. Avin prövas varje dygn och nekas varje gång — senast för ${s.blockedDays} dygn sedan.`
        : 'Tröskeln är passerad, men underlaget är ofullständigt. Avin prövas varje dygn och nekas varje gång.'
    case 'READY':
      return 'Inget saknas. Nästa dygnskörning flyttar avin till inkasso-redo.'
  }
}

/**
 * EN LEVERANSRAD — och `null` betyder något annat än `false`.
 *
 * En utebliven leveranskvittens är inte samma sak som ett misslyckande, och får
 * inte se ut som ett heller. Den är ett OKÄNT läge, och det är just det okända
 * som stoppar kravtrappan — så raden säger "ingen kvittens", aldrig ingenting.
 */
function Leverans({
  etikett,
  skickat,
  levererat,
  studsat,
}: {
  etikett: string
  skickat: string | null
  levererat: string | null
  studsat: string | null
}) {
  const [Ikon, färg, text] = studsat
    ? [MailX, 'text-red-600', `Studsade ${formatDate(studsat)}`]
    : levererat
      ? [MailCheck, 'text-emerald-600', `Togs emot ${formatDate(levererat)}`]
      : skickat
        ? [MailWarning, 'text-amber-600', 'Skickat — ingen leveranskvittens']
        : [MailWarning, 'text-gray-400', 'Inte skickat']

  return (
    <div className="flex items-start gap-2">
      <Ikon size={14} strokeWidth={1.8} className={cn('mt-0.5 flex-shrink-0', färg)} />
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-gray-700">{etikett}</p>
        <p className={cn('text-[12px]', färg)}>{text}</p>
      </div>
    </div>
  )
}

export function CollectionStatusPanel({ status }: Props) {
  const spec = LAGE[status.state]
  const Ikon = spec.ikon

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn('rounded-2xl border p-4', spec.ram)}
    >
      <div className="flex items-start gap-2">
        <Ikon size={15} strokeWidth={1.8} className={cn('mt-0.5 flex-shrink-0', spec.text)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13px] font-semibold', spec.text)}>{spec.rubrik}</p>
          <p className={cn('mt-1 text-[12.5px] leading-relaxed', spec.text, 'opacity-90')}>
            {harnast(status)}
          </p>
        </div>
      </div>

      {/* BRISTERNA — visas även när avin väntar, se docblocket överst. */}
      {status.missing.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-100 bg-white p-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-red-700">
            <AlertTriangle size={13} strokeWidth={1.8} />
            {status.missing.length === 1
              ? 'Ett krav saknas innan inkasso'
              : `${status.missing.length} krav saknas innan inkasso`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {status.missing.map((rad) => (
              <li key={rad} className="flex items-start gap-2 text-[12.5px] text-gray-700">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500" />
                <span className="leading-relaxed">{rad}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* LEVERANSERNA — avins och påminnelsens SKILT, se #651. */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Leverans
          etikett="Avin"
          skickat={status.delivery.noticeSentAt}
          levererat={status.delivery.noticeDeliveredAt}
          studsat={status.delivery.noticeBouncedAt}
        />
        <Leverans
          etikett="Påminnelsen"
          skickat={status.delivery.reminderSentAt}
          levererat={status.delivery.reminderDeliveredAt}
          studsat={status.delivery.reminderBouncedAt}
        />
      </div>

      {/* UTSKICKET GAV UPP — egen rad, inte infogad i någon av de två ovan.
          Händelsen säger inte VILKET brev som gav upp, och att placera den vid
          avin eller påminnelsen hade varit en gissning som ser ut som ett svar. */}
      {status.delivery.sendFailedAt && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-100 bg-white p-3">
          <MailX size={14} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-red-600" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-gray-700">Ett utskick gav upp</p>
            <p className="text-[12px] text-red-600">
              {formatDate(status.delivery.sendFailedAt)} — brevet nådde aldrig e-postleverantören.
              Skälet står i händelselistan nedan.
            </p>
          </div>
        </div>
      )}

      {/* GRÄNSEN, och den måste stå i gränssnittet och inte bara i ett ärende. */}
      <p className="mt-3 border-t border-gray-200/70 pt-2.5 text-[11.5px] leading-relaxed text-gray-500">
        “Togs emot” betyder att mottagarens e-postserver accepterade meddelandet — inte att någon
        har läst det. Ett brev kan tas emot och ändå hamna i skräpposten.
      </p>
    </motion.div>
  )
}
