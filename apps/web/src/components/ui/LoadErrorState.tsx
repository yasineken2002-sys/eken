import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

interface Props {
  /** Vad som inte gick att hämta, i bestämd form: "bankavstämningen", "importhistoriken". */
  vad: string
  /** Låt användaren försöka igen när det finns något att försöka med. */
  onRetry?: () => void
}

/**
 * ETT HAVERI SKA INTE SE UT SOM ETT NEKANDE.
 *
 * `PermissionDeniedState` löste att ett 403 renderades som tomhet. Men fem ytor
 * behandlade sedan VARJE fel som ett 403 (`isError: nekad`), och då blev ett 500
 * till påståendet "Din roll får inte se …" om ett rent haveri.
 *
 * Det är samma familj av falskt påstående som #442 handlar om, och det skickar
 * användaren till fel åtgärd: att be sin admin om behörighet hen redan har, i
 * stället för att rapportera ett fel. Texten här säger därför motsatsen —
 * behörigheten är inte problemet, och det finns något att försöka om.
 *
 * Skiljelinjen dras av `isForbidden(error)` i `lib/api.ts`, inte av `isError`.
 */
export function LoadErrorState({ vad, onRetry }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-100 bg-amber-50">
        <AlertTriangle size={26} strokeWidth={1.4} className="text-amber-500" />
      </div>
      <p className="text-[15px] font-semibold text-gray-800">Något gick fel</p>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-gray-400">
        {vad} kunde inte hämtas just nu. Det beror inte på din behörighet — försök igen om en stund,
        och hör av dig om det fortsätter.
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 h-9 rounded-[10px] border border-gray-200 bg-white px-4 text-[13.5px] font-medium text-gray-700 transition-all duration-150 hover:bg-gray-50 active:scale-[0.97]"
        >
          Försök igen
        </button>
      )}
    </motion.div>
  )
}
