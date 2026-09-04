import { ConfigService } from '@nestjs/config'
import { PublicConfigController } from './public-config.controller'

/**
 * FLAGGAN LÄSES PÅ TVÅ STÄLLEN — och de två måste svara likadant.
 *
 * `bankIdProviderFactory` avgör om ytan är inert; den här endpointen avgör om
 * knappen visas. Skulle de tolka `BANKID_ENABLED` olika uppstår exakt det fel
 * endpointen finns för att förhindra: en knapp som leder till 503. Därför prövas
 * strikt likhet med 'true' här, med samma värdemängd som modulspecen använder.
 *
 * VAD PROVET INTE KAN SE: att frontend faktiskt läser svaret. Det ägs av
 * `bankid-flow.spec.ts` och av E2E.
 */
function svar(varde: string | undefined) {
  const config = {
    get: (key: string) => (key === 'BANKID_ENABLED' ? varde : undefined),
  } as unknown as ConfigService
  return new PublicConfigController(config).get()
}

describe('GET /public/config', () => {
  it("bara exakt 'true' tänder flaggan", () => {
    expect(svar('true').features.bankId).toBe(true)
  })

  it('allt annat är av — fail-closed, samma regel som factoryn', () => {
    for (const varde of ['TRUE', 'True', '1', 'yes', 'false', '', undefined]) {
      expect(svar(varde).features.bankId).toBe(false)
    }
  })

  it('svaret bär BARA booleaner — inga värden, URL:er eller miljönamn', () => {
    // Endpointen är @Public. Ett fält som råkar bära ett konfigurationsvärde vore
    // en läcka till vem som helst, och den sortens fält smyger in när någon
    // lägger till "bara ett till". Formen kontrolleras därför, inte bara värdet.
    const features = svar('true').features as unknown as Record<string, unknown>
    expect(Object.values(features).every((v) => typeof v === 'boolean')).toBe(true)
  })
})
