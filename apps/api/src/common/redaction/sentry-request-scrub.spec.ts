/**
 * ETT HELT SENTRY-EVENT GENOM SKRUBBEN — inte en kontroll av att nyckeln
 * står i listan.
 *
 * ── SKILLNADEN, OCH VARFÖR DEN ÄR HELA PROVET ───────────────────────────────
 *
 * `expect(SENSITIVE_FIELD_NAMES.has('newPassword')).toBe(true)` mäter en LISTA.
 * Den är grön även om `deepScrub` slutat anropas på `event.request`, om
 * `skrubbaEvent` bytt fält, eller om Sentry-integrationen aldrig kör funktionen.
 * Listan är ett påstående; eventet är en mätning.
 *
 * Provet matar därför ett event av samma form som en riktig 5xx på
 * `POST /auth/change-password` och kräver att lösenorden är BORTA efteråt.
 *
 * ── VAD SOM SAKNADES ────────────────────────────────────────────────────────
 *
 * Listan hade `passwordHash` men inte `password`, `newPassword`,
 * `currentPassword` eller `chooseToken`. Hashen — den ofarliga — togs bort medan
 * råvärdet passerade.
 *
 * redact-copy-allow: provet MATAR IN fältnamnen som data — det är hela
 * mätningen. Namnen står här som nycklar i en request-kropp, inte som en andra
 * definition av vilka fält som är hemliga; den definitionen bor kvar i
 * SENSITIVE_FIELD_NAMES och importeras.
 */
import { skrubbaEvent } from '../../instrument'
import { SENSITIVE_FIELD_NAMES } from './redact-sensitive'

type Event = Parameters<typeof skrubbaEvent>[0]

const eventMedKropp = (body: Record<string, unknown>): Event =>
  ({
    request: {
      url: 'https://api.exempel.se/v1/auth/change-password',
      method: 'POST',
      data: body,
    },
    tags: { path: '/v1/auth/change-password', method: 'POST' },
  }) as unknown as Event

const somText = (e: Event): string => JSON.stringify(e)

describe('Sentry-eventets request-kropp skrubbas', () => {
  it('DEN AVGÖRANDE: newPassword är borta ur ett helt event', () => {
    const HEMLIGT = 'Superhemligt123!'
    const ut = skrubbaEvent(eventMedKropp({ currentPassword: 'Gammalt1!', newPassword: HEMLIGT }))
    expect(somText(ut)).not.toContain(HEMLIGT)
    expect(somText(ut)).not.toContain('Gammalt1!')
  })

  it('råt password och BankID:s chooseToken är också borta', () => {
    const LOSEN = 'Losenord123!'
    const TOKEN = 'valj-konto-token-abc'
    const ut = skrubbaEvent(
      eventMedKropp({ email: 'anna@foretag.se', password: LOSEN, chooseToken: TOKEN }),
    )
    const text = somText(ut)
    expect(text).not.toContain(LOSEN)
    expect(text).not.toContain(TOKEN)
  })

  /**
   * MOTPROV. Ett skrubbningslager som tömmer allt är lika obrukbart som ett som
   * inte tömmer något — felmeddelanden slutar gå att felsöka, och då stänger
   * någon av det. Icke-hemliga fält ska överleva.
   */
  it('MOTPROV: icke-hemliga fält står kvar', () => {
    const ut = skrubbaEvent(eventMedKropp({ organizationName: 'Test AB', accountType: 'COMPANY' }))
    const text = somText(ut)
    expect(text).toContain('Test AB')
    expect(text).toContain('COMPANY')
    expect(text).toContain('/v1/auth/change-password')
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET.
   *
   * Proven ovan är gröna om `somText` inte hittar strängen. De vore också gröna
   * om `skrubbaEvent` returnerade ett tomt objekt, eller om eventet aldrig bar
   * fälten. Den här kräver att sonden kan ge motsatt utfall: samma event UTAN
   * skrubb bär hemligheten.
   */
  it('KANARIEFÅGEL: hemligheten finns i eventet INNAN skrubben', () => {
    const HEMLIGT = 'Superhemligt123!'
    const fore = eventMedKropp({ newPassword: HEMLIGT })
    expect(somText(fore)).toContain(HEMLIGT)
    expect(somText(skrubbaEvent(fore))).not.toContain(HEMLIGT)
  })

  it('KANARIEFÅGEL: listan bär de fyra — men det är eventet ovan som mäter', () => {
    for (const n of ['password', 'newPassword', 'currentPassword', 'chooseToken']) {
      expect(SENSITIVE_FIELD_NAMES.has(n)).toBe(true)
    }
  })
})
