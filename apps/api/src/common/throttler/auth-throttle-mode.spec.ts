/**
 * BRUTE FORCE-SKYDDET SKA INTE GÅ ATT STÄNGA AV I PRODUKTION.
 *
 * `POST /auth/{register,login,accept-invite}` är strypta för att bromsa brute
 * force mot inloggning och kontoaktivering. E2E-sviten behöver gå runt det —
 * åtta specar gör ~18 auth-anrop och slår i taket — men uppmjukningen får aldrig
 * kunna gälla skarpt.
 *
 * Testet är skrivet mot den frågan, inte mot implementationen: **vad händer om
 * någon sätter testkonfigurationen i produktion?** Svaret ska vara "ingenting,
 * den vägrar starta", och det är vad som verifieras här — på båda lagren:
 * `authThrottleRelaxed` (som guardens konstruktor anropar) och `validateEnv`
 * (som körs vid boot, före första requesten).
 *
 * Fail-closed-riktningen testas explicit: allt utom exakt 'true' ska ge STRIKT.
 * Ett skydd som mjukas upp av 'TRUE', '1' eller 'yes' är ett skydd som slarv kan
 * stänga av.
 */

import {
  authThrottleRelaxed,
  E2E_AUTH_THROTTLE_FLAG,
  ProductionThrottleRelaxationError,
} from './auth-throttle-mode'
import { validateEnv } from '../../config/env.validation'

/** Minimal env som tar sig förbi validateEnvs övriga krav i icke-prod. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...extra } as NodeJS.ProcessEnv
}

describe('authThrottleRelaxed — fail-closed', () => {
  it.each([
    ['variabeln saknas helt', {}],
    ['tom sträng', { [E2E_AUTH_THROTTLE_FLAG]: '' }],
    ['versaler', { [E2E_AUTH_THROTTLE_FLAG]: 'TRUE' }],
    ['ettan', { [E2E_AUTH_THROTTLE_FLAG]: '1' }],
    ['yes', { [E2E_AUTH_THROTTLE_FLAG]: 'yes' }],
    ['skräpvärde', { [E2E_AUTH_THROTTLE_FLAG]: 'kanske' }],
    ['ordet false', { [E2E_AUTH_THROTTLE_FLAG]: 'false' }],
  ])('ger STRIKT när flaggan är %s', (_namn, extra) => {
    // Saknad eller okänd konfiguration → strikta defaults. Aldrig tvärtom.
    expect(authThrottleRelaxed(env({ NODE_ENV: 'test', ...extra }))).toBe(false)
  })

  it('mjukar upp endast vid exakt "true" utanför produktion', () => {
    expect(authThrottleRelaxed(env({ NODE_ENV: 'test', [E2E_AUTH_THROTTLE_FLAG]: 'true' }))).toBe(
      true,
    )
    expect(
      authThrottleRelaxed(env({ NODE_ENV: 'development', [E2E_AUTH_THROTTLE_FLAG]: 'true' })),
    ).toBe(true)
  })

  it('KASTAR när uppmjukning begärs i produktion', () => {
    expect(() =>
      authThrottleRelaxed(env({ NODE_ENV: 'production', [E2E_AUTH_THROTTLE_FLAG]: 'true' })),
    ).toThrow(ProductionThrottleRelaxationError)
  })

  it('lämnar produktion orörd när flaggan inte är satt', () => {
    // Kontrollen får inte bli en broms på normal produktionsstart.
    expect(authThrottleRelaxed(env({ NODE_ENV: 'production' }))).toBe(false)
  })
})

describe('validateEnv — produktionsläget går inte att lösa upp', () => {
  /**
   * Den bärande kontrollen. Guardens konstruktor kastar också, men den körs
   * först när Nest instansierar guarden; `validateEnv` körs innan dess. Faller
   * den här är appen död före första requesten, vilket är hela poängen.
   */
  it('vägrar starta i produktion med uppmjukningen satt', () => {
    expect(() => validateEnv({ NODE_ENV: 'production', [E2E_AUTH_THROTTLE_FLAG]: 'true' })).toThrow(
      /E2E_RELAX_AUTH_THROTTLE=true.*NODE_ENV=production/s,
    )
  })

  it('felet nämner brute force-skyddet, inte bara variabelnamnet', () => {
    // Ett fail-fast som bara säger "ogiltig konfiguration" får någon att sätta
    // variabeln igen på ett annat sätt. Meddelandet ska säga VAD som står på spel.
    let meddelande = ''
    try {
      validateEnv({ NODE_ENV: 'production', [E2E_AUTH_THROTTLE_FLAG]: 'true' })
    } catch (err) {
      meddelande = err instanceof Error ? err.message : String(err)
    }
    expect(meddelande).toMatch(/brute force/i)
  })

  it('blockerar INTE i test/dev med uppmjukningen satt', () => {
    // Utan detta hade PR:en gjort E2E-läget omöjligt att använda — och därmed
    // hela ändringen meningslös.
    expect(() => validateEnv({ NODE_ENV: 'test', [E2E_AUTH_THROTTLE_FLAG]: 'true' })).not.toThrow()
  })
})
