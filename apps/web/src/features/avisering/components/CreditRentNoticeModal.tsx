import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowLeft, Info, Scissors } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { formatCurrency } from '@eken/shared'
import { useRentNoticeCreditPreview, useCreateRentNoticeCredit } from '../hooks/useAvisering'
import type {
  RentNoticeCreditBucket,
  RentNoticeCreditPreview,
  RentNoticeCreditProjection,
} from '../api/avisering.api'
import { cn } from '@/lib/cn'

/**
 * KREDITERING AV HYRESAVI — operatörens väg (#518).
 *
 * ── EN KREDITERING ÄR INGEN AVI ─────────────────────────────────────────────
 *
 * Den har inget OCR-nummer, inget förfallodatum och inget eget dokument som
 * hyresgästen ska betala. Den är en NEDSÄTTNING av en avi som redan finns.
 * Vyn är därför byggd som ett avdrag från en befintlig post — inte som ett nytt
 * kravdokument. Skillnaden är inte kosmetisk: ser krediteringen ut som en avi
 * kommer någon förr eller senare att leta efter dess OCR-nummer.
 *
 * ── MODALEN FÖRESLÅR ────────────────────────────────────────────────────────
 *
 * Raderna förfylls med vad som ÅTERSTÅR att kreditera per post. Taket är
 * kumulativt över alla tidigare krediteringar och finns bara i databasen — en
 * klient som gissat "återstår = postens belopp" hade föreslagit belopp som
 * API:et sedan avvisar, och operatören hade fått ett fel för något gränssnittet
 * självt föreslog. Inmatningen kapas dessutom mot taket redan här.
 *
 * ── RÄNTEFALLET ─────────────────────────────────────────────────────────────
 *
 * Krediteras kapitalet till noll medan dröjsmålsränta står kvar stannar avin och
 * väntar på ett människobeslut i stället för att gå vidare i kravtrappan. Det
 * ska operatören se INNAN hon bekräftar. Utfallet räknas av SERVERN
 * (`projection`) — regeln finns i `computeRentDebt` och ska inte finnas en andra
 * gång här.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Postens nyckel i formuläret. Hyreskapitalet har inget rad-id. */
function bucketKey(b: RentNoticeCreditBucket): string {
  return b.rentNoticeLineId ?? 'capital'
}

interface RadState {
  belopp: string
  aktiv: boolean
}

interface Props {
  rentNoticeId: string
  noticeNumber: string
  open: boolean
  onClose: () => void
  onCreated: (belopp: number, stannadePåRänta: boolean) => void
}

