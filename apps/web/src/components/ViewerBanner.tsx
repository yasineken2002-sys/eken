import { Eye } from 'lucide-react'
import { useCurrentRole } from '@/hooks/useCanWrite'

/**
 * Visas högst upp i layouten när inloggad användare är VIEWER. Tydliggör att
 * skrivoperationer kommer att blockeras (knappar är ändå dolda/disabled, men
 * vi vill att användaren förstår varför).
 */
export function ViewerBanner() {
  const role = useCurrentRole()
  if (role !== 'VIEWER') return null

  return (
    <div className="flex items-center justify-center gap-2 border-b border-blue-100 bg-blue-50 px-4 py-2 text-[12.5px] text-blue-800">
      <Eye className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
      <span>
        Du är inloggad som <strong>visa-användare</strong> och kan inte göra ändringar. Kontakta din
        administratör om du behöver utökade rättigheter.
      </span>
    </div>
  )
}
