import { create } from 'zustand'
import type { RelatedEntityType } from '@/features/notifications/api/notifications.api'

// Cross-page deep-link signal. NotificationBell sätter en target när användaren
// klickar en notifikation; mottagarsidan (t.ex. MaintenancePage) läser det i
// useEffect, öppnar rätt detalj, och anropar `clear()`.
export interface FocusTarget {
  type: RelatedEntityType
  id: string
}

interface FocusState {
  target: FocusTarget | null
  request: (target: FocusTarget) => void
  clear: () => void
}

export const useFocusStore = create<FocusState>((set) => ({
  target: null,
  request: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
