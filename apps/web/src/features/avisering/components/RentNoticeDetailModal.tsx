import { useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Info, PauseCircle, Scissors } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatCurrency, formatDate } from '@eken/shared'
import { RentNoticeBadge } from './RentNoticeBadge'
import { CreditRentNoticeModal } from './CreditRentNoticeModal'
import {
  useRentNoticeCollectionStatus,
  useRentNoticeCreditPreview,
  useRentNoticeEvents,
} from '../hooks/useAvisering'
import { CollectionStatusPanel } from './CollectionStatusPanel'
import { RentNoticeEventsPanel } from './RentNoticeEventsPanel'
import type {
  RentCollectionStage,
  RentNotice,
  RentNoticeCreditPreview,
  RentNoticeCreditRecord,
} from '../api/avisering.api'
import { cn } from '@/lib/cn'

/**
 * AVI-DETALJEN — och ingången till kreditering (#518).
 *
 * ── VARFÖR VYN LÄSER SERVERNS UNDERLAG I STÄLLET FÖR AVI-RADEN ──────────────
 *
 * Listraden bär `totalAmount`: avins BRUTTO. Den siffran är fel i samma sekund
 * något krediteras eller betalas. Skulden är ett BERÄKNAT tillstånd, och det
 * enda stället den beräknas är `computeRentDebt` i API:et. Vyn visar därför
 * `debt` ur krediteringsunderlaget — samma tal som kravtrappan, inkassoexporten
 * och nedskrivningen fattar sina beslut på.
 *
 * ── KNAPPEN ─────────────────────────────────────────────────────────────────
 *
 * `allowed` kommer från `assessRentNoticeCreditability`, samma funktion som
 * skrivvägen kastar på. Går det inte visas SKÄLET — knappen försvinner aldrig
 * tyst, för då hade operatören inte kunnat skilja "får inte" från "finns inte".
 *
 * Rollgrinden härleds inte heller här: läsningen har samma `@Roles` som
 * åtgärden, så ett 403 på underlaget betyder att rollen inte får kreditera.
 */

interface Props {
  notice: RentNotice
  onClose: () => void
}

const STAGE: Record<RentCollectionStage, { label: string; className: string }> = {
  NONE: { label: 'Inget krav påbörjat', className: 'bg-gray-200 text-gray-500' },
  REMINDED: { label: 'Påmind', className: 'bg-amber-50 text-amber-700' },
  INKASSO_READY: { label: 'Redo för inkasso', className: 'bg-red-50 text-red-600' },
  WRITTEN_OFF: { label: 'Avskriven', className: 'bg-gray-100 text-gray-500' },
}

