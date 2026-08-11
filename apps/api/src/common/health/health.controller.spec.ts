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

function makeController(
  check = jest.fn().mockResolvedValue(OK_RESULT),
  count: jest.Mock = jest.fn().mockResolvedValue(427),
) {
  const health = { check }
  const prismaHealth = { isHealthy: jest.fn() }
  const prisma = { legalChunkEmbedding: { count } }
  return {
    controller: new HealthController(health as never, prismaHealth as never, prisma as never),
    check,
    count,
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

    expect(Object.keys(result).sort()).toEqual([
      'details',
      'error',
      'info',
      'legalKnowledge',
      'revision',
      'status',
    ])
    // Paritetsfältet bär EXAKT tre nycklar. En publik endpoint ska inte råka
    // få med sig något mer när fältet byggs ut.
    expect(Object.keys(result.legalKnowledge).sort()).toEqual(['chunks', 'model', 'vectors'])
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

  describe('legalKnowledge — paritetsfältet (#414)', () => {
    it('bär BÅDA TALEN, inte ett omdöme', async () => {
      const { controller } = makeController(undefined, jest.fn().mockResolvedValue(427))

      const result = await controller.check()

      // '427 = 427' går att kontrollera av den som läser. 'ok' går inte — då
      // måste man lita på vår jämförelse i stället för att göra den själv.
      expect(result.legalKnowledge.vectors).toBe(427)
      expect(typeof result.legalKnowledge.chunks).toBe('number')
      expect(result.legalKnowledge.model).toBe('voyage-4')
      // Ingen flagga, inget omdöme, ingen sammanfattning.
      expect(result.legalKnowledge).not.toHaveProperty('parity')
      expect(result.legalKnowledge).not.toHaveProperty('status')
      expect(result.legalKnowledge).not.toHaveProperty('ok')
    })

    it('BRUTEN paritet syns som två olika tal — inte som ett fel', async () => {
      // Fältets hela poäng. Ett fält som aldrig setts visa fel är samma sak som
      // en vakt som aldrig setts falla.
      const { controller } = makeController(undefined, jest.fn().mockResolvedValue(420))

      const result = await controller.check()

      expect(result.legalKnowledge.vectors).toBe(420)
      expect(result.legalKnowledge.chunks).not.toBe(420)
      // Bruten paritet får INTE fälla hälsokontrollen — Railway pollar
      // endpointen och skulle starta om tjänsten. Degraderad retrieval är inte
      // skäl att ta ned API:t.
      expect(result.status).toBe('ok')
    })

    it('räknar bara den AKTIVA modellens rader', async () => {
      const count = jest.fn().mockResolvedValue(427)
      const { controller } = makeController(undefined, count)

      await controller.check()

      expect(count).toHaveBeenCalledWith({ where: { model: 'voyage-4' } })
    })

    it('DB-talet räknas per anrop — bundle-talet gör det inte', async () => {
      // Asymmetrin är avsiktlig: bundlen kan inte ändras medan processen lever,
      // databasen kan (knowledge:embed mot en levande instans, #400).
      const count = jest.fn().mockResolvedValue(427)
      const { controller } = makeController(undefined, count)

      await controller.check()
      await controller.check()
      await controller.check()

      expect(count).toHaveBeenCalledTimes(3)
    })

    it('en DB-räkning som kastar ger vectors: null — och tar ALDRIG ned endpointen', async () => {
      // null är ett faktum ('kunde inte räknas'), inte ett omdöme. Samma
      // avvägning som för revision: att veta något om korpusen får aldrig kunna
      // fälla hälsokontrollen.
      const count = jest.fn().mockRejectedValue(new Error('relation does not exist'))
      const { controller } = makeController(undefined, count)

      const result = await controller.check()

      expect(result.legalKnowledge.vectors).toBeNull()
      expect(result.status).toBe('ok')
      expect(result.revision).toBeDefined()
    })
  })
})
