import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowLeft, Receipt } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { formatCurrency } from '@eken/shared'
import { useCreditNotePreview, useCreateCreditNote } from '../hooks/useInvoiceQueries'
import type { CreditNotePreview, CreditNotePreviewLine } from '../api/invoices.api'
import { cn } from '@/lib/cn'

/**
 * KREDITNOTA — operatörens väg (#517).
 *
 * TVÅ STEG, för att en kreditnota är BINDANDE. Samma princip som gäller
 * inkasso-export och avskrivning: maskinen föreslår, människan bekräftar. Steg
 * två skriver ut totalen i klartext så att den som trycker har sett beloppet.
 *
 * MODALEN FÖRESLÅR, DEN VALIDERAR INTE BARA. Raderna förfylls med vad som
 * ÅTERSTÅR att kreditera per rad — ett tal servern räknar fram, eftersom
 * radtaket är kumulativt över alla tidigare kreditnotor och den summan bara
 * finns i databasen. En klient som gissat "återstår = radens belopp" hade
 * föreslagit belopp som API:et sedan avvisar, och operatören hade fått ett
 * felmeddelande för något gränssnittet självt föreslog.
 */

/** Samma öresavrundning som beräkningslagret i API:et. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Bruttobeloppet för ett nettobelopp, med API:ets formel. */
function grossOf(net: number, vatRate: number): number {
  return round2(net * (1 + vatRate / 100))
}

/**
 * Nettobeloppet som ger HÖGST det önskade bruttot.
 *
 * Operatören arbetar i belopp inklusive moms — det är så "Återstår" visas — men
 * API:t tar `unitPrice` exklusive moms. Naiv division kan ge ett netto vars
 * avrundade brutto ligger ett öre ÖVER taket, och då avvisas krediteringen av
 * radtaket. Ett öre nedåt är alltid rätt riktning här: hellre kreditera en
 * krona för lite än att fälla operatörens knapptryck på en avrundning.
 */
function netForGross(gross: number, vatRate: number): number {
  let net = round2(gross / (1 + vatRate / 100))
  while (net > 0 && grossOf(net, vatRate) > gross) net = round2(net - 0.01)
  return net
}

interface RadState {
  /** Belopp inklusive moms som operatören vill kreditera. Tom sträng = 0. */
  belopp: string
  aktiv: boolean
}

interface Props {
  invoiceId: string
  invoiceNumber: string
  open: boolean
  onClose: () => void
  onCreated: (creditNoteNumber: string, total: number) => void
}

