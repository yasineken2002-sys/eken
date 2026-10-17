export type PortalNetworkErrorKind = 'offline' | 'unconfirmed'

/** Säker felgräns: innehåller aldrig URL, nyttolast, token eller transportens råfel. */
export class PortalNetworkError extends Error {
  constructor(readonly kind: PortalNetworkErrorKind) {
    super(
      kind === 'offline'
        ? 'Du är offline. Kontrollera din internetanslutning och försök igen.'
        : 'Svaret från servern kunde inte bekräftas. Kontrollera uppkopplingen och resultatet innan du försöker igen.',
    )
    this.name = 'PortalNetworkError'
  }
}

// true/okänt är ingen garanti för att API:t kan nås. Transportens utfall avgör.
export function isPortalOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}