export function CreditRentNoticeModal({
  rentNoticeId,
  noticeNumber,
  open,
  onClose,
  onCreated,
}: Props) {
  const { data: preview, isLoading } = useRentNoticeCreditPreview(rentNoticeId, open)
  const mutation = useCreateRentNoticeCredit()

  const [steg, setSteg] = useState<'redigera' | 'bekrafta'>('redigera')
  const [reason, setReason] = useState('')
  const [rader, setRader] = useState<Record<string, RadState>>({})
  const [fel, setFel] = useState<string | null>(null)

  // Förfyll när underlaget landat. Nyckeln bär posternas ÅTERSTÅENDE belopp, så
  // ett nytt underlag efter en tidigare kreditering skriver över med de nya
  // resterna — men ett oförändrat underlag rör inte operatörens inmatning.
  const förfylldNyckel = preview?.buckets.map((b) => `${bucketKey(b)}:${b.remaining}`).join('|')
  const [senasteNyckel, setSenasteNyckel] = useState<string | undefined>(undefined)
  if (preview && förfylldNyckel !== senasteNyckel) {
    setSenasteNyckel(förfylldNyckel)
    setRader(
      Object.fromEntries(
        preview.buckets.map((b) => [
          bucketKey(b),
          { belopp: b.remaining > 0 ? b.remaining.toFixed(2) : '', aktiv: b.remaining > 0 },
        ]),
      ),
    )
    setSteg('redigera')
    setFel(null)
  }

  const beräknat = useMemo(() => {
    if (!preview)
      return { rader: [] as Array<{ bucket: RentNoticeCreditBucket; belopp: number }>, summa: 0 }
    const ut = preview.buckets
      .map((b) => {
        const state = rader[bucketKey(b)]
        const önskat = state?.aktiv ? Number(state.belopp.replace(',', '.')) || 0 : 0
        // Kapas mot taket redan här — operatören ska inte kunna skicka något
        // API:et avvisar.
        return { bucket: b, belopp: round2(Math.min(Math.max(önskat, 0), b.remaining)) }
      })
      .filter((r) => r.belopp > 0)
    return { rader: ut, summa: round2(ut.reduce((s, r) => s + r.belopp, 0)) }
  }, [preview, rader])

  // ── PROJEKTIONEN: vad krediteringen LEDER TILL, enligt servern ─────────────
  //
  // Debouncad, så varje tangenttryck inte blir ett anrop. Talet som frågas om är
  // den kapade summan — samma tal som visas och samma tal som skickas.
  const [debouncadSumma, setDebouncadSumma] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setDebouncadSumma(beräknat.summa), 250)
    return () => clearTimeout(t)
  }, [beräknat.summa])

  const { data: projektionSvar } = useRentNoticeCreditPreview(
    rentNoticeId,
    open && debouncadSumma > 0,
    debouncadSumma,
  )
  // Bara giltig när den gäller EXAKT den summa som visas. Annars vore panelen
  // ett påstående om ett annat belopp än det operatören ser.
  const projektion =
    projektionSvar?.projection && projektionSvar.projection.applied === beräknat.summa
      ? projektionSvar.projection
      : null

  function stäng() {
    setSteg('redigera')
    setReason('')
    setFel(null)
    setSenasteNyckel(undefined)
    setDebouncadSumma(0)
    onClose()
  }

  function skapa() {
    if (!preview) return
    setFel(null)
    mutation.mutate(
      {
        id: rentNoticeId,
        reason: reason.trim(),
        lines: beräknat.rader.map((r) => ({
          // Hyreskapitalet har inget rad-id, och fältet UTELÄMNAS då — det är
          // så API:et skiljer kapitalet från en avi-rad.
          ...(r.bucket.rentNoticeLineId ? { rentNoticeLineId: r.bucket.rentNoticeLineId } : {}),
          amount: r.belopp,
        })),
      },
      {
        onSuccess: (res) => {
          onCreated(res.credit.amount, res.rentNotice.interestOnlyAfterCredit)
          stäng()
        },
        // Backendens meddelanden är skrivna för människor — radtaket namnger
        // posten och överskottet, spärrarna säger vad som ska göras i stället.
        // De visas hela.
        onError: (e: unknown) => setFel(felText(e)),
      },
    )
  }

  const kanFortsätta =
    beräknat.rader.length > 0 && reason.trim().length >= 5 && (preview?.allowed ?? false)

  return (
    <Modal
      open={open}
      onClose={stäng}
      title={steg === 'redigera' ? 'Sätt ned hyresavi' : 'Bekräfta nedsättning'}
      description={`Avi ${noticeNumber} · krediteringen är ett avdrag på avin, inte en ny avi`}
      size="lg"
    >
      {isLoading && <p className="py-8 text-center text-[13px] text-gray-400">Hämtar underlag …</p>}

      {preview && !preview.allowed && (
        <BlockeradRuta reason={preview.blockedReason ?? 'Kreditering är inte möjlig.'} />
      )}

      {preview && preview.allowed && steg === 'redigera' && (
        <div className="space-y-4">
          <PostTabell preview={preview} rader={rader} setRader={setRader} summa={beräknat.summa} />

          {projektion && <RäntePanel projektion={projektion} />}

          <div>
            <label
              htmlFor="rent-credit-reason"
              className="mb-1.5 block text-[13px] font-medium text-gray-700"
            >
              Varför sätts avin ned?
            </label>
            <Input
              id="rent-credit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="T.ex. Felaktigt debiterad varmvattenförbrukning"
            />
            <p className="mt-1 text-[12px] text-gray-400">
              Skälet sparas på krediteringen och i avins historik. Det är det enda som skiljer en
              nedsättning från en annullering i efterhand. Minst 5 tecken.
            </p>
          </div>

          {fel && <FelRuta text={fel} />}

          <ModalFooter>
            <Button onClick={stäng}>Avbryt</Button>
            <Button variant="primary" disabled={!kanFortsätta} onClick={() => setSteg('bekrafta')}>
              Fortsätt
            </Button>
          </ModalFooter>
        </div>
      )}

      {preview && preview.allowed && steg === 'bekrafta' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
              <AlertTriangle size={14} strokeWidth={1.8} />
              Nedsättningen är bindande
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-800/90">
              Krediteringen bokförs direkt och kan inte ångras. Avin står kvar som den är — det är
              fordran som minskar med det krediterade beloppet.
            </p>
          </div>

          <div className="border-line overflow-hidden rounded-2xl border">
            {beräknat.rader.map((r) => (
              <div
                key={bucketKey(r.bucket)}
                className="border-line flex items-center justify-between border-b px-4 py-3 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-gray-800">{r.bucket.description}</p>
                  <p className="text-[12px] text-gray-400">
                    aviserat {formatCurrency(r.bucket.invoiced)} · återstod{' '}
                    {formatCurrency(r.bucket.remaining)}
                  </p>
                </div>
                <p className="flex-shrink-0 pl-4 text-[13.5px] font-medium text-gray-900">
                  −{formatCurrency(r.belopp)}
                </p>
              </div>
            ))}
            <div className="flex items-center justify-between bg-gray-50/60 px-4 py-3.5">
              <p className="text-[13px] font-semibold text-gray-700">Krediteras totalt</p>
              <p className="text-[22px] font-semibold tracking-tight text-gray-900">
                {formatCurrency(beräknat.summa)}
              </p>
            </div>
          </div>

          {projektion && <RäntePanel projektion={projektion} />}

          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Skäl</p>
            <p className="mt-0.5 text-[13px] text-gray-800">{reason.trim()}</p>
          </div>

          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Skuld efter nedsättningen
            </p>
            {projektion ? (
              <p className="mt-0.5 text-[13.5px] font-medium text-gray-800">
                {formatCurrency(projektion.outstanding)}{' '}
                <span className="text-[12px] font-normal text-gray-400">
                  (nu {formatCurrency(projektion.outstandingBefore)})
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-[12.5px] text-gray-400">Beräknas …</p>
            )}
          </div>

          {fel && <FelRuta text={fel} />}

          <ModalFooter>
            <Button onClick={() => setSteg('redigera')}>
              <ArrowLeft size={13} strokeWidth={1.8} />
              Tillbaka
            </Button>
            <Button variant="primary" loading={mutation.isPending} onClick={skapa}>
              <Scissors size={13} strokeWidth={1.8} />
              Kreditera {formatCurrency(beräknat.summa)}
            </Button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  )
}

