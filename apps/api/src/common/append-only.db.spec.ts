/**
 * SPÄRREN MÅSTE GÄLLA, INTE BARA FINNAS I EN MIGRATION.
 *
 * `check-append-only.mjs` håller två härledda mängder lika: modeller som SÄGER
 * append-only i schemat, och tabeller som HAR en trigger i migrationerna. Den är
 * statisk och kan därför bara se att spärren är skriven.
 *
 * Att den GÄLLER i en levande databas är en annan fråga, och den ägs här. En
 * migration som aldrig kördes, en trigger som någon inaktiverat med
 * `ALTER TABLE … DISABLE TRIGGER`, eller en `session_replication_role = 'replica'`
 * — inget av det syns i en filsökning.
 *
 * ── VARFÖR TRIGGER OCH INTE REVOKE ──────────────────────────────────────────
 *
 * Mätt mot prod: appen ansluter som `postgres`, som både ÄGER alla tabeller och
 * är SUPERUSER. `REVOKE` gäller inte ägaren, och en superuser förbigår
 * rättighetskontrollen helt. Testet nedan mäter den skillnaden direkt, i samma
 * läge som prod, så påståendet inte behöver tros på.
 *
 * ── DELETE ÄR MED FLIT INTE SPÄRRAD ─────────────────────────────────────────
 *
 * `scripts/delete-organization.ts` raderar fem av tabellerna, och AI-retentionen
 * gallrar andra loggar. En full spärr hade brutit organisationsraderingen — och
 * det hade upptäckts först vid en GDPR-begäran. Testet nedan kräver därför att
 * DELETE fortfarande fungerar; en framtida "härdning" som spärrar den blir röd.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/**
 * Tabellerna med en append-only-trigger. Listan är AVSIKTLIGT skriven här och
 * inte härledd: vakten äger härledningen (schema ↔ migration), specen äger
 * frågan "gäller den?". Härledde specen också sin egen mängd skulle båda kunna
 * krympa samtidigt utan att något blev rött.
 */
const SKYDDADE = [
  'AccountingPeriodEvent',
  // Etapp 7 (G2). Delegationens livshistoria — och sanningskällan för dess
  // status, som BERÄKNAS ur just de här raderna. Går de att skriva om går det
  // inte att svara på "hade agenten rätt när den gjorde detta i mars", och
  // planen kräver uttryckligen att historiken kan bevisa att delegationen
  // existerade. Satsnivå räcker: enda FK:n (delegationId) är CASCADE, och
  // `actorUserId` är en NAKEN kolumn utan relation just för att en raderad
  // användare inte ska kunna skriva om historiken via en SET NULL.
  'AiDelegationEvent',
  'FailedEmail',
  'InvoiceEvent',
  'PiiSecretRotation',
  'RentNoticeCredit',
  'RentNoticeEvent',
  'SignatureEvidence',
  'TenantAnonymizationLog',
  // Etapp 1b. Enda källan till att ett utrustningsbyte skett — det finns ingen
  // domänrad att jämföra mot, till skillnad från avier och fakturor. En ändrad
  // rad här är därför inte en felaktig kopia utan en felaktig historia.
  // Satsnivå räcker: dess enda nullbara FK (maintenanceTicketId) är RESTRICT
  // just för att ingen kaskad-UPDATE ska kunna nå hit.
  'UnitEquipmentEvent',
  // #704 PR 1. Raden bär tidpunkten då ett räkenskapsår låstes och verifikatet
  // som låste det. Går den att UPDATE:a går årsstängningen att flytta i
  // efterhand — precis det ett revisionsspår ska omöjliggöra. Radnivå och
  // aktörsvarianten, eftersom closedById är ON DELETE SET NULL från User.
  'FiscalYearClose',
] as const

/**
 * De två som tar emot en `ON DELETE SET NULL` från User — alltså en kaskad-
 * UPDATE utförd av databasen. De har radnivå-trigger med ett undantag för exakt
 * den förändringen; de övriga sex har satsnivå.
 *
 * Konsekvensen för TESTET: en radnivå-trigger fyrar inte på en UPDATE som
 * matchar noll rader, så de två måste ha en rad att röra.
 */
const MED_KASKADUNDANTAG: Record<string, string> = {
  AccountingPeriodEvent: 'actorUserId',
  TenantAnonymizationLog: 'performedById',
  FiscalYearClose: 'closedById',
}

