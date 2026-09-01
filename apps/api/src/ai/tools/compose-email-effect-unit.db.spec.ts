/**
 * `compose_and_send_email`: IDEMPOTENSENS ENHET ÄR MOTTAGAREN — mot riktig Postgres.
 *
 * Syskon till `overdue-reminder-effect-unit.db.spec.ts`, samma två frågor:
 *
 * 1. KRASCH MITT I LOOPEN. En körning som dör efter N av M ska lämna rader för
 *    de N, och en omkörning ska skicka till de M−N som återstår — inte till
 *    alla, och inte till ingen.
 *
 * 2. EFFEKTLISTAN ÄR INTE LÄNGRE TOM. Före arbetet hade verktyget NOLL
 *    Prisma-skrivningar, så en körning som skickade brev gav en
 *    `AiToolExecution` med tom effektlista — oskiljbar från ett verktyg som
 *    inte gjorde något. Provet kräver att de två fallen FAKTISKT skiljer sig.
 *
 * ── VAD DEN HÄR SPECEN INTE KAN SE ──────────────────────────────────────────
 *
 * Skyddet mot omkörning är en LÄSNING FÖRE EN SKRIVNING, inte ett unikt index.
 * Specen kör sekventiellt och kan därför bara visa att omkörningen hoppar över
 * — den kan INTE visa att två SAMTIDIGA körningar gör det, för det gör de inte.
 * Den DB-enforcerade spärren är ett eget, senare steg; tills den finns är det
 * här ett skydd mot omkörning och inte mot kapplöpning.
 *
 * Den säger heller ingenting om att brevet NÅDDE någon (MailService är stubbad,
 * leveransen ägs av Resend-webhooken) eller om saneringen av innehållet (den
 * har ett eget prov i `compose-email-sanitering.spec.ts`).
 */
import { randomUUID } from 'node:crypto'

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { ToolExecutorService } from './tool-executor.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const SPAR_DEADLINE_MS = 8_000
/** Fem, inte sex: EMAIL_BULK_THRESHOLD är `> 5`, så cooldownen aktiveras inte. */
const ANTAL_MOTTAGARE = 5
const KRASCH_EFTER = 2
const AMNE = 'Information om trapphuset'
const BREV = 'Hej {namn},\nVi målar trapphuset på torsdag.'

