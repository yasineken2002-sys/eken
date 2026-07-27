jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AiAssistantService } from './ai-assistant.service'

/**
 * VILANDE-ORG-GRINDEN — kostnadsvakt för de automatiska AI-jobben.
 *
 * Bakgrund: weekly-summary-cronen itererar ALLA organisationer och gör ett
 * modellanrop per org. I dev fanns 224 orgar (nästan alla testartefakter), och
 * en enda söndagskörning kostade ~17 kr på att skriva sammanfattningar ingen
 * läser. Samma mönster i prod betyder att varje vilande konto debiteras varje
 * vecka.
 *
 * Kostnadscapet kan inte fånga detta: checkOrgDailyCostCap() mäter PER ORG, och
 * en fan-out över N tomma orgar lägger bara ören på var och en. Grinden mäter i
 * stället om orgen har något att sammanfatta ÖVER HUVUD TAGET.
 *
 * Testet driver de tre publika ingångarna och verifierar att INGET modellanrop
 * görs för en tom org — och att en org med minsta lilla data fortfarande får
 * sin rapport (grinden får inte tysta aktiva kunder).
 */

const textResponse = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'RAPPORT' }],
  usage: { input_tokens: 10, output_tokens: 5 },
}

function makeService(counts: { properties: number; leases: number; notices: number }) {
  const create = jest.fn().mockResolvedValue(textResponse)
  const checkOrgDailyCostCap = jest.fn().mockResolvedValue(undefined)

  const prisma = {
    property: { count: jest.fn().mockResolvedValue(counts.properties) },
    lease: { count: jest.fn().mockResolvedValue(counts.leases) },
    rentNotice: { count: jest.fn().mockResolvedValue(counts.notices) },
  }

  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
    { buildContext: jest.fn().mockResolvedValue('PORTFÖLJ') } as never,
    {} as never,
    {} as never,
    { logUsage: jest.fn().mockResolvedValue(undefined) } as never,
    { checkOrgDailyCostCap } as never,
    {} as never,
    {} as never,
    {} as never,
  )
  ;(service as unknown as { client: unknown }).client = { messages: { create } }

  return { service, create, checkOrgDailyCostCap, prisma }
}

/** De tre automatiska jobben som cron fan-outar över alla orgar. */
const JOBS: Array<{ namn: string; kor: (s: AiAssistantService) => Promise<string> }> = [
  { namn: 'generateDailyInsights', kor: (s) => s.generateDailyInsights('org-1') },
  { namn: 'generateWeeklySummary', kor: (s) => s.generateWeeklySummary('org-1') },
  {
    namn: 'generateMonthlyInsights',
    kor: (s) => s.generateMonthlyInsights('org-1', 'SAMMANFATTNING'),
  },
]

describe('Vilande-org-grind — tom org kostar ingenting', () => {
  for (const jobb of JOBS) {
    it(`${jobb.namn}: 0 fastigheter/0 avtal/0 avier → inget modellanrop`, async () => {
      const { service, create, checkOrgDailyCostCap } = makeService({
        properties: 0,
        leases: 0,
        notices: 0,
      })

      const resultat = await jobb.kor(service)

      expect(resultat).toBe('')
      expect(create).not.toHaveBeenCalled()
      // Grinden ska ligga FÖRE kostnadscapet — en tom org ska inte ens
      // kosta en cap-query per körning.
      expect(checkOrgDailyCostCap).not.toHaveBeenCalled()
    })
  }
})

describe('Vilande-org-grind — aktiv org påverkas inte', () => {
  // Grinden är avsiktligt bred: ETT av de tre räcker. En org mitt i onboarding
  // (fastighet inlagd, inget avtal än) måste fortfarande få sin rapport.
  const AKTIVA: Array<[string, { properties: number; leases: number; notices: number }]> = [
    ['bara fastighet (onboarding)', { properties: 1, leases: 0, notices: 0 }],
    ['bara avtal', { properties: 0, leases: 1, notices: 0 }],
    ['bara avi', { properties: 0, leases: 0, notices: 1 }],
    ['full portfölj', { properties: 12, leases: 40, notices: 480 }],
  ]

  for (const jobb of JOBS) {
    for (const [beskrivning, counts] of AKTIVA) {
      it(`${jobb.namn}: ${beskrivning} → rapport genereras`, async () => {
        const { service, create, checkOrgDailyCostCap } = makeService(counts)

        const resultat = await jobb.kor(service)

        expect(create).toHaveBeenCalledTimes(1)
        expect(checkOrgDailyCostCap).toHaveBeenCalledWith('org-1')
        expect(resultat).toBe('RAPPORT')
      })
    }
  }
})

describe('Vilande-org-grind — grinden är org-scopad', () => {
  it('räknar alltid på den org som ska rapporteras, aldrig globalt', async () => {
    const { service, prisma } = makeService({ properties: 0, leases: 0, notices: 0 })

    await service.generateWeeklySummary('org-1')

    for (const modell of [prisma.property, prisma.lease, prisma.rentNotice]) {
      expect(modell.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } })
    }
  })
})
