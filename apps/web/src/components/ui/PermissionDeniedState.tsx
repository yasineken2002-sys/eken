import { motion } from 'framer-motion'
import { Lock } from 'lucide-react'
import { useCurrentRole } from '@/hooks/useCanWrite'

interface Props {
  /** Vad användaren försökte se, i bestämd form: "bankavstämningen", "importhistoriken". */
  vad: string
}

/**
 * ETT NEKANDE SKA SE UT SOM ETT NEKANDE — inte som tomhet.
 *
 * Sidorna renderade tidigare sitt vanliga tomma tillstånd när en läsning
 * 403:ade, eftersom `const { data = [] } = useQuery(...)` gör ett fel
 * oskiljbart från "inga rader". Resultatet var ett FALSKT SAKPÅSTÅENDE om
 * organisationens data — "Inga transaktioner" när det fanns hundratals — ofta
 * med en åtgärdsknapp som själv 403:ade.
 *
 * Rollen skrivs ut. Utan den blir beskedet "du får inte" utan att säga vem man
 * är, och användaren kan varken förstå eller be om rätt sak av sin admin.
 */
export function PermissionDeniedState({ vad }: Props) {
  const role = useCurrentRole()
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-gray-100 bg-gray-50">
        <Lock size={26} strokeWidth={1.4} className="text-gray-300" />
      </div>
      <p className="text-[15px] font-semibold text-gray-800">Du har inte behörighet</p>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-gray-400">
        Din roll{role ? ` (${role})` : ''} får inte se {vad}. Kontakta en administratör i
        organisationen om du behöver åtkomst.
      </p>
    </motion.div>
  )
}
