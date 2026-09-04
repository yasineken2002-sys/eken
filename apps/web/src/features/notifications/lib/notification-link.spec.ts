import { describe, it, expect } from 'vitest'
import { entityTypeToPath, notificationLinkToPath } from './notification-link'
import type { RelatedEntityType } from '../api/notifications.api'

/**
 * Provet som togs bort i #718 — och som togs bort DÄRFÖR ATT ingen körare fanns
 * (#719). Det är återskrivet här, utökat med djuplänksfallet från #721.
 *
 * Modulen har ett enda jobb: översätta en notis till en adress användaren kan
 * klicka på. Misslyckas den blir utfallet inte ett fel utan en TYST
 * återvändsgränd — en notis som inte går någonstans, eller värre, en som går
 * till fel sida. Båda ser ut som att allt fungerar.
 */

/**
 * Uppräkningen är ett `Record`, inte en array, MED FLIT: `RelatedEntityType` är
 * en ren typunion utan runtime-värde, så en array hade blivit en andra
 * uppräkning som tyst glider isär från unionen. Ett `Record` över unionen är
 * däremot uttömmande — läggs en typ till i api-filen slutar DEN HÄR FILEN att
 * typechecka, och den som lade till typen tvingas ta ställning här.
 */
const ALLA_TYPER: Record<RelatedEntityType, true> = {
  MAINTENANCE_TICKET: true,
  INVOICE: true,
  LEASE: true,
  TENANT: true,
  DEPOSIT: true,
  RENT_INCREASE: true,
  TERMINATION_REQUEST: true,
  AI_ASSIGNMENT: true,
  RENT_NOTICE: true,
}
const TYPER = Object.keys(ALLA_TYPER) as RelatedEntityType[]

describe('entityTypeToPath', () => {
  it('ger en absolut app-route för VARJE deklarerad entitetstyp', () => {
    // Påståendet: en strukturerad notis kan alltid navigeras. En typ utan
    // destination blir en notis utan väg vidare — #654:s återvändsgränd.
    expect(TYPER.length).toBeGreaterThan(5)
    for (const typ of TYPER) {
      const path = entityTypeToPath(typ)
      expect(path, `${typ} saknar destination`).not.toBeNull()
      expect(path, `${typ} ger en relativ sökväg`).toMatch(/^\//)
    }
  })

  it('ignorerar id:t för typer utan detaljrutt — listsidan plus focus-signalen', () => {
    // Påståendet i koden: bara typer vars rutt är registrerad i router.tsx får
    // bära id:t i URL:en. Övriga ska ge exakt samma svar med och utan id, så
    // att NotificationBell vet att den ska sätta focus i stället.
    for (const typ of TYPER.filter((t) => t !== 'RENT_NOTICE')) {
      expect(entityTypeToPath(typ, 'id-123'), `${typ} djuplänkade utan rutt`).toBe(
        entityTypeToPath(typ),
      )
    }
  })

  it('djuplänkar RENT_NOTICE till avin när ett id finns (#721)', () => {
    expect(entityTypeToPath('RENT_NOTICE', 'abc-123')).toBe('/avisering/abc-123')
  })

  it('ger listsidan för RENT_NOTICE när id saknas', () => {
    // En notis kan sakna relatedEntityId. Då är listan rätt svar — inte
    // `/avisering/undefined`, som hade träffat catch-all och landat på
    // dashboarden utan att något blev rött.
    expect(entityTypeToPath('RENT_NOTICE')).toBe('/avisering')
    expect(entityTypeToPath('RENT_NOTICE', '')).toBe('/avisering')
  })

  it('ger null för en typ som inte finns i mappningen', () => {
    // Anroparen grenar på null. Svarar funktionen med något sanningsvärt för en
    // okänd typ navigerar appen till en adress ingen registrerat.
    expect(entityTypeToPath('HITTEPÅ' as RelatedEntityType)).toBeNull()
  })
})

describe('notificationLinkToPath', () => {
  it('översätter legacy-länkens första segment till en listsida', () => {
    expect(notificationLinkToPath('maintenance/abc')).toBe('/maintenance')
    expect(notificationLinkToPath('invoices')).toBe('/invoices')
    expect(notificationLinkToPath('collections/xyz/mer')).toBe('/collections')
  })

  it('tål inledande snedstreck', () => {
    // Skrivarna i API:t är inte eniga om formen — vissa skriver `avisering/x`,
    // andra `/avisering/x`. Båda måste fungera.
    expect(notificationLinkToPath('/leases')).toBe('/leases')
    expect(notificationLinkToPath('///leases')).toBe('/leases')
  })

  it('känner segmentet "avisering" (#648)', () => {
    // Regressionen som gav ärendet dess namn: segmentet saknades, notisen föll
    // på default → null, och blev en notis utan väg vidare.
    expect(notificationLinkToPath('avisering')).toBe('/avisering')
  })

  it('behåller id:t för avisering, som har en detaljrutt (#721)', () => {
    // Skrivaren i rent-reminder.service.ts har alltid skickat `avisering/<id>`.
    // Det var den här funktionen som kastade bort andra ledet.
    expect(notificationLinkToPath('avisering/notice-1')).toBe('/avisering/notice-1')
    expect(notificationLinkToPath('/avisering/notice-1')).toBe('/avisering/notice-1')
  })

  it('kastar andra ledet för segment UTAN detaljrutt', () => {
    // Motprovet till föregående. Skulle id:t följa med här hamnar användaren på
    // en oregistrerad adress → catch-all → dashboarden, tyst och fel.
    expect(notificationLinkToPath('invoices/inv-1')).toBe('/invoices')
    expect(notificationLinkToPath('maintenance/t-1')).toBe('/maintenance')
  })

  it('ger null för okänt segment och för tom sträng', () => {
    expect(notificationLinkToPath('hittepå/1')).toBeNull()
    expect(notificationLinkToPath('')).toBeNull()
    expect(notificationLinkToPath('/')).toBeNull()
  })
})