// ─── Delkomponenter ──────────────────────────────────────────────────────────

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

function PostTabell({
  preview,
  rader,
  setRader,
  summa,
}: {
  preview: RentNoticeCreditPreview
  rader: Record<string, RadState>
  setRader: React.Dispatch<React.SetStateAction<Record<string, RadState>>>
  summa: number
}) {
  return (
    <div className="border-line bg-surface overflow-hidden rounded-2xl border shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-2.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
          Poster att sätta ned
        </p>
      </div>

      <motion.div variants={container} initial="hidden" animate="show">
        {preview.buckets.map((b) => (
          <motion.div key={bucketKey(b)} variants={item}>
            <PostRad
              bucket={b}
              state={rader[bucketKey(b)] ?? { belopp: '', aktiv: false }}
              onChange={(next) => setRader((r) => ({ ...r, [bucketKey(b)]: next }))}
            />
          </motion.div>
        ))}
      </motion.div>

      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/60 px-4 py-3.5">
        <div>
          <p className="text-[13px] font-semibold text-gray-700">Summa att kreditera</p>
          <p className="text-[12px] text-gray-400">
            Går att kreditera nu: {formatCurrency(preview.creditableNow)}
          </p>
        </div>
        <p className="text-[22px] font-semibold tracking-tight text-gray-900">
          {formatCurrency(summa)}
        </p>
      </div>
    </div>
  )
}