export function RentNoticeDetailModal({ notice, onClose }: Props) {
  const [creditOpen, setCreditOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const { data: preview, isLoading, error } = useRentNoticeCreditPreview(notice.id, true)
  // #648 — samma rollgrind som krediteringsunderlaget, så ETT 403-svar täcker
  // alla tre. Skulle grindarna glida isär blir det synligt som en tom panel och
  // inte som ett tyst bortfall: panelerna renderas bara på faktisk data.
  const { data: status } = useRentNoticeCollectionStatus(notice.id, true)
  const { data: events } = useRentNoticeEvents(notice.id, true)
  const nekad = (error as { response?: { status?: number } })?.response?.status === 403

  const tenantName =
    notice.tenant.type === 'COMPANY'
      ? (notice.tenant.companyName ?? '—')
      : `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`Avi ${notice.noticeNumber}`}
        description={`${tenantName} · ${notice.lease?.unit?.property?.name ?? ''} ${notice.lease?.unit?.name ?? ''} · ${notice.month}/${notice.year}`}
        size="lg"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <RentNoticeBadge status={notice.status} />
            {preview && <StageBadge stage={preview.collectionStage} />}
            <span className="rounded-md bg-gray-200 px-2 py-0.5 font-mono text-[12px] font-semibold text-gray-500">
              {notice.ocrNumber}
            </span>
            <span className="text-[12px] text-gray-400">
              Förfaller {formatDate(notice.dueDate)}
            </span>
          </div>

          {flash && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
              <p className="text-[12.5px] leading-relaxed text-emerald-700">{flash}</p>
            </div>
          )}

          {isLoading && (
            <p className="py-8 text-center text-[13px] text-gray-400">Hämtar avins underlag …</p>
          )}

          {nekad && (
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-[13px] text-gray-400">
                Din roll får inte se avins skuldunderlag, händelselogg eller kreditera den.
              </p>
            </div>
          )}

          {preview && (
            <>
              {/* Kravtrappan har stannat — det är det viktigaste på hela sidan
                  när det gäller, och står därför överst. */}
              {preview.debt.interestOnlyAfterCredit && <StannadPaRanta preview={preview} />}

              {/* #648 — VARFÖR STÅR AVIN STILL. Överst av samma skäl som raden
                  ovan: när det gäller är det det viktigaste på hela sidan, och
                  två av kravtrappans tre vägar vidare syns ingen annanstans. */}
              {status && <CollectionStatusPanel status={status} />}

              <SkuldPanel preview={preview} />

              <KrediteringsLista credits={preview.credits} />

              {!preview.allowed && preview.blockedReason && (
                <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
                    <AlertTriangle size={14} strokeWidth={1.8} />
                    Avin går inte att sätta ned
                  </p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-800/90">
                    {preview.blockedReason}
                  </p>
                </div>
              )}

              {events && <RentNoticeEventsPanel events={events} />}

              <div className="border-line flex items-center justify-end gap-2 border-t pt-4">
                <Button onClick={onClose}>Stäng</Button>
                {preview.allowed && (
                  <Button variant="primary" onClick={() => setCreditOpen(true)}>
                    <Scissors size={13} strokeWidth={1.8} />
                    Sätt ned avin
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

      {creditOpen && (
        <CreditRentNoticeModal
          rentNoticeId={notice.id}
          noticeNumber={notice.noticeNumber}
          open={creditOpen}
          onClose={() => setCreditOpen(false)}
          onCreated={(belopp, stannadePåRänta) =>
            setFlash(
              `Avin är nedsatt med ${formatCurrency(belopp)}.` +
                (stannadePåRänta
                  ? ' Bara dröjsmålsränta återstår, och avin stannar nu för ditt beslut — den går inte vidare i kravtrappan.'
                  : ' Fordran har minskat.'),
            )
          }
        />
      )}
    </>
  )
}

// ─── Delkomponenter ──────────────────────────────────────────────────────────

function StageBadge({ stage }: { stage: RentCollectionStage }) {
  const { label, className } = STAGE[stage] ?? STAGE.NONE
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        className,
      )}
    >
      {label}
    </span>
  )
}

/**
 * Kravtrappan står stilla för att kapitalet krediterats bort men räntan står
 * kvar. Skrivet som ett tillstånd operatören ska GÖRA något åt, inte som en
 * flagga: annars ser avin bara ut att ha fastnat.
 */
function StannadPaRanta({ preview }: { preview: RentNoticeCreditPreview }) {
  return (
    <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
        <PauseCircle size={14} strokeWidth={1.8} />
        Avin väntar på ditt beslut
      </p>
      <div className="mt-2.5 space-y-1 text-[12.5px] leading-relaxed text-amber-800/90">
        <p>
          Hela beloppet hyresgästen skulle betala är krediterat.{' '}
          <strong>{formatCurrency(preview.debt.interest)}</strong> i upplupen dröjsmålsränta står
          kvar — ränta som löpt på ett belopp som sedan visade sig felaktigt.
        </p>
        <p>
          Därför har kravet <strong>stannat här</strong>: avin lämnas inte över till inkasso och
          skrivs inte ned automatiskt. Om räntan ska falla bort avgör du tillsammans med din
          redovisningskonsult.
        </p>
      </div>
    </div>
  )
}

/** Den BERÄKNADE skulden. Aldrig avins bruttobelopp. */
function SkuldPanel({ preview }: { preview: RentNoticeCreditPreview }) {
  const d = preview.debt
  const rader: Array<{ label: string; värde: number; dämpad?: boolean }> = [
    { label: 'Hyra', värde: d.capital },
    { label: 'Förbrukning (IMD)', värde: d.consumption },
    { label: 'Övriga debiteringar', värde: d.miscCharge },
    { label: 'Påminnelseavgift', värde: d.reminderFee },
    { label: 'Dröjsmålsränta', värde: d.interest },
  ].filter((r) => r.värde !== 0)

  return (
    <div className="border-line bg-surface overflow-hidden rounded-2xl border shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-2.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
          Beräknad skuld
        </p>
      </div>

      <div className="px-4 py-3">
        {rader.map((r) => (
          <div key={r.label} className="flex items-center justify-between py-1">
            <span className="text-[13px] text-gray-600">{r.label}</span>
            <span className="text-[13px] text-gray-800">{formatCurrency(r.värde)}</span>
          </div>
        ))}

        {d.paid > 0 && (
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-gray-600">Betalt</span>
            <span className="text-[13px] text-emerald-700">−{formatCurrency(d.paid)}</span>
          </div>
        )}

        {d.credited > 0 && (
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-gray-600">Krediterat</span>
            <span className="text-[13px] text-gray-800">−{formatCurrency(d.credited)}</span>
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold text-gray-700">Kvar att betala</p>
            <p className="text-[12px] text-gray-400">
              varav {formatCurrency(preview.debt.ocrOutstanding)} på avins OCR
            </p>
          </div>
          <p className="text-[26px] font-semibold tracking-tight text-gray-900">
            {formatCurrency(d.outstanding)}
          </p>
        </div>
      </div>
    </div>
  )
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

/** Krediteringarna med belopp, skäl och datum — annars syns bara att skulden sjönk. */
function KrediteringsLista({ credits }: { credits: RentNoticeCreditRecord[] }) {
  if (credits.length === 0) {
    return (
      <div className="border-line rounded-2xl border border-dashed px-4 py-3">
        <p className="flex items-center gap-2 text-[12.5px] text-gray-400">
          <Info size={13} strokeWidth={1.8} />
          Avin är inte nedsatt.
        </p>
      </div>
    )
  }

  return (
    <div className="border-line bg-surface overflow-hidden rounded-2xl border shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-2.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
          Nedsättningar ({credits.length})
        </p>
      </div>
      <motion.div variants={container} initial="hidden" animate="show">
        {credits.map((c) => (
          <motion.div
            key={c.id}
            variants={item}
            className="border-b border-[var(--ev-row-border)] px-4 py-3.5 last:border-0"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-gray-800">{c.reason}</p>
                <p className="mt-0.5 text-[12px] text-gray-400">{formatDate(c.creditedAt)}</p>
                <div className="mt-1.5 space-y-0.5">
                  {c.lines.map((r) => (
                    <div key={r.id} className="flex justify-between text-[12px] text-gray-500">
                      <span className="truncate pr-4">{r.description}</span>
                      <span className="flex-shrink-0">−{formatCurrency(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="flex-shrink-0 text-[13.5px] font-medium text-gray-900">
                −{formatCurrency(c.amount)}
              </p>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  )
}
