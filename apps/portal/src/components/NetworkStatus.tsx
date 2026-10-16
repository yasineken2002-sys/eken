import { useSyncExternalStore } from 'react'
import { isPortalOffline } from '@/lib/network-state'
import styles from './NetworkStatus.module.css'

function subscribe(listener: () => void) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

export function NetworkStatus() {
  // Ett online-event garanterar inte att API:t går att nå. Transportens eget
  // svar avgör om en åtgärd lyckades; här visas bara browserns offlinesignal.
  const offline = useSyncExternalStore(subscribe, isPortalOffline, () => false)
  if (!offline) return null
  return (
    <aside className={styles.notice} role="status" aria-live="polite">
      <strong>Du är offline.</strong> Visade uppgifter kan vara inaktuella. Kontrollera resultatet
      av pågående åtgärder när anslutningen är tillbaka.
    </aside>
  )
}
