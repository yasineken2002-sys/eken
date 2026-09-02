/**
 * SKUGGLÄGET MOT RIKTIG POSTGRES — med INJICERADE fall.
 *
 * ── VARFÖR INJICERADE, OCH INTE VERKLIGA ────────────────────────────────────
 *
 * Därför att verkliga inte finns. Mätt 2026-09-02:
 *
 *     AiToolExecution i produktion            11 rader, ALLA "påbörjade"
 *     …varav med tvåfasvägens form             0        (alla 11 är enfasrader
 *                                                        från före kolumnen)
 *     …varav verktyg med en deklaration        0        (alla fem är get_*)
 *     AiToolExecution i dev                     2 rader, 0 påbörjade
 *
 * Noll återupptagbara rader i båda databaserna. Det är ett resultat, inte ett
 * hinder — men det betyder att skuggutfallet måste mätas mot fall som riggen
 * själv skapar, annars mäter provet att mängden är tom.
 *
 * ── VAD RIGGEN ÄGER, OCH VAD DEN INTE KAN ÄGA ───────────────────────────────
 *
 * Riggen skapar sin egen organisation och sina egna körningsrader. Men motorns
 * fråga är PLATTFORMSBRED — den läser alla påbörjade rader, inte en organisations
 * — så `candidates` i körningsraden kan innehålla rader riggen inte skrev.
 * Proven hävdar därför alltid något om DE EGNA execution-id:na, och bara
 * `>=`-påståenden om totalerna. Ett prov som krävt ett exakt globalt tal hade
 * mätt databasens innehåll och inte motorns omdöme.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att skarpt läge blir rätt. Det finns inget skarpt läge att pröva; provet
 * längst ned mäter bara att vägen dit inte finns i koden.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { AiQuotaService } from '../usage/ai-quota.service'
import { ResumptionService } from './resumption.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const NU = new Date('2026-09-02T12:00:00.000Z')
/** Mitt i fönstret [60 s, 5 min]. */
const I_FONSTRET = 120_000