function PostRad({
  bucket,
  state,
  onChange,
}: {
  bucket: RentNoticeCreditBucket
  state: RadState
  onChange: (next: RadState) => void
}) {
  const uttömd = bucket.remaining <= 0
  const önskat = Number(state.belopp.replace(',', '.')) || 0
  const kapat = state.aktiv ? Math.min(Math.max(önskat, 0), bucket.remaining) : 0
  const kapades = state.aktiv && önskat > bucket.remaining

  return (
    <div
      className={cn(
        'border-b border-[var(--ev-row-border)] px-4 py-3.5 last:border-0',
        uttömd && 'bg-gray-50/60',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!uttömd && (
              <input
                type="checkbox"
                aria-label={`Sätt ned posten ${bucket.description}`}
                checked={state.aktiv}
                onChange={(e) => onChange({ ...state, aktiv: e.target.checked })}
                className="border-line accent-brand h-4 w-4 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
              />
            )}
            <p
              className={cn(
                'truncate text-[13.5px] font-medium',
                uttömd ? 'text-gray-400' : 'text-gray-800',
              )}
            >
              {bucket.description}
            </p>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[12px] text-gray-500">
            <span>
              Aviserat <strong className="font-medium">{formatCurrency(bucket.invoiced)}</strong>
            </span>
            <span>
              Redan krediterat{' '}
              <strong className="font-medium">{formatCurrency(bucket.credited)}</strong>
            </span>
            <span>
              Återstår <strong className="font-medium">{formatCurrency(bucket.remaining)}</strong>
            </span>
          </div>
        </div>

        <div className="w-40 flex-shrink-0">
          {uttömd ? (
            <p className="pt-1 text-right text-[12px] text-gray-400">Helt krediterad</p>
          ) : (
            <>
              <Input
                type="number"
                step="0.01"
                min="0"
                max={bucket.remaining}
                disabled={!state.aktiv}
                value={state.belopp}
                aria-label={`Belopp att kreditera för ${bucket.description}`}
                onChange={(e) => onChange({ ...state, belopp: e.target.value })}
                className="text-right"
              />
              <p className="mt-1 text-right text-[11px] text-gray-400">
                {kapades ? (
                  <span className="text-amber-600">Kapat till taket: {formatCurrency(kapat)}</span>
                ) : (
                  'kronor'
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * RÄNTEFALLET, SKRIVET FÖR EN MÄNNISKA.
 *
 * Två utfall, och de betyder olika saker för operatören:
 *
 *  • Kapitalet krediteras bort men ränta står kvar → avin STANNAR. Varken
 *    inkassoöverlämning eller avskrivning sker automatiskt, eftersom räntan
 *    löpt på ett belopp som just visade sig felaktigt. Beslutet blir hennes.
 *  • Annars: en vanlig nedsättning, och det som återstår drivs vidare som förut.
 *
 * Panelen visar VAD som krediteras, VAD som blir kvar och VAD det innebär — inte
 * "outstanding > 0".
 */
function RäntePanel({ projektion }: { projektion: RentNoticeCreditProjection }) {
  if (projektion.interestOnlyAfterCredit) {
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
          <AlertTriangle size={14} strokeWidth={1.8} />
          Efter den här nedsättningen återstår bara dröjsmålsränta
        </p>
        <div className="mt-2.5 space-y-1 text-[12.5px] leading-relaxed text-amber-800/90">
          <p>
            Du krediterar <strong>{formatCurrency(projektion.applied)}</strong>. Hela det belopp
            hyresgästen skulle betala på avin är då borta —{' '}
            <strong>{formatCurrency(projektion.interest)}</strong> i upplupen dröjsmålsränta står
            kvar.
          </p>
          <p>
            Räntan har alltså löpt på ett belopp som nu visat sig felaktigt.{' '}
            <strong>Avin stannar därför här</strong>: den lämnas inte över till inkasso och skrivs
            inte ned automatiskt. Om räntan ska falla bort är ett beslut du tar — systemet gör det
            inte åt dig.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-gray-700">
        <Info size={14} strokeWidth={1.8} />
        Så påverkas kravet
      </p>
      <div className="mt-2.5 space-y-1 text-[12.5px] leading-relaxed text-gray-600">
        <p>
          Du krediterar <strong>{formatCurrency(projektion.applied)}</strong>. Kvar att betala på
          avin blir <strong>{formatCurrency(projektion.ocrOutstanding)}</strong>
          {projektion.interest > 0 ? (
            <>, plus {formatCurrency(projektion.interest)} i upplupen dröjsmålsränta.</>
          ) : (
            '.'
          )}
        </p>
        <p>
          {projektion.outstanding > 0
            ? 'Återstoden drivs vidare som förut — påminnelser och kravtrappa fortsätter gälla för det som är kvar.'
            : 'Hela kravet är därmed reglerat och avin eskalerar inte vidare.'}
        </p>
      </div>
    </div>
  )
}

function BlockeradRuta({ reason }: { reason: string }) {
  return (
    <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
        <AlertTriangle size={14} strokeWidth={1.8} />
        Den här avin går inte att sätta ned
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-800/90">{reason}</p>
    </div>
  )
}

function FelRuta({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-red-100 bg-red-50 p-3">
      <p className="text-[12.5px] leading-relaxed text-red-600">{text}</p>
    </div>
  )
}

/** Backendens felmeddelande, ORÖRT — det är det som gör felet åtgärdbart. */
function felText(e: unknown): string {
  const svar = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data
  return (
    svar?.error?.message ??
    (e as { message?: string })?.message ??
    'Krediteringen kunde inte skapas.'
  )
}
