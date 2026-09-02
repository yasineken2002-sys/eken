/**
 * DE TRE GRÄNSERNA MOT RIKTIG POSTGRES — och vad vakten inte kan se.
 *
 * ── ARBETSDELNINGEN, UTSKRIVEN ──────────────────────────────────────────────
 *
 * `check-actor-stamping.mjs` läser KÄLLTEXT och mäter att mekanismen är
 * PÅKOPPLAD. Den kan per konstruktion inte se en runtime-no-op: en extension
 * som returnerar `args` orört, eller en kontext som töms innan hanteraren kör,
 * lämnar vakten grön. Den här filen äger den halvan.
 *
 * ── VARFÖR ATTRAPP INTE DUGER ───────────────────────────────────────────────
 *
 * Stämplingen sker i en Prisma-extension. En attrapp returnerar det den blivit
 * tillsagd att returnera oavsett vad extensionen gjorde med `args`, så ett
 * mockat prov hade varit grönt även med extensionen bortkopplad. Kolumnen måste
 * läsas tillbaka UR DATABASEN för att provet ska betyda något.
 *
 * ── DEN LATA OBSERVABLE-FÄLLAN ──────────────────────────────────────────────
 *
 * Interceptorn prövas med en LAT `next.handle()` — en Observable vars hanterare
 * körs först vid prenumeration. Skrivs interceptorn som
 * `runWithActor(kind, () => next.handle())` stängs kontexten innan hanteraren
 * ens startat, och raden får NULL. Provet nedan faller på exakt den formen.
 *
 * INGEN PERSONDATA i utdata: bara antal och id:n som skapats i testet.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { Observable, lastValueFrom } from 'rxjs'

import { ActorInterceptor } from './actor.interceptor'
import { currentActor, runWithActor } from './actor.context'
import { STÄMPLADE_MODELLER } from '../prisma/actor-stamp-extension'
import { actorStampExtension } from '../prisma/actor-stamp-extension'
import { runCronSafely } from '../cron/cron-safety'
import { runAsAi } from '../ai-origin/ai-origin.context'
import { aiEffectExtension } from '../prisma/ai-effect-extension'
import { runWithEffectCollector } from '../ai-effects/ai-effects.context'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })

  it('MODELLMÄNGDEN ÄR INTE TOM — annars mäter varje prov nedan ingenting', () => {
    // Härledningen går via DMMF. Byter fältet namn, eller tappar DMMF sina
    // fält, blir mängden tom och stämplingen en no-op som ser korrekt ut.
    expect(STÄMPLADE_MODELLER.size).toBeGreaterThanOrEqual(20)
    expect(STÄMPLADE_MODELLER.has('MaintenanceTicket')).toBe(true)
    // Och motprovet: en modell UTAN kolumnen ska inte vara med.
    expect(STÄMPLADE_MODELLER.has('AiToolExecution')).toBe(false)
  })
})

medDb('aktörsstämplingen: de tre gränserna', () => {
  let prisma: ReturnType<PrismaClient['$extends']> extends never ? never : PrismaClient
  let orgId: string
  let propertyId: string
  let unitId: string
  let userId: string
  let n = 0

  beforeAll(async () => {
    // SAMMA kedja som PrismaService: effekten först (ytterst), stämplingen
    // innanför. Ett prov med bara den ena hade inte prövat sammansättningen.
    prisma = new PrismaClient()
      .$extends(aiEffectExtension)
      .$extends(actorStampExtension) as unknown as PrismaClient

    const sfx = randomUUID().slice(0, 8)
    orgId = (
      await prisma.organization.create({
        data: {
          name: `akt-${sfx}`,
          email: `akt-${sfx}@example.se`,
          street: 'a',
          city: 'b',
          postalCode: '11111',
        },
        select: { id: true },
      })
    ).id
    userId = (
      await prisma.user.create({
        data: {
          organizationId: orgId,
          email: `akt-u-${sfx}@example.se`,
          passwordHash: 'x',
          firstName: 'A',
          lastName: 'B',
          role: 'OWNER',
        },
        select: { id: true },
      })
    ).id
    propertyId = (
      await prisma.property.create({
        data: {
          organizationId: orgId,
          name: `F ${sfx}`,
          propertyDesignation: `AKT ${sfx}`,
          type: 'RESIDENTIAL',
          street: 'a',
          city: 'b',
          postalCode: '11111',
          totalArea: 100,
        },
        select: { id: true },
      })
    ).id
    unitId = (
      await prisma.unit.create({
        data: {
          propertyId,
          name: 'Lgh 1',
          unitNumber: '1',
          type: 'APARTMENT',
          area: 50,
          rooms: 2,
          monthlyRent: 10000,
        },
        select: { id: true },
      })
    ).id
  }, 30_000)

  afterAll(async () => {
    await prisma.aiToolEffect.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** Skapar en felanmälan och läser tillbaka aktörsslaget UR DATABASEN. */
  const skrivOchLäs = async (): Promise<string | null> => {
    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId,
        unitId,
        ticketNumber: `FA-${orgId.slice(0, 4)}-${++n}`,
        title: 'Droppande kran',
        description: 'x',
        category: 'PLUMBING',
        priority: 'LOW',
      },
      select: { id: true },
    })
    const läst = await prisma.maintenanceTicket.findUniqueOrThrow({
      where: { id: t.id },
      select: { actorKind: true },
    })
    return läst.actorKind
  }

  it('UTANFÖR ALLA GRÄNSER → NULL. Aldrig ett default, aldrig HUMAN', async () => {
    expect(currentActor()).toBeUndefined()
    expect(await skrivOchLäs()).toBeNull()
  })

  it('MÄNNISKOGRÄNSEN: en autentiserad request → HUMAN', async () => {
    const interceptor = new ActorInterceptor()
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: userId } }) }),
    } as never

    // LAT Observable — hanteraren körs först vid prenumeration. Det är den
    // formen som fäller en interceptor skriven som `runWithActor(k, () => h())`.
    let slag: string | null = 'kördes-aldrig'
    const next = {
      handle: () =>
        new Observable<unknown>((sub) => {
          void skrivOchLäs().then((v) => {
            slag = v
            sub.next(v)
            sub.complete()
          })
        }),
    }

    await lastValueFrom(interceptor.intercept(ctx, next as never))
    expect(slag).toBe('HUMAN')
  })

  it('MOTPROV: en OAUTENTISERAD request sätter ingen kontext', async () => {
    const interceptor = new ActorInterceptor()
    const ctx = { switchToHttp: () => ({ getRequest: () => ({}) }) } as never
    let slag: string | null = 'kördes-aldrig'
    const next = {
      handle: () =>
        new Observable<unknown>((sub) => {
          void skrivOchLäs().then((v) => {
            slag = v
            sub.next(v)
            sub.complete()
          })
        }),
    }
    await lastValueFrom(interceptor.intercept(ctx, next as never))
    expect(slag).toBeNull()
  })

  it('SYSTEMGRÄNSEN: runCronSafely → SYSTEM', async () => {
    const slag = await runCronSafely('prov', async () => skrivOchLäs())
    expect(slag).toBe('SYSTEM')
  })

  it('AGENTGRÄNSEN: runAsAi → AGENT', async () => {
    const slag = await runWithEffectCollector(() =>
      runAsAi(randomUUID(), { kind: 'USER', id: userId }, async () => skrivOchLäs()),
    )
    expect(slag).toBe('AGENT')
  })

  it('AGENT VINNER ÖVER HUMAN — den innersta kontexten avgör', async () => {
    // En AI-körning sker INUTI en människas request. Kolumnen ska säga vem som
    // UTFÖRDE, inte vem som var inloggad. Vinner den yttre blir varje
    // AI-skriven rad märkt som människoskriven, och hela G1 är ogjort.
    const slag = await runWithActor('HUMAN', () =>
      runWithEffectCollector(() =>
        runAsAi(randomUUID(), { kind: 'USER', id: userId }, async () => skrivOchLäs()),
      ),
    )
    expect(slag).toBe('AGENT')
  })

  it('UPPDATERING STÄMPLAR INTE OM — kolumnen bär vem som SKAPADE raden', async () => {
    // Beslutet i extensionens docblock: stämplade `update` också, hade en cron
    // som rör en rad raderat människan som skapade den.
    const t = await runWithActor('HUMAN', async () =>
      prisma.maintenanceTicket.create({
        data: {
          organizationId: orgId,
          propertyId,
          unitId,
          ticketNumber: `FA-${orgId.slice(0, 4)}-u${++n}`,
          title: 'x',
          description: 'x',
          category: 'PLUMBING',
          priority: 'LOW',
        },
        select: { id: true },
      }),
    )
    await runCronSafely('prov', async () =>
      prisma.maintenanceTicket.update({ where: { id: t.id }, data: { title: 'ändrad av cron' } }),
    )
    const efter = await prisma.maintenanceTicket.findUniqueOrThrow({
      where: { id: t.id },
      select: { actorKind: true, title: true },
    })
    expect(efter).toEqual({ actorKind: 'HUMAN', title: 'ändrad av cron' })
  })

  it('EN OSTÄMPLAD MODELL rörs inte — mängden är härledd, inte allomfattande', async () => {
    // `AiToolExecution` har ingen kolumn. Stämplade extensionen blint hade den
    // här skrivningen kastat på en okänd kolumn.
    const e = await runWithActor('SYSTEM', async () =>
      prisma.aiToolExecution.create({
        data: { organizationId: orgId, toolName: 'x', toolInput: {}, success: true, durationMs: 1 },
        select: { id: true },
      }),
    )
    expect(e.id).toBeTruthy()
  })
})
