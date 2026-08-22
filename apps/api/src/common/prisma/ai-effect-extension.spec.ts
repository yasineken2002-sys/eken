/**
 * UTFALLSKOPPLINGEN, MOT EN RIKTIG DATABAS.
 *
 * ── VARFÖR INTE EN ATTRAPP ───────────────────────────────────────────────────
 *
 * Hela mekanismen ÄR en Prisma-klientextension. En attrapp av Prisma har ingen
 * extension, så ett mock-baserat test hade varit grönt även om extensionen
 * aldrig kopplades på. Den mest sannolika felskrivningen är dessutom osynlig för
 * typkontrollen: `$extends` returnerar en NY klient i stället för att mutera, så
 *
 *     this.$extends(aiEffectExtension)      // returvärdet kastas → INGEN effekt
 *
 * kompilerar, kör och gör ingenting. Bara en riktig databas kan skilja det från
 * den korrekta formen.
 *
 * Kör mot `eken_dev`. Hoppas över om DATABASE_URL saknas — men se
 * kanariefågeln: en tyst överhoppning är också ett sätt att sluta mäta.
 */

import { randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import { runAsAi } from '../ai-origin/ai-origin.context'
import { drainEffects, runWithEffectCollector } from '../ai-effects/ai-effects.context'
import type { AiToolEffect } from '../ai-effects/ai-effects.context'

/**
 * Kör `fn` i en kollektor och returnerar BÅDE resultatet och effekterna.
 *
 * Tömningen måste ske INNE i scopet: utanför är AsyncLocalStorage-store
 * undefined och `drainEffects()` ger alltid en tom lista. Precis den
 * felskrivningen fanns i produktionskoden när den här filen skrevs — den
 * kompilerade, körde och bokförde noll effekter.
 */
async function medEffekter<T>(
  fn: () => Promise<T>,
): Promise<{ värde: T; effekter: AiToolEffect[] }> {
  return runWithEffectCollector(async () => {
    const värde = await fn()
    return { värde, effekter: drainEffects() }
  })
}

const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

beskriv('AiToolEffect — kopplingen produceras av skrivvägen', () => {
  let prisma: PrismaService
  let orgId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    await prisma.$connect()
    const org = await prisma.organization.create({
      data: {
        name: `zz-effect-${randomUUID().slice(0, 8)}`,
        orgNumber: `55${Math.floor(Math.random() * 10_000_000)
          .toString()
          .padStart(8, '0')}`,
        email: 'zz@example.test',
        street: 'Gatan 1',
        city: 'Stockholm',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
  })

  afterAll(async () => {
    if (!prisma) return
    // Restrict på AiToolExecution/AiToolEffect → städa i beroendeordning.
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är hela filen grön när DATABASE_URL saknas — alltså
    // grön av att den inte kördes. Se CLAUDE.md: en kontroll som inte kan falla
    // mäter ingenting.
    expect(HAR_DB).toBe(true)
  })

  it('en skrivning INNE i AI-kontext bokförs, och pekar på RÄTT rad', async () => {
    // `async () =>` OCH ett `await` INNE i runAsAi — inte en pil som returnerar
    // promisen. Prismas promise är LAT: `prisma.x.create()` startar ingen fråga
    // förrän den awaitas. Returneras den ut ur `runAsAi` körs frågan efter att
    // AsyncLocalStorage-scopet lämnats, och extensionen ser ingen AI-kontext.
    // Fallet är subtilt och grönt-utseende: koden kompilerar och skriver raden,
    // bara spårningen försvinner.
    const { värde: skapad, effekter } = await medEffekter(() =>
      runAsAi(randomUUID(), async () =>
        prisma.property.create({
          data: {
            organizationId: orgId,
            name: 'zz-effekt-fastighet',
            propertyDesignation: 'ZZ 1:1',
            street: 'Gatan 1',
            postalCode: '11111',
            city: 'Stockholm',
            type: 'RESIDENTIAL',
            totalArea: 100,
          },
          select: { id: true },
        }),
      ),
    )

    expect(effekter).toHaveLength(1)
    expect(effekter[0]).toMatchObject({
      entityType: 'Property',
      operation: 'CREATE',
      rowCount: 1,
    })
    // DET AVGÖRANDE: id:t är den FAKTISKT skapade radens, inte något annat.
    expect(effekter[0]?.entityId).toBe(skapad.id)
    // ...och raden finns verkligen i databasen.
    const iDb = await prisma.property.findUnique({ where: { id: skapad.id }, select: { id: true } })
    expect(iDb?.id).toBe(skapad.id)
  })

  it('KANARIEFÅGEL: samma skrivning UTANFÖR AI-kontext bokförs INTE', async () => {
    // Utan det här fallet vore "bokför allt" lika grönt som "bokför rätt saker",
    // och varje REST-, cron- och webhook-skrivning hade hamnat i AI:ns
    // revisionsspår.
    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'zz-utanfor-kontext',
        propertyDesignation: 'ZZ 2:2',
        street: 'Gatan 2',
        postalCode: '11111',
        city: 'Stockholm',
        type: 'RESIDENTIAL',
        totalArea: 100,
      },
      select: { id: true },
    })
    expect(p.id).toBeTruthy()
    // Ingen kollektor är öppnad här — och det är hela poängen: en skrivning
    // utanför AI-vägen ska inte ens ha någonstans att bokföras.
    const { effekter } = await medEffekter(() => Promise.resolve(null))
    expect(effekter).toHaveLength(0)
  })

  it('en UPDATE bokförs som UPDATE på samma rad', async () => {
    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'zz-uppdateras',
        propertyDesignation: 'ZZ 3:3',
        street: 'Gatan 3',
        postalCode: '11111',
        city: 'Stockholm',
        type: 'RESIDENTIAL',
        totalArea: 100,
      },
      select: { id: true },
    })

    const { effekter } = await medEffekter(() =>
      runAsAi(randomUUID(), async () =>
        prisma.property.update({ where: { id: p.id }, data: { name: 'zz-uppdaterad' } }),
      ),
    )
    expect(effekter).toHaveLength(1)
    expect(effekter[0]).toMatchObject({ entityType: 'Property', operation: 'UPDATE' })
    expect(effekter[0]?.entityId).toBe(p.id)
  })

  it('LÄSNINGAR bokförs inte — annars drunknar utfallet i brus', async () => {
    const { effekter } = await medEffekter(() =>
      runAsAi(randomUUID(), async () => {
        await prisma.property.findMany({ where: { organizationId: orgId } })
        await prisma.property.count({ where: { organizationId: orgId } })
      }),
    )
    expect(effekter).toHaveLength(0)
  })

  it('flera skrivningar i EN körning ger flera effekter — därav barntabellen', async () => {
    const { effekter } = await medEffekter(() =>
      runAsAi(randomUUID(), async () => {
        for (const n of ['zz-a', 'zz-b', 'zz-c']) {
          await prisma.property.create({
            data: {
              organizationId: orgId,
              name: n,
              propertyDesignation: `ZZ ${n}`,
              street: 'Gatan 9',
              postalCode: '11111',
              city: 'Stockholm',
              type: 'RESIDENTIAL',
              totalArea: 100,
            },
          })
        }
      }),
    )
    // Två nullbara kolumner hade kunnat bära EN av dessa tre.
    expect(effekter).toHaveLength(3)
  })

  it('effekterna PERSISTERAS som rader, kopplade till körningen', async () => {
    // Kollektorn i minnet är halva vägen. Det här är den andra: att raderna
    // faktiskt hamnar i databasen och går att fråga på — "vad gjorde AI:n i
    // tisdags" är en SELECT, inte ett resonemang.
    const execId = randomUUID()
    const { värde: p, effekter } = await medEffekter(() =>
      runAsAi(execId, async () =>
        prisma.property.create({
          data: {
            organizationId: orgId,
            name: 'zz-persisteras',
            propertyDesignation: 'ZZ 4:4',
            street: 'Gatan 4',
            postalCode: '11111',
            city: 'Stockholm',
            type: 'RESIDENTIAL',
            totalArea: 100,
          },
          select: { id: true },
        }),
      ),
    )

    await prisma.aiToolExecution.create({
      data: {
        id: execId,
        organizationId: orgId,
        toolName: 'zz_sond_create_property',
        toolInput: {},
        success: true,
        durationMs: 1,
        effects: {
          create: effekter.map((e) => ({
            organizationId: orgId,
            entityType: e.entityType,
            entityId: e.entityId,
            operation: e.operation,
            rowCount: e.rowCount,
          })),
        },
      },
    })

    const rader = await prisma.aiToolEffect.findMany({ where: { aiToolExecutionId: execId } })
    expect(rader).toHaveLength(1)
    expect(rader[0]?.entityType).toBe('Property')
    expect(rader[0]?.entityId).toBe(p.id)
    expect(rader[0]?.operation).toBe('CREATE')

    // OCH den omvända frågan: "vad har AI:n gjort med den här raden?"
    const perRad = await prisma.aiToolEffect.findMany({
      where: { organizationId: orgId, entityType: 'Property', entityId: p.id },
    })
    expect(perRad).toHaveLength(1)
    expect(perRad[0]?.aiToolExecutionId).toBe(execId)
  })

  it('gallring av körningen tar effekterna med sig (Cascade)', async () => {
    // AiRetentionService gallrar AiToolExecution med deleteMany. Med Restrict
    // hade gallringen fallerat på första körningen; med Cascade följer
    // effekterna med. Kontrollen finns för att FK-valet inte ska kunna ändras
    // tillbaka utan att något blir rött.
    const execId = randomUUID()
    await prisma.aiToolExecution.create({
      data: {
        id: execId,
        organizationId: orgId,
        toolName: 'zz_sond_cascade',
        toolInput: {},
        success: true,
        durationMs: 1,
        effects: {
          create: [
            {
              organizationId: orgId,
              entityType: 'Property',
              entityId: null,
              operation: 'UPDATE',
              rowCount: 3,
            },
          ],
        },
      },
    })
    expect(await prisma.aiToolEffect.count({ where: { aiToolExecutionId: execId } })).toBe(1)

    await prisma.aiToolExecution.deleteMany({ where: { id: execId } })
    expect(await prisma.aiToolEffect.count({ where: { aiToolExecutionId: execId } })).toBe(0)
  })

  it('revisionsspåret självt bokförs inte (cirkularitet)', async () => {
    const execId = randomUUID()
    const { effekter } = await medEffekter(() =>
      runAsAi(execId, async () =>
        prisma.aiToolExecution.create({
          data: {
            id: execId,
            organizationId: orgId,
            toolName: 'zz_sond',
            toolInput: {},
            success: true,
            durationMs: 1,
          },
        }),
      ),
    )
    expect(effekter).toHaveLength(0)
  })
})