medDb('append-only-spärren i databasen', () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = new PrismaClient()
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('KANARIEFÅGEL: anslutningen är ägare (annars mäter testet fel läge)', async () => {
    // Är testanvändaren INTE ägare kan en REVOKE ha stoppat skrivningen, och då
    // säger ett grönt resultat ingenting om triggern.
    const rader = await prisma.$queryRawUnsafe<Array<{ ager: boolean }>>(
      `select bool_and(c.relowner = (select oid from pg_roles where rolname = current_user)) as ager
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    )
    expect(rader[0]?.ager).toBe(true)
  })

  it('varje skyddad tabell HAR en aktiv BEFORE UPDATE-trigger i databasen', async () => {
    const rader = await prisma.$queryRawUnsafe<Array<{ tabell: string }>>(
      `select c.relname as tabell
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgname like 'append\\_only\\_%' and t.tgenabled <> 'D'`,
    )
    const funna = rader.map((r) => r.tabell).sort()
    expect(funna).toEqual([...SKYDDADE].sort())
  })

  it('(1) UPDATE mot en skyddad tabell MISSLYCKAS — mätt, inte antaget', async () => {
    // Går via en riktig UPDATE, inte via Prisma-modellen: poängen är att spärren
    // gäller för ALLA skrivvägar, även rå SQL.
    //
    // KOLUMNEN SLÅS UPP, INTE GISSAS. Första versionen skrev
    // `SET "createdAt" = now()` för alla åtta — men TenantAnonymizationLog har
    // ingen `createdAt`, och felet blev då `column … does not exist` i stället
    // för spärrens. Ett prov som faller på fel sak ser ut som blindhet i det som
    // prövas.
    //
    // Satsen är dessutom en självtilldelning: den skulle ändra ingenting om den
    // släpptes igenom. Det är spärren som ska stoppa den, inte otur.
    for (const tabell of SKYDDADE) {
      if (MED_KASKADUNDANTAG[tabell]) continue // prövas i eget test, med en rad
      const kol = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1
         order by ordinal_position limit 1`,
        tabell,
      )
      const namn = kol[0]?.column_name
      expect(namn).toBeTruthy()
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "${tabell}" SET "${namn}" = "${namn}"`),
      ).rejects.toThrow(/append-only/)
    }
  }, 60_000)

  it('(1b) de med kaskadundantag avvisar ALLT UTOM att aktören nollas', async () => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `ao3-${sfx}`,
        email: `ao3-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `ao3-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
      },
    })
    const ev = await prisma.accountingPeriodEvent.create({
      data: {
        organizationId: org.id,
        year: 2026,
        month: 1,
        seq: 1,
        type: 'CLOSED',
        actorType: 'USER',
        actorUserId: user.id,
      },
    })

    // Ett vanligt fältbyte avvisas.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "AccountingPeriodEvent" SET "type" = 'REOPENED' WHERE id = $1`,
        ev.id,
      ),
    ).rejects.toThrow(/append-only/)

    // Att nolla aktören OCH ändra något annat avvisas också — undantaget är
    // smalt med flit, annars vore det en generell lucka.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "AccountingPeriodEvent" SET "actorUserId" = NULL, "type" = 'REOPENED' WHERE id = $1`,
        ev.id,
      ),
    ).rejects.toThrow(/append-only/)

    // Men databasens egen ON DELETE SET NULL släpps igenom.
    await prisma.user.delete({ where: { id: user.id } })
    const efter = await prisma.accountingPeriodEvent.findUnique({ where: { id: ev.id } })
    expect(efter?.actorUserId).toBeNull()
    expect(efter?.type).toBe('CLOSED')

    // ── FiscalYearClose (#704 PR 1), samma undantag och samma smalhet ────────
    //
    // EGEN ANVÄNDARE: den ovan är redan raderad, och poängen här är att pröva
    // kaskaden en gång till — inte att ärva dess utfall.
    const user2 = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `ao3b-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'D',
      },
    })
    const fyc = await prisma.fiscalYearClose.create({
      data: { organizationId: org.id, fiscalYear: 2026, closedById: user2.id },
    })

    // Ett vanligt fältbyte avvisas — här: att flytta stängningen till ett annat år.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "FiscalYearClose" SET "fiscalYear" = 2027 WHERE id = $1`,
        fyc.id,
      ),
    ).rejects.toThrow(/append-only/)

    // Att nolla aktören OCH ändra något annat avvisas också.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "FiscalYearClose" SET "closedById" = NULL, "fiscalYear" = 2027 WHERE id = $1`,
        fyc.id,
      ),
    ).rejects.toThrow(/append-only/)

    // Databasens egen ON DELETE SET NULL släpps igenom.
    await prisma.user.delete({ where: { id: user2.id } })
    const fycEfter = await prisma.fiscalYearClose.findUnique({ where: { id: fyc.id } })
    expect(fycEfter?.closedById).toBeNull()
    expect(fycEfter?.fiscalYear).toBe(2026)

    await prisma.fiscalYearClose.deleteMany({ where: { organizationId: org.id } })
    await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }, 60_000)

  it('(3) INSERT är oförändrat', async () => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `ao-${sfx}`,
        email: `ao-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    const t = await prisma.tenant.create({
      data: { organizationId: org.id, type: 'INDIVIDUAL', email: `ao-${sfx}@example.se` },
    })
    const inv = await prisma.invoice.create({
      data: {
        organizationId: org.id,
        tenantId: t.id,
        invoiceNumber: `F-${sfx}`,
        type: 'RENT',
        issueDate: new Date(),
        dueDate: new Date(),
        subtotal: 1,
        vatTotal: 0,
        total: 1,
      },
    })
    const ev = await prisma.invoiceEvent.create({
      data: { invoiceId: inv.id, type: 'CREATED', actorType: 'USER' },
    })
    expect(ev.id).toBeTruthy()

    // (2) DELETE ska fortfarande fungera — organisationsraderingen behöver den.
    const borttagna = await prisma.invoiceEvent.deleteMany({ where: { invoiceId: inv.id } })
    expect(borttagna.count).toBe(1)

    await prisma.invoice.delete({ where: { id: inv.id } })
    await prisma.tenant.delete({ where: { id: t.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }, 60_000)

  it('NEGATIVKONTROLL: en OSKYDDAD tabell går fortfarande att uppdatera', async () => {
    // Utan den här raden är "UPDATE avvisades" lika förenligt med att
    // anslutningen saknar skrivrätt över huvud taget.
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `ao2-${sfx}`,
        email: `ao2-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    const efter = await prisma.organization.update({
      where: { id: org.id },
      data: { name: `ao2-${sfx}-ändrad` },
    })
    expect(efter.name).toContain('ändrad')
    await prisma.organization.delete({ where: { id: org.id } })
  }, 60_000)
})
