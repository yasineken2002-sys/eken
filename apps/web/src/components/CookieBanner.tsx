import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cookie } from 'lucide-react'

const STORAGE_KEY = 'eveno-cookies-consent'

type Consent = 'accepted' | 'necessary-only'

interface Props {
  onNavigate?: (route: 'privacy') => void
}

export function CookieBanner({ onNavigate }: Props) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const consent = localStorage.getItem(STORAGE_KEY)
    if (!consent) setVisible(true)
  }, [])

  const accept = (value: Consent) => {
    localStorage.setItem(STORAGE_KEY, value)
    localStorage.setItem(`${STORAGE_KEY}-at`, new Date().toISOString())
    setVisible(false)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="dialog"
          aria-label="Cookies"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-2xl border border-[#EAEDF0] bg-white p-5 shadow-xl"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
              <Cookie className="h-5 w-5 text-blue-600" strokeWidth={1.8} />
            </div>
            <div className="flex-1">
              <p className="text-[14px] font-semibold text-gray-900">Vi värnar om din integritet</p>
              <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
                Eveno använder cookies som krävs för inloggning och säkerhet. Vi använder inte
                tredjepartscookies för marknadsföring eller spårning. Genom att fortsätta godkänner
                du nödvändiga cookies.
                {onNavigate && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => onNavigate('privacy')}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      Läs vår integritetspolicy
                    </button>
                  </>
                )}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => accept('accepted')}
                  className="h-9 rounded-lg bg-blue-600 px-4 text-[13.5px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 active:scale-[0.97]"
                >
                  Godkänn
                </button>
                <button
                  type="button"
                  onClick={() => accept('necessary-only')}
                  className="h-9 rounded-lg border border-[#DDDFE4] bg-white px-4 text-[13.5px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  Endast nödvändiga
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
