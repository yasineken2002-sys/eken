import { ordnaKedja, gallandeVersion, arSlutford } from './inspection-versions'
import type { VersionsRad } from './inspection-versions'

/**
 * HÄRLEDNINGEN AV "VILKEN VERSION GÄLLER", PRÖVAD FÖR SIG.
 *
 * Regeln bor i en ren funktion just för att den ska gå att pröva utan databas,
 * utan lås och utan fixtur. Det som prövas här är BESLUTET; att rätt rader når
 * fram till beslutet prövas i `inspection-correction.db.spec.ts` mot riktig
 * Postgres.
 *
 * Provet kan alltså inte se: om tjänsten hämtar fel kedja, om org-scopet
 * saknas i någon av frågorna, eller om två samtidiga rättelser skapar en gaffel
 * i data. Alla tre ligger i DB-provet.
 */

let löpnummer = 0
function rad(över: Partial<VersionsRad> = {}): VersionsRad {
  löpnummer++
  return {
    id: `insp-${löpnummer}`,
    version: 1,
    status: 'COMPLETED',
    signedAt: null,
    completedAt: new Date('2026-03-02T10:00:00Z'),
    correctionOfId: null,
    correctionReason: null,
    correctedById: null,
    correctedAt: null,
    createdAt: new Date('2026-03-02T09:00:00Z'),
    ...över,
  }
}

describe('arSlutford — tre villkor, inte ett', () => {
  it('COMPLETED räknas som slutfört', () => {
    expect(arSlutford({ status: 'COMPLETED', signedAt: null })).toBe(true)
  })

  it('SIGNED räknas som slutfört', () => {
    expect(arSlutford({ status: 'SIGNED', signedAt: null })).toBe(true)
  })

  it('en signedAt UTAN SIGNED-status räknas också — de kan gå isär i gamla rader', () => {
    expect(arSlutford({ status: 'IN_PROGRESS', signedAt: new Date() })).toBe(true)
  })

  it('SCHEDULED och IN_PROGRESS utan signatur är inte slutförda', () => {
    expect(arSlutford({ status: 'SCHEDULED', signedAt: null })).toBe(false)
    expect(arSlutford({ status: 'IN_PROGRESS', signedAt: null })).toBe(false)
  })
})

describe('ordnaKedja', () => {
  it('sorterar på version och inte på inläsningsordning', () => {
    const v1 = rad({ version: 1 })
    const v2 = rad({ version: 2, correctionOfId: v1.id })
    const v3 = rad({ version: 3, correctionOfId: v2.id })
    // Tjänsten vandrar bakåt först och framåt sedan — ordningen ur den
    // vandringen är alltså INTE versionsordning.
    expect(ordnaKedja([v2, v1, v3]).map((v) => v.version)).toEqual([1, 2, 3])
  })

  it('ETT UTKAST GÄLLER ALDRIG — originalet behåller rollen', () => {
    const v1 = rad({ version: 1, status: 'SIGNED', signedAt: new Date() })
    const v2 = rad({ version: 2, status: 'IN_PROGRESS', completedAt: null })
    const kedja = ordnaKedja([v1, v2])
    expect(kedja.map((v) => v.arGallande)).toEqual([true, false])
    expect(kedja.map((v) => v.arUtkast)).toEqual([false, true])
  })

  it('när ersättaren slutförts flyttas rollen — och bara då', () => {
    const v1 = rad({ version: 1, status: 'SIGNED', signedAt: new Date() })
    const v2 = rad({ version: 2, status: 'SIGNED', signedAt: new Date() })
    expect(ordnaKedja([v1, v2]).map((v) => v.arGallande)).toEqual([false, true])
  })

  it('EXAKT EN gällande även när flera versioner är slutförda', () => {
    const kedja = ordnaKedja([
      rad({ version: 1, status: 'SIGNED', signedAt: new Date() }),
      rad({ version: 2, status: 'COMPLETED' }),
      rad({ version: 3, status: 'SIGNED', signedAt: new Date() }),
    ])
    expect(kedja.filter((v) => v.arGallande)).toHaveLength(1)
    expect(kedja.find((v) => v.arGallande)!.version).toBe(3)
  })

  it('ett mellanliggande utkast gör inte en ÄLDRE slutförd version gällande igen', () => {
    // v3 är utkast; gällande ska vara v2, inte v1.
    const kedja = ordnaKedja([
      rad({ version: 1, status: 'SIGNED', signedAt: new Date() }),
      rad({ version: 2, status: 'SIGNED', signedAt: new Date() }),
      rad({ version: 3, status: 'IN_PROGRESS', completedAt: null }),
    ])
    expect(kedja.find((v) => v.arGallande)!.version).toBe(2)
  })
})

describe('gallandeVersion', () => {
  it('NULL när ingen version är slutförd — inte första raden som tröstpris', () => {
    const kedja = [
      rad({ version: 1, status: 'SCHEDULED', completedAt: null }),
      rad({ version: 2, status: 'IN_PROGRESS', completedAt: null }),
    ]
    expect(gallandeVersion(kedja)).toBeNull()
  })

  it('en ensam slutförd rad är sin egen gällande version', () => {
    const v1 = rad({ version: 1, status: 'COMPLETED' })
    expect(gallandeVersion([v1])!.id).toBe(v1.id)
  })

  it('en tom kedja ger null och kastar inte', () => {
    expect(gallandeVersion([])).toBeNull()
  })
})
