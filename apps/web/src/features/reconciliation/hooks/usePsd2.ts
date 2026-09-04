import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  beginBankConsent,
  enqueueBankSync,
  getBankConsents,
  revokeBankConsent,
} from '../api/psd2.api'
import type { BankConsent } from '../api/psd2.api'

/**
 * Nyckelrymden `['psd2', …]` är DISJUNKT från bankavstämningens
 * `['reconciliation', …]`. De rör samma domän men olika resurser, och en
 * gemensam prefix hade gjort att en invalidering av transaktionslistan även
 * slängde samtyckena — eller värre, tvärtom: ett samtycke som ändras säger
 * ingenting om vilka transaktioner som finns.
 *
 * ETT UNDANTAG, och det är avsiktligt: en LYCKAD synk skapar
 * BankTransaction-rader, så `useSyncBank` invaliderar BÅDA rymderna. Det är en
 * riktad korsning vid en känd händelse, inte en delad prefix.
 */
export const PSD2_KEYS = {
  consents: ['psd2', 'consents'] as const,
}

/**
 * `pollar` styr om listan hämtas om automatiskt. Den är på BARA medan en synk
 * väntas in — en bankkoppling ändrar sig annars på dagsskala, och en stående
 * poll hade varit ett anrop var annan sekund i en vy som nästan alltid står
 * stilla.
 */
export function useBankConsents(pollar = false) {
  return useQuery({
    queryKey: PSD2_KEYS.consents,
    queryFn: getBankConsents,
    staleTime: 60_000,
    refetchInterval: pollar ? 2_000 : false,
  })
}

export function useBeginBankConsent() {
  return useMutation({
    mutationFn: beginBankConsent,
  })
}

export function useRevokeBankConsent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeBankConsent(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PSD2_KEYS.consents })
    },
  })
}

export function useSyncBank() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: enqueueBankSync,
    onSuccess: () => {
      // Kön har tagit emot jobbet — den har inte kört det. Invalideringen här
      // gör bara att listan hämtas om en gång direkt; det är pollningen i sidan
      // som avgör när synken faktiskt är klar.
      void qc.invalidateQueries({ queryKey: PSD2_KEYS.consents })
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    },
  })
}

// ─── Ren beslutsfunktion för pollningen ──────────────────────────────────────

export type SynkLage = 'pagar' | 'klar' | 'uppgiven'

/**
 * SYNKEN ÄR ASYNKRON, OCH DET FINNS INGEN STATUS-ENDPOINT.
 *
 * `POST /sync` returnerar `{ enqueued, jobId }` — ett kvitto på att Bull tagit
 * emot jobbet, ingenting om utfallet. Det enda observerbara spåret av en
 * FULLBORDAD synk är att `BankConsent.lastSyncedAt` flyttar sig
 * (`psd2-sync.service.ts` skriver det sist per samtycke).
 *
 * Därför jämförs en BASLINJE tagen före anropet mot det som kommer tillbaka. Att
 * bara titta på "finns ett värde" hade gjort andra synken oskiljbar från den
 * första — och att titta på `enqueued` hade svarat på fel fråga.
 *
 * UPPGIVEN ÄR INTE ETT FEL. Ett jobb som ännu inte körts, en kö som ligger
 * efter, eller en synk som tog längre tid än fönstret ser likadana ut härifrån.
 * Att kalla det "misslyckades" hade varit ett påstående vi inte kan belägga —
 * texten i UI:t säger därför att synken pågår, inte att den föll.
 */
export const SYNK_TIMEOUT_MS = 30_000

export function synkLage(input: {
  baslinje: ReadonlyMap<string, string | null>
  nu: readonly BankConsent[]
  forflutenMs: number
}): SynkLage {
  const flyttat = input.nu.some((c) => {
    // Ett samtycke som TILLKOMMIT sedan baslinjen räknas inte som en flyttad
    // tidsstämpel: det är en annan händelse (någon anslöt en bank i en annan
    // flik) och skulle annars avsluta pollningen utan att en synk skett.
    if (!input.baslinje.has(c.id)) return false
    return input.baslinje.get(c.id) !== c.lastSyncedAt
  })
  if (flyttat) return 'klar'
  return input.forflutenMs >= SYNK_TIMEOUT_MS ? 'uppgiven' : 'pagar'
}

export function synkBaslinje(consents: readonly BankConsent[]): Map<string, string | null> {
  return new Map(consents.map((c) => [c.id, c.lastSyncedAt]))
}
