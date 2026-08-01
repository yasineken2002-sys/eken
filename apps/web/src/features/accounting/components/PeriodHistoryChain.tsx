import { Lock, LockOpen } from 'lucide-react'
import { formatDate } from '@eken/shared'
import type { PeriodHistoryEvent, PeriodReasonCategory } from '../api/accounting.api'

// Uttömmande mot PeriodReasonCategory: en ny kategori (t.ex. när revisor-
// undantaget landar) ger kompileringsfel här i stället för en tom etikett i UI:t.
const CATEGORY_LABELS: Record<PeriodReasonCategory, string> = {
  MISSING_ENTRY: 'En post saknades',
  EXISTING_ENTRY_INCORRECT: 'En bokförd post var felaktig',
}

interface Props {
  events: PeriodHistoryEvent[]
}

/**
 * Periodens kedja — `stängd → öppnad → stängd`, nyast först.
 *
 * `seq` visas ALDRIG. Den är intern ordningsnyckel, inte något operatören ska
 * behöva förhålla sig till; kedjans ordning bär informationen.
 *
 * Orsakskategorin visas uttryckligen. Den är självdeklarerad och förebygger
 * inget tekniskt — dess värde ligger i att den som granskar i efterhand ser
 * vilket påstående som gjordes, av vem och när.
 */
export function PeriodHistoryChain({ events }: Props) {
  if (events.length === 0) {
    return <p className="text-[12px] text-gray-500">Perioden har aldrig stängts.</p>
  }

  const newestFirst = [...events].reverse()

  return (
    <ol className="space-y-3">
      {newestFirst.map((e) => {
        const reopened = e.type === 'REOPENED'
        return (
          <li key={e.seq} className="flex gap-2.5">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                reopened ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {reopened ? (
                <LockOpen size={12} strokeWidth={1.8} />
              ) : (
                <Lock size={12} strokeWidth={1.8} />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-gray-900">
                {reopened ? 'Öppnad igen' : 'Stängd'}
                <span className="font-normal text-gray-500">
                  {' · '}
                  {formatDate(e.createdAt)}
                  {e.actorLabel ? ` · ${e.actorLabel}` : ''}
                </span>
              </p>
              {reopened && (
                <p className="mt-0.5 text-[12px] text-gray-600">
                  {e.reasonCategory ? CATEGORY_LABELS[e.reasonCategory] : null}
                  {e.reason ? (
                    <>
                      {e.reasonCategory ? ' · ' : null}
                      <span className="italic">”{e.reason}”</span>
                    </>
                  ) : null}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