medDb('compose_and_send_email — enheten är mottagaren', () => {
  let prisma: PrismaService
  let audit: AiAuditService
  let orgId: string
  let userId: string
  const tenantIds: string[] = []

  const bokförandeMail = () => {
    const mottagare: string[] = []
    return {
      mottagare,
      sendCustomEmail: async (opts: { to: string }) => {
        mottagare.push(opts.to)
        return `job-${randomUUID().slice(0, 8)}`
      },
    }
  }

  const byggExecutor = (
    mailService: { sendCustomEmail: (o: { to: string }) => Promise<string> },
    prismaFörExecutor: PrismaService = prisma,
  ) => {
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma: prismaFörExecutor,
      audit,
      mailService,
      redis: { client: { set: jest.fn().mockResolvedValue('OK'), ttl: jest.fn() } },
      logger: new Logger('spec'),
    })
    return executor
  }

  const kör = (executor: ToolExecutorService) =>
    executor.executeTool(
      'compose_and_send_email',
      { tenantIds, subject: AMNE, body: BREV, emailType: 'GENERAL' },
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )

  beforeAll(async () => {
    prisma = new PrismaService()
    audit = new AiAuditService(prisma)

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `brev-${sfx}`,
        email: `brev-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        invoiceColor: '#123456',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `brev-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'B',
        lastName: 'R',
        role: 'OWNER',
      },
    })
    userId = user.id

    for (let i = 0; i < ANTAL_MOTTAGARE; i++) {
      const t = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: `Hyres${i}`,
          lastName: 'Gäst',
          email: `brev-t${i}-${sfx}@example.se`,
        },
        select: { id: true },
      })
      tenantIds.push(t.id)
    }
  })

  afterAll(async () => {
    await prisma.sentMessage.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    for (let försök = 1; ; försök++) {
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
      try {
        await prisma.organization.delete({ where: { id: orgId } })
        break
      } catch (err) {
        if (försök >= 5) throw err
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    await prisma.$disconnect()
  })

  const väntaPåNyttSpår = async (kända: Set<string>) => {
    const deadline = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const rader = await prisma.aiToolExecution.findMany({
        where: { organizationId: orgId, toolName: 'compose_and_send_email' },
        select: { id: true, effects: { select: { entityType: true, entityId: true } } },
      })
      const ny = rader.find((r) => !kända.has(r.id))
      if (ny) return ny
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const kändaSpårIds = async () =>
    new Set(
      (
        await prisma.aiToolExecution.findMany({
          where: { organizationId: orgId, toolName: 'compose_and_send_email' },
          select: { id: true },
        })
      ).map((r) => r.id),
    )

  it('KRASCH efter N av M: raderna finns för de N, och omkörningen skickar bara till resten', async () => {
    // Kraschen slår där den faktiskt kan inträffa: `sentMessage.create` slutar
    // svara mitt i loopen. Felet är inte P2002 och kastas därför vidare ut ur
    // loopen — en äkta avbruten körning, inte ett mottagarfel.
    let skapade = 0
    const kraschandePrisma = {
      tenant: prisma.tenant,
      organization: prisma.organization,
      sentMessage: {
        findFirst: (a: never) => prisma.sentMessage.findFirst(a),
        create: async (a: never) => {
          skapade++
          if (skapade > KRASCH_EFTER) throw new Error('KRASCH: databasen försvann mitt i loopen')
          return prisma.sentMessage.create(a)
        },
        update: (a: never) => prisma.sentMessage.update(a),
      },
    } as unknown as PrismaService

    const första = bokförandeMail()
    const avbrutet = await kör(byggExecutor(första, kraschandePrisma))
    expect(avbrutet.success).toBe(false)
    expect(avbrutet.message).toContain('KRASCH')
    expect(första.mottagare).toHaveLength(KRASCH_EFTER)

    // Rader för exakt de som fick brev — det är hela poängen med att skriva före.
    const efterKrasch = await prisma.sentMessage.findMany({
      where: { organizationId: orgId },
      select: { tenantId: true, status: true, successCount: true },
    })
    expect(efterKrasch).toHaveLength(KRASCH_EFTER)
    expect(efterKrasch.every((r) => r.status === 'SENT')).toBe(true)
    expect(efterKrasch.every((r) => r.successCount === 1)).toBe(true)

    // ── Omkörningen ─────────────────────────────────────────────────────────
    const andra = bokförandeMail()
    const resultat = await kör(byggExecutor(andra))
    expect(resultat.success).toBe(true)

    // Skickar till resten — inte till alla, inte till ingen.
    expect(andra.mottagare).toHaveLength(ANTAL_MOTTAGARE - KRASCH_EFTER)
    expect(resultat.message).toContain(`${KRASCH_EFTER} hoppades över`)

    // EN rad per mottagare, ingen dubblett, ingen som fallit bort.
    const slut = await prisma.sentMessage.findMany({
      where: { organizationId: orgId },
      select: { tenantId: true, recipientCount: true, sentToAll: true },
    })
    expect(slut).toHaveLength(ANTAL_MOTTAGARE)
    expect(new Set(slut.map((r) => r.tenantId)).size).toBe(ANTAL_MOTTAGARE)
    // Enheten syns i raden själv: en mottagare, inte ett anrop.
    expect(slut.every((r) => r.recipientCount === 1 && r.sentToAll === false)).toBe(true)

    // En TREDJE körning skickar ingenting alls.
    const tredje = bokförandeMail()
    const tredjeResultat = await kör(byggExecutor(tredje))
    expect(tredje.mottagare).toHaveLength(0)
    expect(tredjeResultat.message).toContain('Inget nytt skickades')
  })

  it('effektlistan skiljer en körning som skickade brev från en som inte gjorde något', async () => {
    // Läget efter förra provet: alla fem har en SENT-rad. En körning nu hoppar
    // över allihop och SKRIVER INGENTING — uppslaget är en läsning.
    const föreTom = await kändaSpårIds()
    const tomMail = bokförandeMail()
    await kör(byggExecutor(tomMail))
    expect(tomMail.mottagare).toHaveLength(0)

    const tomtSpår = await väntaPåNyttSpår(föreTom)
    expect(tomtSpår).not.toBeNull()
    const tomtaEffekter = tomtSpår!.effects.filter((e) => e.entityType === 'SentMessage')
    expect(tomtaEffekter).toHaveLength(0)

    // Städa så att mottagarna är brevbara igen.
    await prisma.sentMessage.deleteMany({ where: { organizationId: orgId } })

    const föreSkarp = await kändaSpårIds()
    const skarpMail = bokförandeMail()
    await kör(byggExecutor(skarpMail))
    expect(skarpMail.mottagare).toHaveLength(ANTAL_MOTTAGARE)

    const skarptSpår = await väntaPåNyttSpår(föreSkarp)
    expect(skarptSpår).not.toBeNull()
    const skarpaEffekter = skarptSpår!.effects.filter((e) => e.entityType === 'SentMessage')

    // FYND (a), BEVISAT FÖR DET ANDRA LOOPVERKTYGET. Före arbetet hade BÅDA
    // körningarna gett noll effekter.
    expect(skarpaEffekter.length).toBeGreaterThan(0)
    expect(tomtaEffekter.length).toBe(0)

    // Och spåret pekar på det som FAKTISKT skrevs.
    const rader = await prisma.sentMessage.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
    expect(rader).toHaveLength(ANTAL_MOTTAGARE)
    const spårade = new Set(skarpaEffekter.map((e) => e.entityId))
    for (const rad of rader) expect(spårade.has(rad.id)).toBe(true)
  })
})
