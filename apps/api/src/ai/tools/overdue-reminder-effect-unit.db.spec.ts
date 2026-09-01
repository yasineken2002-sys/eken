/**
 * `send_overdue_reminders`: IDEMPOTENSENS ENHET ÄR EFFEKTEN — mot riktig Postgres.
 *
 * ── DE TVÅ NEGATIVA KONTROLLERNA DEN ÄGER ───────────────────────────────────
 *
 * 1. KRASCH MITT I LOOPEN. En körning som dör efter N av M mottagare ska lämna
 *    rader för de N, och en omkörning ska INTE skicka om till dem. Det var den
 *    fråga som inte gick att besvara alls före det här arbetet.
 *
 * 2. EFFEKTLISTAN ÄR INTE LÄNGRE TOM. Före ändringen hade båda loopverktygen
 *    NOLL Prisma-skrivningar (mätt 2026-09-01: bara `findMany`/`findUnique`).
 *    Eftersom `AiToolEffect` produceras av Prisma-extensionen på skrivvägen
 *    betydde det att en körning som skickade 40 brev gav en `AiToolExecution`
 *    med TOM effektlista — omöjlig att skilja från ett verktyg som inte gjorde
 *    någonting. Specen kräver därför inte bara att listan är icke-tom, utan att
 *    de två fallen FAKTISKT SKILJER SIG ÅT. En kontroll som bara ser det
 *    positiva fallet skiljer inte ett spår från en tillfällighet.
 *
 * ── VAD DEN HÄR SPECEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den mäter MEKANIKEN: att produktionens metodkropp skriver raden före
 * utskicket och hoppar över den som redan har en. Den kan INTE se att
 * `PaymentReminderType`-värdet är rätt VALT — att REMINDER_AI_MANUAL inte
 * släcker ett steg i cronens kravtrappa ägs av `sentTypes`-grinden i
 * `PaymentReminderService` och av de specar som prövar den. Den kan heller inte
 * se om ett brev faktiskt NÅDDE någon: `MailService` är stubbad här, och
 * leveransen ägs av Resend-webhooken.
 *
 * ── VARFÖR `Object.create` I STÄLLET FÖR KONSTRUKTORN ───────────────────────
 *
 * Samma skäl som `effect-trace-production-path.db.spec.ts`: konstruktorn tar 25
 * beroenden, och att räkna upp dem positionellt hade gjort specen röd av fel
 * skäl så fort någon la till ett tjugosjätte. `executeTool`-prologen rör bara
 * `audit` och `logger`; `this.prisma` och `this.mailService` når koden först
 * inne i verktygets egen gren. Metodkroppen som körs är produktionens.
 */
import { randomUUID } from 'node:crypto'

// Samma ESM-stubbar som effect-trace-specen: StorageService/PdfService drar in
// @aws-sdk respektive puppeteer via importkedjan tool-executor → invoices.service.
// De rör INTE vägen som mäts.
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
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

/** Hur länge vi väntar på ett spår som ingen inväntar (`void logToolExecution`). */
const SPAR_DEADLINE_MS = 8_000

/** Antal förfallna fakturor i riggen, och var kraschen slår. */
const ANTAL_FAKTUROR = 5
const KRASCH_EFTER = 2

