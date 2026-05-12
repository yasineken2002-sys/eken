import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Scale, ExternalLink } from 'lucide-react'
import { CURRENT_TERMS_VERSION, LEGAL_PATHS, PLATFORM_COMPANY } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { post } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

/**
 * Visas när organisationens senast godkända termsVersion är lägre än
 * CURRENT_TERMS_VERSION. Användaren måste acceptera för att gå vidare —
 * modalen är inte stängningsbar och har ingen "senare"-knapp.
 *
 * Avlogga är enda alternativet att inte acceptera (då hamnar man på
 * login-skärmen med konton intakt — användaren kan komma tillbaka senare).
 */
export function TermsReacceptanceModal({ onAccepted }: { onAccepted: () => void }) {
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const setOrgTermsVersion = useAuthStore((s) => s.setOrgTermsVersion)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAccept = async () => {
    setIsPending(true)
    setError(null)
    try {
      await post<{ termsVersion: string }>('/auth/accept-terms', {
        version: CURRENT_TERMS_VERSION,
      })
      setOrgTermsVersion(CURRENT_TERMS_VERSION)
      onAccepted()
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Kunde inte spara acceptans. Försök igen.'
      setError(msg)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 px-4 backdrop-blur-[2px]"
      >
        <motion.div
          role="dialog"
          aria-labelledby="terms-reaccept-title"
          aria-modal="true"
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="w-full max-w-md rounded-2xl border border-[#EAEDF0] bg-white p-6 shadow-xl"
        >
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
            <Scale className="h-5 w-5 text-blue-600" strokeWidth={1.8} />
          </div>

          <h2 id="terms-reaccept-title" className="text-[17px] font-semibold text-gray-900">
            Vi har uppdaterat våra villkor
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-gray-600">
            {PLATFORM_COMPANY.brandName} har en ny version av Användarvillkor och Integritetspolicy
            (version {CURRENT_TERMS_VERSION}). Läs igenom och acceptera för att fortsätta använda
            Tjänsten.
          </p>

          <div className="mt-4 space-y-2">
            <a
              href={LEGAL_PATHS.terms}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-xl border border-[#EAEDF0] bg-white px-4 py-3 transition-colors hover:bg-gray-50"
            >
              <span className="text-[13.5px] font-medium text-gray-900">Användarvillkor</span>
              <ExternalLink className="h-3.5 w-3.5 text-gray-400" />
            </a>
            <a
              href={LEGAL_PATHS.privacy}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-xl border border-[#EAEDF0] bg-white px-4 py-3 transition-colors hover:bg-gray-50"
            >
              <span className="text-[13.5px] font-medium text-gray-900">Integritetspolicy</span>
              <ExternalLink className="h-3.5 w-3.5 text-gray-400" />
            </a>
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
              {error}
            </div>
          )}

          <div className="mt-5 flex flex-col gap-2">
            <Button
              type="button"
              variant="primary"
              loading={isPending}
              onClick={handleAccept}
              className="h-10 w-full rounded-xl text-[14px] font-semibold"
            >
              {isPending ? 'Sparar...' : 'Jag accepterar de uppdaterade villkoren'}
            </Button>
            <button
              type="button"
              onClick={clearAuth}
              className="h-9 rounded-xl text-[13px] text-gray-500 transition-colors hover:text-gray-700"
            >
              Logga ut istället
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
