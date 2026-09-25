import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { validateSwedishBankgiro } from '@eken/shared'
import { useOrganization } from '@/features/settings/hooks/useSettings'

/**
 * K2 — BLOCKERINGEN AV AVIUTSKICK, SYNLIG DÄR HYRESVÄRDEN STÅR.
 *
 * Kundprovet 2026-09-23 skickade avier med ett påhittat bankgiro. API:et stoppar
 * dem nu, men ett stopp utan förklaring är bara ett fel som inte går att åtgärda.
 * Rutan säger vad som saknas, varför det spelar roll och var det fylls i — med en
 * länk till den FAKTISKA inställningsvyn, inte till en hjälptext.
 *
 * ── SAMMA REGEL SOM SERVERN, INTE EN ANDRA ──────────────────────────────────
 *
 * Villkoret är `validateSwedishBankgiro` ur `@eken/shared` — exakt den funktion
 * `checkPaymentTarget` i API:et anropar. En egen kontroll här hade kunnat säga
 * "allt är bra" om ett värde servern avvisar, och då hade knappen varit aktiv
 * och utskicket ändå uteblivit.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Den mäter organisationens fält, inte att ett enskilt utskick lyckades. Att
 * servern faktiskt vägrar bärs av API:ets grind och dess prov; rutan är
 * förklaringen, aldrig skyddet.
 */

/** Delas av bannern och av de sidor som behöver avstänga sina sändknappar. */
export function usePaymentTargetOk(): { ok: boolean; loading: boolean } {
  const { data: org, isLoading } = useOrganization()
  // Medan organisationen laddar påstår vi INGET fel: en ruta som blinkar fram
  // vid varje sidladdning blir brus, och knapparna hinner ändå inte klickas.
  if (isLoading || !org) return { ok: true, loading: true }
  return { ok: validateSwedishBankgiro(org.bankgiro).valid, loading: false }
}

interface Props {
  /** Vad blockeringen gäller på just den här sidan. Svensk, kort mening. */
  vad: string
  /**
   * Dokumentet i bestämd form, för meningen om vad som annars skulle hända.
   * Default "avin" — avisidornas text är oförändrad. Fakturavyn skickar
   * "fakturan" (F8).
   */
  dokument?: string
}

export function PaymentTargetBanner({ vad, dokument = 'avin' }: Props) {
  const { data: org, isLoading } = useOrganization()
  if (isLoading || !org) return null

  const kontroll = validateSwedishBankgiro(org.bankgiro)
  if (kontroll.valid) return null

  const harVarde = Boolean(org.bankgiro && org.bankgiro.trim())

  return (
    <div
      data-testid="payment-target-banner"
      className="rounded-2xl border border-red-200 bg-red-50/70 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
          <AlertTriangle size={17} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-red-900">
            {harVarde ? 'Organisationens bankgiro är ogiltigt' : 'Organisationens bankgiro saknas'}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-red-800/90">
            {vad} Hyresgästen behöver ett riktigt bankgiro att betala till — utan det skulle{' '}
            {dokument} bära ett betalningsmål som inte fungerar.
          </p>
          {harVarde && kontroll.error && (
            <p className="mt-1 text-[12.5px] text-red-700/90">{kontroll.error}.</p>
          )}
          <Link
            to="/settings"
            className="mt-3 inline-flex min-h-8 items-center rounded-[10px] bg-red-600 px-3.5 py-1.5 text-[13px] font-medium leading-tight text-white transition-colors hover:bg-red-700"
          >
            Fyll i bankgiro under Inställningar
          </Link>
        </div>
      </div>
    </div>
  )
}
