/**
 * AGENTENS FRÅGOR — mot riktig Postgres.
 *
 * ── EN FRÅGA ÄR INTE ETT FÖRSLAG MED LÅG KONFIDENS ──────────────────────────
 *
 * Mätt före det här: skuggagenten hade TVÅ utfall, ett förslag eller
 * `INGEN_ATGARD`. Var den osäker föreslog den ändå, med lägre konfidens
 * (uppmätt spann 0,45–0,95). Den gissade — och gissningen såg ut som ett omdöme.
 *
 * ── VAD PROVEN MÄTER ────────────────────────────────────────────────────────
 *
 * Rundturen: fråga → svar → nästa förslag använder svaret. Plus frågebudgeten,
 * som är mekanisk och inte ett råd i en prompt: högst en öppen fråga per ärende,
 * och ingen fråga vars svar redan finns bekräftat.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att MODELLEN väljer frågan bara när något saknas. Det är en egenskap hos
 * språket, inte hos koden; formuleringen granskades av ai-architect och skälen
 * står i verktygsschemat. Här mäts att vägen finns och att spärrarna håller.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare. Städning i FK-riktning, prövad mot en
 * TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { FRAGEBARA_FALT, FRAGEBARA_NYCKLAR, ärGiltigFråga } from './question-fields'
import { QuestionService, svarsNyckel } from './question.service'
import { SKUGGKALLA_FELANMALAN } from '../shadow/shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const FALT = 'category'
const ALT = ['PLUMBING', 'HEATING']

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })

  it('FRÅGEBARA FÄLT ÄR HÄRLEDDA — och sedan etapp 10 är de TRE', () => {
    // ── DET HÄR PROVET SA MOTSATSEN, OCH VAR VACUÖST GRÖNT ────────────────
    //
    // Raden löd `expect(FRAGEBARA_NYCKLAR).not.toContain('assignedToId')`, med
    // motiveringen att fältet var en naken `String?` utan register. Det var
    // sant till #833. Efter bytet till `assignedContractorId` fortsatte
    // assertionen vara grön — men av att den namngav ett fält som inte längre
    // finns någonstans i mängden, alltså trivialt. En kontroll som inte kan
    // falla mäter ingenting.
    //
    // Den prövar nu det som faktiskt gäller: mängden är TRE, och den tredje är
    // DYNAMISK (organisationens hantverkare) i stället för statisk.
    expect(FRAGEBARA_NYCKLAR).toContain('category')
    expect(FRAGEBARA_NYCKLAR).toContain('priority')
    expect(FRAGEBARA_NYCKLAR).toContain('assignedContractorId')
    expect(FRAGEBARA_NYCKLAR).toHaveLength(3)
    // …och det gamla namnet finns inte kvar någonstans i mängden.
    expect(FRAGEBARA_NYCKLAR).not.toContain('assignedToId')
    // DYNAMISKT betyder TOM lista här och en mängd som följer med frågan —
    // inte "inga lagliga värden". Utan flaggan hade tomheten betytt två saker.
    const hv = FRAGEBARA_FALT.find((f) => f.nyckel === 'assignedContractorId')!
    expect(hv.dynamiskt).toBe(true)
    expect(hv.alternativ).toEqual([])
    // ALTERNATIVEN ÄR REGISTRETS, inte en lista: kategorierna är fler än en
    // handfull, och en skriven lista hade glidit vid första tillägget.
    expect(FRAGEBARA_FALT.find((f) => f.nyckel === 'category')!.alternativ.length).toBeGreaterThan(
      5,
    )
  })
})

describe('formen prövas fail-closed', () => {
  it.each([
    ['okänt fält', { fält: 'budget', alternativ: ALT, användsTill: 'x' }],
    ['ett enda alternativ', { fält: FALT, alternativ: ['PLUMBING'], användsTill: 'x' }],
    [
      'fem alternativ',
      {
        fält: FALT,
        alternativ: ['PLUMBING', 'HEATING', 'ROOF', 'LOCKS', 'FACADE'],
        användsTill: 'x',
      },
    ],
    [
      'alternativ utanför registret',
      { fält: FALT, alternativ: ['PLUMBING', 'PÅHITT'], användsTill: 'x' },
    ],
    ['ingen nytta', { fält: FALT, alternativ: ALT, användsTill: '  ' }],
  ])('%s → inte en giltig fråga', (_namn, f) => {
    expect(ärGiltigFråga(f)).toBe(false)
  })

  it('en fullständig fråga är giltig — annars kan proven ovan inte falla', () => {
    expect(
      ärGiltigFråga({ fält: FALT, alternativ: ALT, användsTill: 'Väljer rätt hantverkare.' }),
    ).toBe(true)
  })
})

medDb('frågans rundtur', () => {
  let prisma: PrismaClient
  let tjanst: QuestionService
  let orgA: string
  let orgB: string
  let userA: string
  let userB: string
  const ärende = () => `ticket-${randomUUID().slice(0, 8)}`

  const ställ = (org: string, user: string, sourceId: string, fält = FALT) =>
    tjanst.ställ(org, {
      toolName: 'FRAGA',
      sourceKind: SKUGGKALLA_FELANMALAN,
      sourceId,
      assignedToUserId: user,
      fråga: { fält, alternativ: fält === FALT ? ALT : ['LOW', 'HIGH'], användsTill: 'Nytta.' },
      text: 'Vilken kategori?',
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    tjanst = new QuestionService(prisma as never)
    const bygg = async (namn: string) => {
      const sfx = randomUUID().slice(0, 8)
      const o = await prisma.organization.create({
        data: {
          name: `${namn}-${sfx}`,
          email: `${namn}-${sfx}@example.se`,
          street: 'a',
          city: 'b',
          postalCode: '11111',
        },
        select: { id: true },
      })
      const u = await prisma.user.create({
        data: {
          organizationId: o.id,
          email: `${namn}-${sfx}@example.se`,
          passwordHash: 'x',
          firstName: 'Ada',
          lastName: 'Ek',
          role: 'OWNER',
        },
        select: { id: true },
      })
      return { org: o.id, user: u.id }
    }
    const a = await bygg('frA')
    const b = await bygg('frB')
    orgA = a.org
    userA = a.user
    orgB = b.org
    userB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiMemory.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiMemory.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  it('FRÅGA → SVAR → svaret finns som bekräftat minne med frågan som källa', async () => {
    const t = ärende()
    const r = await ställ(orgA, userA, t)
    expect(r.utfall).toBe('STÄLLD')
    const id = (r as { assignmentId: string }).assignmentId

    await tjanst.svara(orgA, id, userA, 'HEATING')

    const minne = await prisma.aiMemory.findFirstOrThrow({
      where: { organizationId: orgA, key: svarsNyckel(SKUGGKALLA_FELANMALAN, t, FALT) },
    })
    expect(minne.value).toBe('HEATING')
    // GRUNDEN: en människa tryckte just på alternativet. Starkare finns inte.
    expect(minne.provenanceKind).toBe('HUMAN_CONFIRMED')
    expect(minne.sourceKind).toBe('ASSIGNMENT')
    expect(minne.sourceId).toBe(id)
    expect(minne.confirmedByUserId).toBe(userA)

    // Och uppdraget är stängt, med svaret läsbart.
    const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id } })
    expect(rad.status).toBe('APPROVED')
    expect(rad.statusReason).toBe('HEATING')
  })

  it('NÄSTA FRÅGA i samma ärende ställs inte — svaret finns redan', async () => {
    const t = ärende()
    const r = await ställ(orgA, userA, t)
    await tjanst.svara(orgA, (r as { assignmentId: string }).assignmentId, userA, 'HEATING')

    const igen = await ställ(orgA, userA, t)
    expect(igen).toEqual({ utfall: 'REDAN_BESVARAD', svar: 'HEATING' })
    expect(
      await prisma.aiAssignment.count({ where: { organizationId: orgA, kind: 'QUESTION' } }),
    ).toBe(1)
  })

  it('HÖGST EN ÖPPEN FRÅGA per ärende — även om fältet är ett annat', async () => {
    const t = ärende()
    expect((await ställ(orgA, userA, t, 'category')).utfall).toBe('STÄLLD')
    expect((await ställ(orgA, userA, t, 'priority')).utfall).toBe('REDAN_ÖPPEN')
    expect(
      await prisma.aiAssignment.count({ where: { organizationId: orgA, kind: 'QUESTION' } }),
    ).toBe(1)
  })

  it('men ett ANNAT ärende får sin egen fråga', async () => {
    expect((await ställ(orgA, userA, ärende())).utfall).toBe('STÄLLD')
    expect((await ställ(orgA, userA, ärende())).utfall).toBe('STÄLLD')
  })

  it('EN ANNAN ORGANISATIONS svar räknas inte', async () => {
    const t = ärende()
    const r = await ställ(orgB, userB, t)
    await tjanst.svara(orgB, (r as { assignmentId: string }).assignmentId, userB, 'HEATING')
    // Samma ärende-id, annan organisation: frågan ska ställas.
    expect((await ställ(orgA, userA, t)).utfall).toBe('STÄLLD')
  })

  it('ett svar UTANFÖR alternativen avvisas', async () => {
    const r = await ställ(orgA, userA, ärende())
    const id = (r as { assignmentId: string }).assignmentId
    await expect(tjanst.svara(orgA, id, userA, 'ROOF')).rejects.toThrow(/inte ett av frågans/)
    expect(await prisma.aiMemory.count({ where: { organizationId: orgA } })).toBe(0)
  })

  it('ett ANDRA svar på samma fråga avvisas — anspråket är atomärt', async () => {
    const r = await ställ(orgA, userA, ärende())
    const id = (r as { assignmentId: string }).assignmentId
    await tjanst.svara(orgA, id, userA, 'PLUMBING')
    await expect(tjanst.svara(orgA, id, userA, 'HEATING')).rejects.toThrow(/redan besvarad/)
    const minne = await prisma.aiMemory.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(minne.value).toBe('PLUMBING')
  })

  it('en AVVISAD minnespost räknas inte som ett svar — frågan ställs igen', async () => {
    const t = ärende()
    const r = await ställ(orgA, userA, t)
    await tjanst.svara(orgA, (r as { assignmentId: string }).assignmentId, userA, 'HEATING')
    await prisma.aiMemory.updateMany({
      where: { organizationId: orgA },
      data: { rejectedAt: new Date() },
    })
    expect((await ställ(orgA, userA, t)).utfall).toBe('STÄLLD')
  })

  it('en OGILTIG fråga skrivs inte — fail-closed', async () => {
    const r = await tjanst.ställ(orgA, {
      toolName: 'FRAGA',
      sourceKind: SKUGGKALLA_FELANMALAN,
      sourceId: ärende(),
      assignedToUserId: userA,
      fråga: { fält: 'budget', alternativ: ALT, användsTill: 'x' } as never,
      text: 'x',
    })
    expect(r.utfall).toBe('OGILTIG')
    expect(await prisma.aiAssignment.count({ where: { organizationId: orgA } })).toBe(0)
  })
})