export function CreditNoteModal({ invoiceId, invoiceNumber, open, onClose, onCreated }: Props) {
  const { data: preview, isLoading } = useCreditNotePreview(invoiceId, open)
  const mutation = useCreateCreditNote()

  const [steg, setSteg] = useState<'redigera' | 'bekrafta'>('redigera')
  const [reason, setReason] = useState('')
  const [rader, setRader] = useState<Record<string, RadState>>({})
  const [fel, setFel] = useState<string | null>(null)

  // Förfyll när underlaget landat. Nyckeln på previewens rader gör att en ny
  // preview (efter en tidigare kreditering) skriver över med de nya resterna.
  const förfylldNyckel = preview?.lines.map((l) => `${l.invoiceLineId}:${l.remaining}`).join('|')
  const [senasteNyckel, setSenasteNyckel] = useState<string | undefined>(undefined)
  if (preview && förfylldNyckel !== senasteNyckel) {
    setSenasteNyckel(förfylldNyckel)
    setRader(
      Object.fromEntries(
        preview.lines.map((l) => [
          l.invoiceLineId,
          { belopp: l.remaining > 0 ? l.remaining.toFixed(2) : '', aktiv: l.remaining > 0 },
        ]),
      ),
    )
    setSteg('redigera')
    setFel(null)
  }

  const beräknat = useMemo(() => {
    if (!preview) return { rader: [], summa: 0, momsSumma: 0, nettoSumma: 0 }
    const ut = preview.lines
      .map((l) => {
        const state = rader[l.invoiceLineId]
        const önskatBrutto = state?.aktiv ? Number(state.belopp.replace(',', '.')) || 0 : 0
        const kapat = Math.min(Math.max(önskatBrutto, 0), l.remaining)
        const netto = netForGross(kapat, l.vatRate)
        const brutto = grossOf(netto, l.vatRate)
        return { line: l, netto, brutto, moms: round2(brutto - netto), önskatBrutto }
      })
      .filter((r) => r.netto > 0)
    return {
      rader: ut,
      summa: round2(ut.reduce((s, r) => s + r.brutto, 0)),
      momsSumma: round2(ut.reduce((s, r) => s + r.moms, 0)),
      nettoSumma: round2(ut.reduce((s, r) => s + r.netto, 0)),
    }
  }, [preview, rader])

  function stäng() {
    setSteg('redigera')
    setReason('')
    setFel(null)
    setSenasteNyckel(undefined)
    onClose()
  }

  function skapa() {
    if (!preview) return
    setFel(null)
    mutation.mutate(
      {
        id: invoiceId,
        reason: reason.trim(),
        lines: beräknat.rader.map((r) => ({
          invoiceLineId: r.line.invoiceLineId,
          quantity: 1,
          unitPrice: r.netto,
        })),
      },
      {
        onSuccess: (res) => {
          onCreated(res.creditNote.invoiceNumber, beräknat.summa)
          stäng()
        },
        // Backendens meddelanden är skrivna för människor — radtaket namnger
        // raden och överskottet, inkassospärren säger var kravet ska hanteras.
        // De visas hela; att kapa dem vore att kasta bort det som hjälper.
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
      title={steg === 'redigera' ? 'Kreditera faktura' : 'Bekräfta kreditering'}
      description={`Ursprungsfaktura ${invoiceNumber}`}
      size="lg"
    >
      {isLoading && <p className="py-8 text-center text-[13px] text-gray-400">Hämtar underlag …</p>}

      {preview && !preview.allowed && (
        <BlockeradRuta reason={preview.blockedReason ?? 'Kreditering är inte möjlig.'} />
      )}

      {preview && preview.allowed && steg === 'redigera' && (
        <div className="space-y-4">
          <RadTabell preview={preview} rader={rader} setRader={setRader} beräknat={beräknat} />

          <div>
            <label
              htmlFor="credit-note-reason"
              className="mb-1.5 block text-[13px] font-medium text-gray-700"
            >
              Varför krediteras fakturan?
            </label>
            <Input
              id="credit-note-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="T.ex. Perioden avbeställd av hyresgästen"
            />
            <p className="mt-1 text-[12px] text-gray-400">
              Skälet hamnar på kreditnotan och i fakturans historik. Minst 5 tecken.
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
              Krediteringen är bindande
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-800/90">
              En kreditnota skapas som eget dokument med eget nummer, bokförs direkt och kan inte
              makuleras. Ursprungsfakturan lämnas orörd — fordran minskar i stället med det
              krediterade beloppet.
            </p>
          </div>

          <div className="border-line overflow-hidden rounded-2xl border">
            {beräknat.rader.map((r) => (
              <div
                key={r.line.invoiceLineId}
                className="border-line flex items-center justify-between border-b px-4 py-3 last:border-0"
              >
                <div>
                  <p className="text-[13px] text-gray-800">{r.line.description}</p>
                  <p className="text-[12px] text-gray-400">
                    {r.line.vatRate > 0
                      ? `${formatCurrency(r.netto)} exkl. moms · moms ${r.line.vatRate}% ${formatCurrency(r.moms)}`
                      : `${formatCurrency(r.netto)} · momsfritt`}
                  </p>
                </div>
                <p className="text-[13.5px] font-medium text-gray-900">
                  {formatCurrency(r.brutto)}
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

          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Skäl</p>
            <p className="mt-0.5 text-[13px] text-gray-800">{reason.trim()}</p>
          </div>

          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Restskuld efter kreditering
            </p>
            <p className="mt-0.5 text-[13.5px] font-medium text-gray-800">
              {formatCurrency(round2(preview.outstanding - beräknat.summa))}{' '}
              <span className="text-[12px] font-normal text-gray-400">
                (nu {formatCurrency(preview.outstanding)})
              </span>
            </p>
          </div>

          {fel && <FelRuta text={fel} />}

          <ModalFooter>
            <Button onClick={() => setSteg('redigera')}>
              <ArrowLeft size={13} strokeWidth={1.8} />
              Tillbaka
            </Button>
            <Button variant="primary" loading={mutation.isPending} onClick={skapa}>
              <Receipt size={13} strokeWidth={1.8} />
              Skapa kreditnota på {formatCurrency(beräknat.summa)}
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

function RadTabell({
  preview,
  rader,
  setRader,
  beräknat,
}: {
  preview: CreditNotePreview
  rader: Record<string, RadState>
  setRader: React.Dispatch<React.SetStateAction<Record<string, RadState>>>
  beräknat: { summa: number; momsSumma: number; nettoSumma: number }
}) {
  return (
    <div className="border-line bg-surface overflow-hidden rounded-2xl border shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-2.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
          Rader att kreditera
        </p>
      </div>

      <motion.div variants={container} initial="hidden" animate="show">
        {preview.lines.map((l) => (
          <motion.div key={l.invoiceLineId} variants={item}>
            <RadRad
              line={l}
              state={rader[l.invoiceLineId] ?? { belopp: '', aktiv: false }}
              onChange={(next) => setRader((r) => ({ ...r, [l.invoiceLineId]: next }))}
            />
          </motion.div>
        ))}
      </motion.div>

      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/60 px-4 py-3.5">
        <div>
          <p className="text-[13px] font-semibold text-gray-700">Summa att kreditera</p>
          <p className="text-[12px] text-gray-400">
            {formatCurrency(beräknat.nettoSumma)} exkl. moms + {formatCurrency(beräknat.momsSumma)}{' '}
            moms
          </p>
        </div>
        <p className="text-[22px] font-semibold tracking-tight text-gray-900">
          {formatCurrency(beräknat.summa)}
        </p>
      </div>
    </div>
  )
}

function RadRad({
  line,
  state,
  onChange,
}: {
  line: CreditNotePreviewLine
  state: RadState
  onChange: (next: RadState) => void
}) {
  const uttömd = line.remaining <= 0
  const önskat = Number(state.belopp.replace(',', '.')) || 0
  // Kapas mot taket redan här — operatören ska inte kunna skriva ett belopp som
  // API:t sedan avvisar. Talet under fältet visar vad som faktiskt krediteras.
  const kapat = state.aktiv ? Math.min(Math.max(önskat, 0), line.remaining) : 0
  const kapades = state.aktiv && önskat > line.remaining

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
                aria-label={`Kreditera raden ${line.description}`}
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
              {line.description}
            </p>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[12px] text-gray-500">
            <span>
              Fakturerat <strong className="font-medium">{formatCurrency(line.invoiced)}</strong>
            </span>
            <span>
              Redan krediterat{' '}
              <strong className="font-medium">{formatCurrency(line.credited)}</strong>
            </span>
            <span>
              Återstår <strong className="font-medium">{formatCurrency(line.remaining)}</strong>
            </span>
            <span className="text-gray-400">Moms {line.vatRate}%</span>
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
                max={line.remaining}
                disabled={!state.aktiv}
                value={state.belopp}
                aria-label={`Belopp att kreditera för ${line.description}`}
                onChange={(e) => onChange({ ...state, belopp: e.target.value })}
                className="text-right"
              />
              <p className="mt-1 text-right text-[11px] text-gray-400">
                {kapades ? (
                  <span className="text-amber-600">Kapat till taket: {formatCurrency(kapat)}</span>
                ) : (
                  'inkl. moms'
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BlockeradRuta({ reason }: { reason: string }) {
  return (
    <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
        <AlertTriangle size={14} strokeWidth={1.8} />
        Kreditering är inte möjlig för den här fakturan
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

/**
 * Backendens felmeddelande, ORÖRT.
 *
 * Radtaket namnger raden och överskottet; inkassospärren säger var kravet måste
 * hanteras. Att ersätta dem med "Något gick fel" hade kastat bort exakt det som
 * gör felet åtgärdbart.
 */
function felText(e: unknown): string {
  const svar = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data
  return (
    svar?.error?.message ?? (e as { message?: string })?.message ?? 'Kreditnotan kunde inte skapas.'
  )
}
