/** Offlinestödet är en förbättring av den byggda portalen, aldrig ett startkrav. */
export function registerPortalWorker(): void {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) {
    return
  }

  const register = async () => {
    try {
      await navigator.serviceWorker.register('/portal-sw.js', {
        scope: '/',
        updateViaCache: 'none',
      })
    } catch {
      // Ingen URL, token eller rå browserexception till logg/telemetri.
      console.warn('Portalens offlinestöd kunde inte aktiveras.')
    }
  }

  if (document.readyState === 'complete') {
    void register()
  } else {
    window.addEventListener('load', () => void register(), { once: true })
  }
}
