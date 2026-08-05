/**
 * Revision i /v1/health.
 *
 * Deploy-workflowen bygger bara SPA:erna; API:t deployas av Railways
 * git-integration. Ett grönt Deploy-jobb bevisar därför inte att en API-ändring
 * nått produktion — och health visade bara ATT deployen var frisk, aldrig VILKEN
 * kod som kördes. Testerna hävdar tre saker: att revisionen kommer med, att
 * hälsokontrollens egen struktur är orörd, och att INGET ANNAT än revisionen
 * läcker ut på en publik endpoint.
 */

import { HealthController, buildRevision } from './health.controller'

const OK_RESULT = {
  status: 'ok' as const,
  info: { database: { status: 'up' as const } },
  error: {},
  details: { database: { status: 'up' as const } },
}

function makeController(check = jest.fn().mockResolvedValue(OK_RESULT)) {
  const health = { check }
  const prismaHealth = { isHealthy: jest.fn() }
  return {
    controller: new HealthController(health as never, prismaHealth as never),
    check,
  }
}

describe('buildRevision', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('läser Railways automatiska variabel', () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = '9c73e7878280d9487679ea09e81ed44d31ee16b3'
    delete process.env['GIT_COMMIT_SHA']
    expect(buildRevision()).toBe('9c73e7878280d9487679ea09e81ed44d31ee16b3')
  })

  it('Railways variabel VINNER över den manuella — prod ska visa vad som faktiskt deployades', () => {
    // DISKRIMINERANDE: båda satta, med olika värden. En implementation med
    // omvänd ordning ser rätt ut i de två testerna ovan och fel här.
    process.env['RAILWAY_GIT_COMMIT_SHA'] = 'railway-sha'
    process.env['GIT_COMMIT_SHA'] = 'manuell-sha'
    expect(buildRevision()).toBe('railway-sha')
  })

  it('faller tillbaka på GIT_COMMIT_SHA — samma konvention som instrument.ts', () => {
    delete process.env['RAILWAY_GIT_COMMIT_SHA']
    process.env['GIT_COMMIT_SHA'] = 'manuell-sha'
    expect(buildRevision()).toBe('manuell-sha')
  })

  it.each([
    ['tomma strängar', '', ''],
    ['bara blanksteg', '   ', '\t'],
  ])('SATT men %s räknas som frånvarande → unknown', (_namn, railway, manuell) => {
    // `??` faller bara tillbaka på null/undefined. En variabel som är satt men
    // tom hade gett `revision: ""` — exakt det osynliga värde fallbacken finns
    // för att undvika. Hittades genom att köra igång servern med tomma
    // variabler; `delete` i testerna nedan kunde per konstruktion inte se det.
    process.env['RAILWAY_GIT_COMMIT_SHA'] = railway
    process.env['GIT_COMMIT_SHA'] = manuell
    expect(buildRevision()).toBe('unknown')
  })

  it('tom Railway-variabel faller igenom till en SATT manuell', () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = ''
    process.env['GIT_COMMIT_SHA'] = 'manuell-sha'
    expect(buildRevision()).toBe('manuell-sha')
  })

  it("saknas båda → 'unknown', inte tomt och inte något som låtsas vara ett känt läge", () => {
    delete process.env['RAILWAY_GIT_COMMIT_SHA']
    delete process.env['GIT_COMMIT_SHA']
    const revision = buildRevision()
    expect(revision).toBe('unknown')
    // Fallbacken är också DETEKTORN: den måste vara synligt fel i ett svar man
    // ögnar igenom, annars fyller den ingen funktion.
    expect(revision).not.toBe('')
    expect(revision).not.toBeNull()
  })
})

describe('HealthController.check', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('lägger till revisionen utan att röra hälsokontrollens struktur', async () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = 'abc123'
    const { controller } = makeController()

    const result = await controller.check()

    // Befintlig struktur BIT-IDENTISK — det är spärren mot att ett tillägg
    // råkar bli en omskrivning.
    expect(result.status).toBe('ok')
    expect(result.info).toEqual(OK_RESULT.info)
    expect(result.error).toEqual(OK_RESULT.error)
    expect(result.details).toEqual(OK_RESULT.details)
    expect(result.revision).toBe('abc123')
  })

  it('svaret innehåller EXAKT ett nytt fält — inget mer läcker på en publik endpoint', async () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = 'abc123'
    const { controller } = makeController()

    const result = await controller.check()

    expect(Object.keys(result).sort()).toEqual(['details', 'error', 'info', 'revision', 'status'])
  })

  it('läcker inga andra RAILWAY_-variabler', async () => {
    // Endpointen är @Public. Miljönamn, domäner och tjänste-id:n finns i
    // runtime-miljön och får inte följa med ut.
    process.env['RAILWAY_GIT_COMMIT_SHA'] = 'abc123'
    process.env['RAILWAY_ENVIRONMENT_NAME'] = 'production'
    process.env['RAILWAY_PRIVATE_DOMAIN'] = 'eken.railway.internal'
    process.env['RAILWAY_PROJECT_ID'] = 'be53f383-hemligt'
    process.env['RAILWAY_SERVICE_ID'] = 'service-hemligt'
    const { controller } = makeController()

    const serialised = JSON.stringify(await controller.check())

    expect(serialised).toContain('abc123')
    for (const leak of ['production', 'railway.internal', 'be53f383-hemligt', 'service-hemligt']) {
      expect(serialised).not.toContain(leak)
    }
  })

  it('databas-indikatorn körs fortfarande — revisionen ersätter ingen kontroll', async () => {
    const { controller, check } = makeController()
    await controller.check()
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0]![0]).toHaveLength(1) // exakt en indikator: database
  })

  it('en FALLERAD hälsokontroll propagerar — revisionen får aldrig maskera ett fel', async () => {
    // Railway grindar på svarskoden (healthcheckPath i railway.toml). Skulle
    // tillägget svälja felet och returnera 200 med en revision skulle en trasig
    // tjänst se frisk ut — värre än att sakna revisionen.
    const failing = jest.fn().mockRejectedValue(new Error('database down'))
    const { controller } = makeController(failing)

    await expect(controller.check()).rejects.toThrow('database down')
  })
})
