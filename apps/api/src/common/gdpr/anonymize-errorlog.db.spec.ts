/**
 * NÅR AVIDENTIFIERINGEN FAKTISKT `ErrorLog`? (#612)
 *
 * ── VARFÖR EN EGEN RIGG MOT RIKTIG POSTGRES ─────────────────────────────────
 *
 * Steget är en RÅ SQL-fråga (`position(… in "context"::text)`), och det är just
 * den sortens kod en attrapp inte kan pröva: en mockad Prisma-klient hade
 * bekräftat att funktionen anropas, inte att frågan matchar rätt rader. `::text`
 * på en `jsonb`-kolumn och `position()` på ett `@db.Text`-fält är Postgres-
 * beteende, inte Prisma-beteende.
 *
 * ── NEGATIVKONTROLL (mätt, se PR-texten) ────────────────────────────────────
 *
 * Tas anropet `purgeTenantErrorLogRows` bort ur `anonymizeTenantWithin` blir
 * "avidentifieringen tar felraderna" RÖD medan riggens direktanrop på funktionen
 * fortsätter vara grön. Det är avsiktligt: de två testerna svarar på olika
 * frågor — GÖR frågan rätt sak, och ÄR den påkopplad — och det är den andra som
 * historiskt går sönder tyst (`scrubAiTenantLinks` fanns i månader innan någon
 * märkte att kaskaden aldrig fyrade).
 *
 * ── VAD RIGGEN INTE SER ─────────────────────────────────────────────────────
 *
 * Den prövar UUID-matchningen. En rad som nämner hyresgästen enbart med namn
 * eller e-post träffas varken av koden eller av det här testet — det är den
 * uttryckliga gränsen i `purgeTenantErrorLogRows` docblock, och svaret på den
 * resten är fristen i `error-log-retention.ts`.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { anonymizeTenantWithin, purgeTenantErrorLogRows } from './anonymize-tenant'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('avidentifiering når ErrorLog (#612)', () => {
  const prisma = new PrismaClient()
  const märke = `QQ612A-${randomUUID()}`

  let orgId: string
  let tenantId: string
  let annanTenantId: string

  // RIGGEN SKAPAR SIN EGEN ORGANISATION — se motiveringen i
  // `error-log-retention.db.spec.ts`. En rigg som lånar omgivningens data mäter
  // omgivningen: den här lydelsen ersatte en `organization.findFirst()` som var
  // grön lokalt och röd i CI, där databasen är tom.
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: `${märke}-org`,
        email: `${märke}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Stockholm',
        postalCode: '11122',
      },
    })
    orgId = org.id
  })

  // Städordningen följer FK-riktningen: loggposten pekar på både hyresgäst och
  // organisation, felraderna på organisationen. Restrict, inte Cascade.
  afterEach(async () => {
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    await prisma.tenantAnonymizationLog.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { email: { startsWith: märke.toLowerCase() } } })
  })

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  async function nyHyresgäst(suffix: string): Promise<string> {
    const t = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Sond',
        lastName: suffix,
        email: `${märke.toLowerCase()}-${suffix}@exempel.invalid`,
      },
    })
    return t.id
  }

  /** De tre formerna ett tenant-id kan stå i, plus en rad som INTE ska röras. */
  async function såFelrader(): Promise<void> {
    await prisma.errorLog.createMany({
      data: [
        {
          // a) strukturerad pekare — skrivs av tenant-activation-reminders
          message: `${märke}::context-tenantId`,
          severity: 'CRITICAL',
          source: 'API',
          context: { cron: 'tenant-activation-reminders', tenantId },
        },
        {
          // b) id:t i URL:en — en 500 på GET /v1/tenants/<id>
          message: `${märke}::context-path`,
          severity: 'CRITICAL',
          source: 'API',
          context: { path: `/v1/tenants/${tenantId}`, method: 'GET' },
        },
        {
          // c) id:t i fritexten — t.ex. ett Prisma-fel som skriver ut argumentet
          message: `${märke}::message-fritext — misslyckades för ${tenantId}`,
          severity: 'ERROR',
          source: 'API',
          context: {},
        },
        {
          // d) en ANNAN hyresgästs rad — får INTE försvinna
          message: `${märke}::annan-hyresgast`,
          severity: 'ERROR',
          source: 'API',
          context: { tenantId: annanTenantId },
        },
        {
          // e) en rad utan någon hyresgäst alls — får INTE försvinna
          message: `${märke}::ingen-hyresgast`,
          severity: 'WARNING',
          source: 'WEB',
          context: { path: '/v1/health' },
        },
      ],
    })
  }

  async function kvar(): Promise<string[]> {
    const rows = await prisma.errorLog.findMany({
      where: { message: { contains: märke } },
      select: { message: true },
    })
    return rows.map((r) => r.message.split('::')[1]?.split(' ')[0] ?? r.message).sort()
  }

  beforeEach(async () => {
    tenantId = await nyHyresgäst('mal')
    annanTenantId = await nyHyresgäst('annan')
    await såFelrader()
  })

  it('funktionen tar ALLA tre formerna — och LÄMNAR de två andra raderna', async () => {
    const antal = await prisma.$transaction((tx) => purgeTenantErrorLogRows(tx, tenantId))

    expect(antal).toBe(3)
    expect(await kvar()).toEqual(['annan-hyresgast', 'ingen-hyresgast'])
  })

  it('PÅKOPPLINGEN: en verklig avidentifiering tar felraderna', async () => {
    await prisma.$transaction((tx) =>
      anonymizeTenantWithin(tx, tenantId, orgId, { performedById: null }),
    )

    expect(await kvar()).toEqual(['annan-hyresgast', 'ingen-hyresgast'])
  })

  it('är idempotent: en andra körning tar noll rader', async () => {
    await prisma.$transaction((tx) =>
      anonymizeTenantWithin(tx, tenantId, orgId, { performedById: null }),
    )
    const andra = await prisma.$transaction((tx) => purgeTenantErrorLogRows(tx, tenantId))

    expect(andra).toBe(0)
  })
})