medDb('återupptagningsmotorn i skuggläge', () => {
  let prisma: PrismaClient
  let motor: ResumptionService
  let sinkAnrop: Array<{ cron: string; fel: unknown }>
  let orgId: string

  /** En påbörjad rad med tvåfasvägens form, om inget annat sägs. */
  const påbörjad = async (
    over: {
      toolName?: string
      ålder?: number
      success?: boolean
      durationMs?: number
      toolResult?: object
      completedAt?: Date
    } = {},
  ) => {
    const r = await prisma.aiToolExecution.create({
      data: {
        organizationId: orgId,
        toolName: over.toolName ?? 'create_property',
        toolInput: {},
        success: over.success ?? false,
        durationMs: over.durationMs ?? 0,
        createdAt: new Date(NU.getTime() - (over.ålder ?? I_FONSTRET)),
        ...(over.toolResult ? { toolResult: over.toolResult } : {}),
        ...(over.completedAt ? { completedAt: over.completedAt } : {}),
      },
      select: { id: true },
    })
    return r.id
  }

  const dom = (executionId: string) =>
    prisma.aiResumptionVerdict.findUnique({
      where: { executionId },
      select: { decision: true, reason: true, ageSec: true, assessments: true, toolName: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    sinkAnrop = []
    motor = Object.create(ResumptionService.prototype) as ResumptionService
    Object.assign(motor, {
      prisma,
      quota: new AiQuotaService(prisma as never),
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: {
        report: async (cron: string, fel: unknown) => {
          sinkAnrop.push({ cron, fel })
        },
      },
      logger: new Logger('spec'),
      senasteHjärtslag: 0,
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `res-${sfx}`,
        email: `res-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
  }, 30_000)

  beforeEach(async () => {
    sinkAnrop = []
    await prisma.aiResumptionVerdict.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiResumptionRun.deleteMany({ where: { verdicts: { none: {} } } })
    await prisma.aiUsageLog.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.aiResumptionVerdict.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiResumptionRun.deleteMany({ where: { verdicts: { none: {} } } })
    await prisma.aiUsageLog.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('SKRIVER NER vad den skulle ha gjort — och rör ingenting', async () => {
    const id = await påbörjad({ toolName: 'create_property' })

    const före = await prisma.property.count({ where: { organizationId: orgId } })
    const utfall = await motor.körEttPass(NU)
    const efter = await prisma.property.count({ where: { organizationId: orgId } })

    expect(await dom(id)).toEqual({
      decision: 'RESUME',
      reason: 'RESUMABLE',
      ageSec: I_FONSTRET / 1000,
      assessments: 1,
      toolName: 'create_property',
    })
    // Domen säger RESUME. Ingenting hände.
    expect(efter).toBe(före)
    expect(utfall.återuppta).toBeGreaterThanOrEqual(1)
    // Och raden står kvar som påbörjad — motorn stängde den inte heller.
    const kvar = await prisma.aiToolExecution.findUniqueOrThrow({
      where: { id },
      select: { completedAt: true },
    })
    expect(kvar.completedAt).toBeNull()
  })

  it('KÖRNINGSRADEN skrivs, med fördelningen — även "jag gjorde ingenting" är läsbart', async () => {
    await påbörjad({ toolName: 'send_overdue_reminders' })
    await påbörjad({ toolName: 'get_invoices' })

    const utfall = await motor.körEttPass(NU)
    expect(utfall.runId).not.toBeNull()

    const run = await prisma.aiResumptionRun.findUniqueOrThrow({
      where: { id: utfall.runId! },
      select: {
        mode: true,
        candidates: true,
        resumed: true,
        abstained: true,
        reasonCounts: true,
        finishedAt: true,
      },
    })
    expect(run.mode).toBe('SHADOW')
    expect(run.finishedAt).not.toBeNull()
    expect(run.candidates).toBeGreaterThanOrEqual(2)
    const skäl = run.reasonCounts as Record<string, number>
    expect(skäl['REQUIRES_HUMAN']).toBeGreaterThanOrEqual(1)
    expect(skäl['UNKNOWN_CLASSIFICATION']).toBeGreaterThanOrEqual(1)
  })

  it('KRÄVER_MÄNNISKA avstås — mot en riktig rad, inte bara i den rena funktionen', async () => {
    const id = await påbörjad({ toolName: 'send_overdue_reminders' })
    await motor.körEttPass(NU)
    expect((await dom(id))?.reason).toBe('REQUIRES_HUMAN')
  })

  it('PRODUKTIONENS EGEN FORM: en enfasrad är okänt tillstånd', async () => {
    // Exakt formen på de 11 raderna i prod.
    const id = await påbörjad({
      toolName: 'get_overdue_invoices',
      success: true,
      durationMs: 51,
      toolResult: { ok: true },
      ålder: 905 * 60 * 60 * 1000,
    })
    await motor.körEttPass(NU)
    expect((await dom(id))?.reason).toBe('PRE_TWO_PHASE')
  })

  it('EN RAD PER KÖRNING, inte per bedömning — tabellen växer inte obegränsat', async () => {
    const id = await påbörjad()
    await motor.körEttPass(NU)
    await motor.körEttPass(new Date(NU.getTime() + 60_000))

    const rader = await prisma.aiResumptionVerdict.findMany({ where: { executionId: id } })
    expect(rader).toHaveLength(1)
    expect(rader[0]!.assessments).toBe(2)
    // Åldern är den SENASTE bedömningens, inte den första.
    expect(rader[0]!.ageSec).toBe((I_FONSTRET + 60_000) / 1000)
  })

  it('KVOTEN GÄLLER, och stoppet är SYNLIGT', async () => {
    // Över den dagliga org-capen (200 kr). Automatiska anrop räknas med.
    await prisma.aiUsageLog.create({
      data: {
        organizationId: orgId,
        endpoint: 'chat',
        model: 'claude',
        costUsd: 30,
        costSek: 300,
        isAutomated: true,
      },
    })
    const id = await påbörjad({ toolName: 'create_property' })

    await motor.körEttPass(NU)

    expect(await dom(id)).toMatchObject({ decision: 'ABSTAIN', reason: 'QUOTA_BLOCKED' })
    // SYNLIGT: ett kvotstopp går till cron-felsänkan, inte bara till en dom.
    expect(sinkAnrop.map((a) => a.cron)).toContain('ai-resumption-shadow')
  })

  it('KVOTGRINDEN drar ALDRIG en credit — den läsande halvan används', async () => {
    // checkQuota() gör `aiCreditsBalance: { decrement: 1 }` när månadstaket är
    // nått. En motor i skuggläge som anropade den hade betalat med kundens
    // pengar för något den aldrig tänkte utföra.
    await prisma.organization.update({ where: { id: orgId }, data: { aiCreditsBalance: 7 } })
    await påbörjad({ toolName: 'create_property' })

    await motor.körEttPass(NU)

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { aiCreditsBalance: true },
    })
    expect(org.aiCreditsBalance).toBe(7)
  })

  it('EN MYCKET GAMMAL RAD spiller inte över kolumnen', async () => {
    // Prods påbörjade rader var 37,7 dygn gamla. En ålder i MILLISEKUNDER ryms
    // inte i en INT4 (24,9 dygn), och motorn hade fallit på den första raden.
    const id = await påbörjad({ ålder: 905 * 60 * 60 * 1000 })
    await motor.körEttPass(NU)
    expect((await dom(id))?.ageSec).toBe(905 * 60 * 60)
  })

  it('EN UTÅLDRAD RAD rapporteras — men EN GÅNG, inte varje pass', async () => {
    // Det enda avslaget som beskriver ett fel hos motorn och inte hos raden.
    // Ett tyst överhopp här hade dolt att taket är för snävt eller kadensen
    // för gles — och en rapport per minut hade gjort sänkan oläsbar, vilket är
    // samma tystnad i en annan förklädnad.
    const id = await påbörjad({ toolName: 'create_property', ålder: 10 * 60 * 1000 })

    await motor.körEttPass(NU)
    expect((await dom(id))?.reason).toBe('TOO_OLD')
    const första = sinkAnrop.filter((a) => String((a.fel as Error).message).includes('åldrades ut'))
    expect(första).toHaveLength(1)

    sinkAnrop = []
    await motor.körEttPass(new Date(NU.getTime() + 60_000))
    expect(
      sinkAnrop.filter((a) => String((a.fel as Error).message).includes('åldrades ut')),
    ).toHaveLength(0)
    expect((await dom(id))?.assessments).toBe(2)
  })

  it('en gammal rad som ALDRIG var återupptagbar rapporteras INTE som utåldrad', async () => {
    // TVÅ former, och den andra är den skarpa:
    //   • en ENFASRAD — prods elva hade annars sett ut som elva missade fönster.
    //   • en KRÄVER_MÄNNISKA-rad med ÄKTA tvåfasform, alltså en rad som passerar
    //     steg 1 och 2 och stoppas först av policyn. Kastas stegen om så att
    //     taket prövas före policyn får den skäl TOO_OLD, och en naken
    //     `skäl === 'TOO_OLD'`-läsning hade då larmat om en missad
    //     återupptagning som aldrig kunde ha skett. `ärUtåldrad` svarar nej.
    await påbörjad({
      toolName: 'get_invoices',
      success: true,
      durationMs: 9,
      toolResult: { ok: true },
      ålder: 30 * 24 * 60 * 60 * 1000,
    })
    await påbörjad({ toolName: 'send_overdue_reminders', ålder: 30 * 24 * 60 * 60 * 1000 })

    await motor.körEttPass(NU)
    expect(
      sinkAnrop.filter((a) => String((a.fel as Error).message).includes('åldrades ut')),
    ).toHaveLength(0)
  })

  // VAD PROVEN OVAN INTE KAN SE: med dagens stegordning är `skäl === 'TOO_OLD'`
  // och `ärUtåldrad` samma mängd, så INGET data-drivet prov kan skilja dem åt.
  // Skillnaden uppstår först om stegen kastas om, och det fångas av
  // ekvivalensprovet i `resumption-policy.spec.ts` — inte här.
})