medDb('send_overdue_reminders — enheten är effekten, inte anropet', () => {
  let prisma: PrismaService
  let audit: AiAuditService
  let orgId: string
  let userId: string
  let tenantId: string
  let fakturaIds: string[] = []
  let betaldFakturaId: string

  /** Bygger en exekverare med produktionens metodkropp och angiven mail-stubb. */
  const byggExecutor = (
    mailService: { sendOverdueReminder: (opts: { to: string }) => Promise<string> },
    prismaFörExecutor: PrismaService = prisma,
  ): ToolExecutorService => {
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma: prismaFörExecutor,
      audit,
      mailService,
      logger: new Logger('spec'),
    })
    return executor
  }

  /** Mail-stubb som bokför vilka mottagare den faktiskt anropades för. */
  const bokförandeMail = () => {
    const mottagare: string[] = []
    return {
      mottagare,
      sendOverdueReminder: async (opts: { to: string }) => {
        mottagare.push(opts.to)
        return `job-${randomUUID().slice(0, 8)}`
      },
    }
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    audit = new AiAuditService(prisma)

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `paminn-${sfx}`,
        email: `paminn-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `paminn-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'P',
        lastName: 'M',
        role: 'OWNER',
      },
    })
    userId = user.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gäst',
        email: `paminn-t-${sfx}@example.se`,
      },
    })
    tenantId = tenant.id

    const gemensamt = {
      organizationId: orgId,
      tenantId,
      type: 'RENT' as const,
      subtotal: 1000,
      vatTotal: 0,
      total: 1000,
      dueDate: new Date('2026-08-01T00:00:00Z'),
      issueDate: new Date('2026-07-01T00:00:00Z'),
    }

    for (let i = 0; i < ANTAL_FAKTUROR; i++) {
      const inv = await prisma.invoice.create({
        data: { ...gemensamt, invoiceNumber: `F-${sfx}-${i}`, status: 'OVERDUE' },
        select: { id: true },
      })
      fakturaIds.push(inv.id)
    }

    // Referensfakturan för "körningen gjorde ingenting": PAID faller ur
    // verktygets `where: { status: 'OVERDUE' }`.
    const betald = await prisma.invoice.create({
      data: { ...gemensamt, invoiceNumber: `F-${sfx}-betald`, status: 'PAID' },
      select: { id: true },
    })
    betaldFakturaId = betald.id
  })

  afterAll(async () => {
    await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })

    // Samma sena-skrivning-tolerans som effect-trace-specen: `logToolExecution`
    // anropas med `void` och kan landa efter att testet tagit slut.
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

  /** Väntar tills en körning som INTE fanns före dyker upp med stängt spår. */
  const väntaPåNyttSpår = async (kändaIds: Set<string>) => {
    const deadline = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const rader = await prisma.aiToolExecution.findMany({
        where: { organizationId: orgId, toolName: 'send_overdue_reminders' },
        select: { id: true, effects: { select: { entityType: true, entityId: true } } },
      })
      const ny = rader.find((r) => !kändaIds.has(r.id))
      if (ny) return ny
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const kändaSpårIds = async () => {
    const rader = await prisma.aiToolExecution.findMany({
      where: { organizationId: orgId, toolName: 'send_overdue_reminders' },
      select: { id: true },
    })
    return new Set(rader.map((r) => r.id))
  }

  it('KRASCH efter N av M: raderna finns för de N, och omkörningen skickar inte om till dem', async () => {
    // ── Kraschen ────────────────────────────────────────────────────────────
    //
    // Simuleras där den faktiskt kan inträffa: `paymentReminder.create` slutar
    // svara mitt i loopen (databasen försvinner). Det felet är INTE P2002 och
    // kastas därför vidare ut ur hela loopen — en äkta avbruten körning, inte
    // ett mottagarfel som `catch`:en sväljer.
    //
    // Fasaden ersätter bara den ena delegaten. `executeTool`-prologen rör inte
    // `this.prisma` alls, och verktygets gren rör bara `invoice` och
    // `paymentReminder`.
    let skapade = 0
    const kraschandePrisma = {
      invoice: prisma.invoice,
      paymentReminder: {
        create: async (args: never) => {
          skapade++
          if (skapade > KRASCH_EFTER) throw new Error('KRASCH: databasen försvann mitt i loopen')
          return prisma.paymentReminder.create(args)
        },
        update: (args: never) => prisma.paymentReminder.update(args),
        delete: (args: never) => prisma.paymentReminder.delete(args),
      },
    } as unknown as PrismaService

    const förstaMail = bokförandeMail()
    // `executeTool` fångar kastet och rapporterar det som ett misslyckat
    // resultat i stället för att låta det bubbla — mätt, inte antaget. Kroppen
    // avbröts likväl mitt i loopen, och det är det tillståndet som prövas nedan.
    const avbrutet = await byggExecutor(förstaMail, kraschandePrisma).executeTool(
      'send_overdue_reminders',
      {},
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(avbrutet.success).toBe(false)
    expect(avbrutet.message).toContain('KRASCH')

    // Den avbrutna körningen hann skicka exakt KRASCH_EFTER brev …
    expect(förstaMail.mottagare).toHaveLength(KRASCH_EFTER)

    // … och lämnade en rad per skickat brev. Det är hela poängen med att skriva
    // FÖRE utskicket: hade raden skrivits efter hade den saknats för precis den
    // mottagare där körningen dog.
    const efterKrasch = await prisma.paymentReminder.findMany({
      where: { invoice: { organizationId: orgId }, type: 'REMINDER_AI_MANUAL' },
      select: { invoiceId: true },
    })
    expect(efterKrasch).toHaveLength(KRASCH_EFTER)
    const redanSkickadeTill = new Set(efterKrasch.map((r) => r.invoiceId))

    // ── Omkörningen ─────────────────────────────────────────────────────────
    const andraMail = bokförandeMail()
    const resultat = await byggExecutor(andraMail).executeTool(
      'send_overdue_reminders',
      {},
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(resultat.success).toBe(true)

    // INGEN dubblett: de som redan fått sitt brev får inget nytt.
    expect(andraMail.mottagare).toHaveLength(ANTAL_FAKTUROR - KRASCH_EFTER)

    // OCH INGET BORTFALL: alla fem har nu exakt en rad var. Den omvända
    // riktningen är lika viktig — en spärr som skyddar genom att skicka för få
    // är samma fel som en som skickar för många.
    const slutrader = await prisma.paymentReminder.findMany({
      where: { invoice: { organizationId: orgId }, type: 'REMINDER_AI_MANUAL' },
      select: { invoiceId: true },
    })
    expect(slutrader).toHaveLength(ANTAL_FAKTUROR)
    expect(new Set(slutrader.map((r) => r.invoiceId)).size).toBe(ANTAL_FAKTUROR)

    // De N från första körningen är kvar — omkörningen rörde dem inte.
    for (const id of redanSkickadeTill) {
      expect(slutrader.some((r) => r.invoiceId === id)).toBe(true)
    }

    // En TREDJE körning skickar ingenting alls.
    const tredjeMail = bokförandeMail()
    await byggExecutor(tredjeMail).executeTool(
      'send_overdue_reminders',
      {},
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(tredjeMail.mottagare).toHaveLength(0)
  })

  it('effektlistan skiljer en körning som skickade brev från en som inte gjorde något', async () => {
    // ── Fallet "gjorde ingenting" ───────────────────────────────────────────
    // Den betalda fakturan faller ur `where: { status: 'OVERDUE' }`, så loopen
    // har noll mottagare.
    const föreTom = await kändaSpårIds()
    const tomMail = bokförandeMail()
    await byggExecutor(tomMail).executeTool(
      'send_overdue_reminders',
      { invoiceIds: [betaldFakturaId] },
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(tomMail.mottagare).toHaveLength(0)

    const tomtSpår = await väntaPåNyttSpår(föreTom)
    expect(tomtSpår).not.toBeNull()
    const tomtaEffekter = tomtSpår!.effects.filter((e) => e.entityType === 'PaymentReminder')
    expect(tomtaEffekter).toHaveLength(0)

    // ── Fallet "skickade brev" ──────────────────────────────────────────────
    // Städa raderna från föregående test så att fakturorna är påminnelsebara igen.
    await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: orgId } } })

    const föreSkarp = await kändaSpårIds()
    const skarpMail = bokförandeMail()
    await byggExecutor(skarpMail).executeTool(
      'send_overdue_reminders',
      {},
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(skarpMail.mottagare).toHaveLength(ANTAL_FAKTUROR)

    const skarptSpår = await väntaPåNyttSpår(föreSkarp)
    expect(skarptSpår).not.toBeNull()
    const skarpaEffekter = skarptSpår!.effects.filter((e) => e.entityType === 'PaymentReminder')

    // FYND (a), BEVISAT. Före det här arbetet hade BÅDA körningarna gett noll
    // effekter — en körning som skickade fem brev var oskiljbar från en som
    // inte gjorde någonting. Nu skiljer de sig, och skillnaden är mätbar.
    expect(skarpaEffekter.length).toBeGreaterThan(0)
    expect(tomtaEffekter.length).toBe(0)

    // Och spåret pekar på det som FAKTISKT skrevs, inte bara på "något".
    const rader = await prisma.paymentReminder.findMany({
      where: { invoice: { organizationId: orgId }, type: 'REMINDER_AI_MANUAL' },
      select: { id: true },
    })
    expect(rader).toHaveLength(ANTAL_FAKTUROR)
    const spåradeIds = new Set(skarpaEffekter.map((e) => e.entityId))
    for (const rad of rader) {
      expect(spåradeIds.has(rad.id)).toBe(true)
    }
  })
})
