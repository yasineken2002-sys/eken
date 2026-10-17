import { useEffect, useId, useRef, useState } from 'react'
import styles from './InstallPortal.module.css'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>
  userChoice: Promise<unknown>
}

function isInstallPrompt(event: Event): event is InstallPromptEvent {
  return (
    'prompt' in event &&
    typeof event.prompt === 'function' &&
    'userChoice' in event &&
    typeof event.userChoice === 'object' &&
    event.userChoice !== null &&
    'then' in event.userChoice &&
    typeof event.userChoice.then === 'function'
  )
}

function isStandalone() {
  return (
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    ('standalone' in navigator && navigator.standalone === true)
  )
}

export function InstallPortal() {
  const headingId = useId()
  const [standalone, setStandalone] = useState(isStandalone)
  const [installed, setInstalled] = useState(false)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const offered = useRef<InstallPromptEvent | null>(null)
  const mounted = useRef(false)
  const busy = useRef(false)
  const confirmed = useRef(false)
  const attempt = useRef(0)

  useEffect(() => {
    mounted.current = true
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)')
        : undefined
    const discardPrompt = () => {
      attempt.current += 1
      offered.current = null
      busy.current = false
      setReady(false)
      setPending(false)
      setFeedback('')
    }
    const updateDisplayMode = () => {
      const active = isStandalone()
      setStandalone(active)
      if (active) discardPrompt()
    }
    const offer = (event: Event) => {
      if (!isInstallPrompt(event) || confirmed.current || isStandalone()) return
      event.preventDefault()
      if (busy.current) return
      offered.current = event
      setReady(true)
      setFeedback('')
    }
    const installedNow = () => {
      confirmed.current = true
      discardPrompt()
      setInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', offer)
    window.addEventListener('appinstalled', installedNow)
    media?.addEventListener?.('change', updateDisplayMode)
    updateDisplayMode()
    return () => {
      mounted.current = false
      attempt.current += 1
      offered.current = null
      busy.current = false
      window.removeEventListener('beforeinstallprompt', offer)
      window.removeEventListener('appinstalled', installedNow)
      media?.removeEventListener?.('change', updateDisplayMode)
    }
  }, [])

  async function install() {
    const event = offered.current
    if (!event || busy.current || confirmed.current || isStandalone()) return
    // Browserns erbjudande får användas en gång och bara från detta klick.
    offered.current = null
    busy.current = true
    const id = ++attempt.current
    setReady(false)
    setPending(true)
    setFeedback('')
    const current = () => mounted.current && attempt.current === id
    // Hantera även en avvisad userChoice medan prompt() fortfarande väntar.
    const choice = Promise.resolve(event.userChoice).catch(() => null)
    try {
      await event.prompt()
      const answer = await choice
      if (!current()) return
      if (typeof answer !== 'object' || answer === null || !('outcome' in answer)) {
        throw new Error('Installationsval saknas')
      }
      if (answer.outcome === 'dismissed') {
        setFeedback('Installationen avbröts. Du kan fortsätta använda portalen här.')
      } else if (answer.outcome === 'accepted') {
        // Ett accepterat erbjudande är inte bevis på slutförd installation.
        setFeedback('Webbläsaren hanterar installationen. Du kan fortsätta använda portalen här.')
      } else {
        throw new Error('Installationsval saknas')
      }
    } catch {
      if (current()) {
        setFeedback('Installationsdialogen kunde inte öppnas. Se instruktionerna nedan.')
      }
    } finally {
      if (current()) {
        busy.current = false
        setPending(false)
      }
    }
  }

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.title}>
        Portalen på din enhet
      </h2>
      <p className={styles.description}>
        Lägg till Eveno för att hitta hit enkelt. Du behöver internetanslutning för att visa dina
        uppgifter och skicka ärenden.
      </p>
      <p role="status" className={styles.status}>
        {standalone
          ? 'Portalen är öppnad som app.'
          : installed
            ? 'Webbläsaren har bekräftat att portalen har installerats.'
            : feedback}
      </p>
      {!standalone && !installed && (
        <>
          {(ready || pending) && (
            <button type="button" className={styles.install} disabled={pending} onClick={install}>
              {pending ? 'Väntar på webbläsaren…' : 'Installera portalen'}
            </button>
          )}
          <details className={styles.help}>
            <summary>Så lägger du till portalen</summary>
            <p>
              Öppna webbläsarens meny eller delningsmeny. Välj ”Installera app” eller ”Lägg till på
              hemskärmen” om valet finns.
            </p>
            <p>
              På iPhone eller iPad kan du öppna portalen i Safari och välja Dela → Lägg till på
              hemskärmen. Om valet saknas kan du fortsätta använda portalen i webbläsaren.
            </p>
          </details>
        </>
      )}
    </section>
  )
}
