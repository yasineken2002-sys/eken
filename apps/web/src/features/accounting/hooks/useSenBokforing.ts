import { useQuery } from '@tanstack/react-query'

import { fetchPeriodHistory } from '../api/accounting.api'

/**
 * ÄR RÄKENSKAPSÅRET STÄNGT FÖR DET HÄR BETALNINGSDATUMET?
 *
 * ── ÅTERANVÄNDER EN BEFINTLIG ENDPOINT, BYGGER INGEN NY ─────────────────────
 *
 * `/accounting/periods/:år/:månad/history` svarar redan med `fiscalYearClosed`
 * och `fiscalYearLabel` (det som `PeriodDetail` bär), och ligger under samma
 * rollgrind som betalningsdialogerna redan passerar (ACCOUNTANT och uppåt på
 * klassnivå). En egen endpoint hade varit en andra sanning om samma fråga.
 *
 * ── BARA ÅRET, ALDRIG MÅNADEN ───────────────────────────────────────────────
 *
 * Svaret bär också månadens tillstånd, och det används med flit INTE här. En
 * stängd månad i ett öppet år har en spårad återöppningsväg och ska avvisas av
 * servern med sitt eget meddelande — att erbjuda en flytt förbi den hade
 * kringgått ett medvetet mänskligt beslut. Dialogen frågar alltså en smalare
 * fråga än endpointen kan svara på, och det är avsiktligt.
 *
 * ── TOMT DATUM FRÅGAR INTE ──────────────────────────────────────────────────
 *
 * `enabled` är falskt utan ett giltigt datum. Utan det hade varje tomt
 * datumfält blivit ett anrop på `NaN/NaN`.
 */
export interface SenBokforingsLage {
  /** Sant bara när RÄKENSKAPSÅRET är stängt för det valda datumet. */
  aretStangt: boolean
  /** `2025` eller `2025/2026` — för texten i blocket. */
  arsetikett: string
}

/** `2026-03-15` → `{ ar: 2026, manad: 3 }`, eller null om datumet inte duger. */
export function delaDatum(iso: string | undefined): { ar: number; manad: number } | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return null
  const ar = Number(m[1])
  const manad = Number(m[2])
  if (!Number.isFinite(ar) || manad < 1 || manad > 12) return null
  return { ar, manad }
}

export function useSenBokforingsLage(betalningsdatum: string | undefined): SenBokforingsLage {
  const delar = delaDatum(betalningsdatum)
  const q = useQuery({
    // Nyckeln bär år OCH månad — två datum i olika månader är två frågor, och
    // en nyckel utan månaden hade återanvänt fel svar (React Query-regeln om
    // disjunkta nycklar).
    queryKey: ['accounting', 'period-history', delar?.ar, delar?.manad],
    queryFn: () => fetchPeriodHistory(delar!.ar, delar!.manad),
    enabled: delar !== null,
    staleTime: 60_000,
  })

  return {
    aretStangt: q.data?.fiscalYearClosed === true,
    arsetikett: q.data?.fiscalYearLabel ?? String(delar?.ar ?? ''),
  }
}
