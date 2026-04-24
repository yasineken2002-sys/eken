import { useEffect, useState } from 'react'
import { ShieldAlert, LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { getImpersonation } from '@/lib/impersonation'
import { post } from '@/lib/api'

/**
 * Sticky banner längst upp i appen — syns BARA när token är impersonerad
 * (JWT har `impersonatedBy`). Vanliga users ser ingenting.
 */
export function ImpersonationBanner() {
  const [impersonation, setImpersonation] = useState(() => getImpersonation())
  const user = useAuthStore((s) => s.user)
  const organization = useAuthStore((s) => s.organization)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const accessToken = useAuthStore((s) => s.accessToken)

  // Synka om access-token byts ut under sessionen (t.ex. vid logout/login).
  useEffect(() => {
    setImpersonation(getImpersonation())
  }, [accessToken])

  if (!impersonation) return null

  async function endSession() {
    try {
      await post(`/platform/impersonate/end`, {
        logId: impersonation?.logId,
      })
    } catch {
      // ignore — impersonation-tokenet tillhör org-user, inte platform-user,
      // så end-endpointen kommer 401:a. Det är OK — vi rensar lokal state
      // ändå.
    }
    clearAuth()
    window.close()
  }

  return (
    <div className="sticky top-0 z-[60] border-b border-amber-200 bg-amber-50 text-amber-900">
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2 text-[12.5px]">
        <ShieldAlert size={14} className="shrink-0" />
        <div className="flex-1 truncate">
          <span className="font-semibold">Impersonation aktiv.</span> Du agerar som{' '}
          <span className="font-medium">{user ? `${user.firstName} ${user.lastName}` : '—'}</span> i{' '}
          <span className="font-medium">{organization?.name ?? '—'}</span>. Alla åtgärder loggas
          juridiskt.
        </div>
        <button
          onClick={endSession}
          className="flex items-center gap-1.5 rounded-lg bg-amber-900/90 px-2.5 py-1 text-[12px] font-medium text-amber-50 hover:bg-amber-900"
        >
          <LogOut size={12} /> Avsluta impersonation
        </button>
      </div>
    </div>
  )
}
