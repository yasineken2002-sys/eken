import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth.store'
import { fetchLedgerOwner } from '@/features/accounting/api/accounting.api'

/**
 * MENY-ETAPP 4 (201): organisationens huvudboksval som TRE lägen, aldrig två.
 *
 * Källan är serverns beständiga val (`GET /accounting/ledger-owner`), inte
 * Fortnox-anslutningen eller kundaktiveringens status. FORTNOX och EVENO gäller
 * bara när frågan har lyckats och svaret är exakt det värdet. Laddning, nekande,
 * fel och okända värden blir OKAND — ett oläst val är inte en verifierad EVENO,
 * och inte heller en verifierad Fortnox-vy.
 */
export type Huvudbokslage = 'FORTNOX' | 'EVENO' | 'OKAND'

// Spegel av AccountingControllers klassroller. VIEWER nekas av servern; att fråga
// ändå gav ett 403 per sidladdning (PRE-202 P202-1). Inte en behörighetsregel här.
const LASROLLER = new Set(['ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER'])

export function useHuvudbokslage(): Huvudbokslage {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  // Nyckeln bär org och användare: cachen töms inte vid byte, och ett annat
  // företags val får aldrig styra menyn. Prefixet ['accounting','ledger-owner']
  // gör att den befintliga invalideringen efter ett huvudboksval når hit.
  const query = useQuery({
    queryKey: ['accounting', 'ledger-owner', org?.id ?? '-', user?.id ?? '-'],
    queryFn: fetchLedgerOwner,
    enabled: Boolean(org && user && LASROLLER.has(user.role)),
    retry: false,
    // Nekandet hanteras här (som OKAND); den globala 403-toasten ska inte visas.
    meta: { handlesOwnError: true },
  })
  if (!query.isSuccess) return 'OKAND'
  const agare = (query.data as { agare?: unknown } | undefined)?.agare
  return agare === 'FORTNOX' || agare === 'EVENO' ? agare : 'OKAND'
}
