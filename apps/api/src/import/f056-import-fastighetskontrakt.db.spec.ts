/**
 * F056 · CSV-IMPORTEN SKAPAR INGA FASTIGHETER SOM PRODUKTEN INTE KAN REDIGERA
 *
 * ── VAD SOM MÄTS, OCH VARFÖR MOT EN RIKTIG DATABAS ──────────────────────────
 *
 * HTTP-vägen skyddas av `CreatePropertyDto` + pipen, och AI-verktyget av
 * `CreatePropertySchema`. Importen skrev fram till nu rakt in med
 * `prisma.property.create` och prövade bara att fälten FANNS — inte att värdena
 * dög. En CSV kunde därför skapa ett 201 tecken långt namn, postnumret `abc`
 * eller `totalArea: 0`, alltså rader som produktens eget redigeringsformulär
 * inte kan spara. Det är exakt den oändringsbara rad F056 finns för att
 * förhindra.
 *
 * Ett prov mot en attrapp hade inte kunnat skilja "avvisad" från "skrev inget
 * för att attrappen inte kan skriva". Därför RIKTIG Prisma mot en RIKTIG
 * syntetisk PostgreSQL, och därför är assertionen ANTALET RADER — inte bara
 * jobbets siffror.
 *
 * ── VAD SOM ÄR ÄKTA HÄR, OCH VAD SOM INTE ÄR DET ────────────────────────────
 *
 * ÄKTA: `ImportService.processImport` — alltså hela kedjan `parseFile` →
 * `normalizeHeaders` → `normalizeRow` → `importProperties` → Prisma — och
 * `previewImport`. Filerna byggs med MALLENS faktiska rubriker
 * (`downloadTemplate('PROPERTIES')`) och BOM, inte med handbyggda DTO:er.
 *
 * INTE ÄKTA: HTTP-gränsen. `POST /import/execute` med multipart, dess roller
 * (`ADMIN`/`OWNER`) och `@OrgId()` prövas inte här; organisationen skickas in
 * som argument precis som controllern gör det. Att en KOLUMN i filen inte kan
 * välja organisation prövas däremot nedan.
 *
 * INTE MÄTT HÄR: webbgränssnittet. Detta är inget browserprov.
 */
import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { CreatePropertySchema, UpdatePropertySchema } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { ImportService } from './import.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/** Exakt de rubriker `downloadTemplate('PROPERTIES')` skriver, med BOM. */
const MALLENS_RUBRIKER = 'Namn,Fastighetsbeteckning,Typ,Gatuadress,Postnummer,Stad,Yta m²,Byggår'
const BOM = '﻿'
const csv = (rader: string[], rubriker = MALLENS_RUBRIKER) =>
  Buffer.from(BOM + [rubriker, ...rader].join('\n') + '\n')

/** En giltig rad i mallens form; `over` byter ut enskilda kolumner. */
const rad = (over: Partial<Record<string, string>> = {}) => {
  const k = {
    namn: 'Ekhagen 1',
    beteckning: `F056 ${randomUUID()}`,
    typ: 'Bostad',
    gata: 'Storgatan 1',
    postnummer: '111 22',
    stad: 'Ort',
    yta: '850',
    byggår: '1999',
    ...over,
  }
  return `${k.namn},${k.beteckning},${k.typ},${k.gata},${k.postnummer},${k.stad},${k.yta},${k.byggår}`
}

medDb('F056: fastighetsimportens kontrakt', () => {
  let prisma: PrismaService
  let importService: ImportService
  let orgId: string
  let annanOrgId: string
  let userId: string

  const kor = (buffer: Buffer) =>
    importService.processImport(buffer, 'fastigheter.csv', 'PROPERTIES', orgId, userId)

  const rader = (organizationId = orgId) =>
    prisma.property.findMany({ where: { organizationId } })

  const skapaOrg = async (namn: string) => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${namn}-${sfx}`,
        email: `${namn}-${sfx}@example.invalid`,
        street: 'Provgatan 1',
        city: 'Provstad',
        postalCode: '11122',
      },
      select: { id: true },
    })
    return org.id
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    importService = new ImportService(prisma, {} as ConfigService, {} as never, {} as never)
    orgId = await skapaOrg('f056-import')
    annanOrgId = await skapaOrg('f056-import-annan')
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `f056-import-${randomUUID().slice(0, 8)}@example.invalid`,
        passwordHash: 'x',
        firstName: 'Ada',
        lastName: 'Ek',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
  }, 60_000)

  afterEach(async () => {
    await prisma.property.deleteMany({
      where: { organizationId: { in: [orgId, annanOrgId] } },
    })
    await prisma.importJob.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.property.deleteMany({
        where: { organizationId: { in: [orgId, annanOrgId] } },
      })
      await prisma.importJob.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, annanOrgId].filter(Boolean) } },
      })
      await prisma.$disconnect()
    }
  })

  // ── Det som INTE längre får skapas ────────────────────────────────────────

  it.each([
    ['namn på 201 tecken', { namn: 'N'.repeat(201) }, 'Namn'],
    ['postnummer abc', { postnummer: 'abc' }, 'Postnummer'],
    ['postnummer utanför intervallet', { postnummer: '98500' }, 'Postnummer'],
    ['tom yta', { yta: '' }, 'Yta m²'],
    ['yta 0', { yta: '0' }, 'Yta m²'],
    ['byggår före 1800', { byggår: '1500' }, 'Byggår'],
  ])('F056 importen avvisar %s och skapar ingen rad', async (_etikett, over, kolumn) => {
    const jobb = await kor(csv([rad(over)]))

    expect(jobb.successRows).toBe(0)
    expect(jobb.errorRows).toBe(1)
    expect(await rader()).toHaveLength(0)

    const fel = jobb.errors as unknown as { row: number; message: string }[]
    expect(fel).toHaveLength(1)
    expect(fel[0]!.row).toBe(2)
    // Begripligt svenskt rad-/fältfel som namnger MALLENS kolumn.
    expect(fel[0]!.message).toContain(kolumn)
  })

  it('F056 ingen trunkering, inget påhittat postnummer och ingen fallbackarea', async () => {
    await kor(csv([rad({ namn: 'N'.repeat(201), postnummer: 'abc', yta: '' })]))
    // Raden ska vara BORTA, inte lagrad i tillrättalagd form.
    expect(await rader()).toHaveLength(0)
  })

  // ── Det som MÅSTE fortsätta fungera ───────────────────────────────────────

  it('F056 en giltig rad importeras med oförändrade fältvärden', async () => {
    const jobb = await kor(csv([rad({ namn: 'Ekhagen 1', postnummer: '111 22', yta: '850' })]))

    expect(jobb.successRows).toBe(1)
    expect(jobb.errorRows).toBe(0)
    const lagrad = await rader()
    expect(lagrad).toHaveLength(1)
    expect(lagrad[0]!.name).toBe('Ekhagen 1')
    expect(lagrad[0]!.postalCode).toBe('111 22')
    expect(Number(lagrad[0]!.totalArea)).toBe(850)
    expect(lagrad[0]!.yearBuilt).toBe(1999)
    expect(lagrad[0]!.type).toBe('RESIDENTIAL')
    expect(lagrad[0]!.country).toBe('SE')
    expect(lagrad[0]!.organizationId).toBe(orgId)
  })

  /**
   * HELA POÄNGEN MED F056, mätt på en IMPORTERAD rad: den ska gå att redigera
   * med produktens egna fältregler efteråt.
   *
   * Detta är ett KONTRAKTSPROV mot de delade schemana, inte ett browserprov.
   * Att formuläret renderar rätt ägs av `PropertyForm.test.tsx`; att HTTP-PATCH
   * svarar 200 ägs av `properties-http.db.spec.ts`.
   */
  it('F056 en importerad rad klarar produktens edit-kontrakt', async () => {
    await kor(csv([rad()]))
    const lagrad = (await rader())[0]!

    const somFormuläretSkickar = {
      name: lagrad.name,
      propertyDesignation: lagrad.propertyDesignation,
      type: lagrad.type,
      address: {
        street: lagrad.street,
        city: lagrad.city,
        postalCode: lagrad.postalCode,
        country: lagrad.country,
      },
      totalArea: Number(lagrad.totalArea),
      ...(lagrad.yearBuilt !== null ? { yearBuilt: lagrad.yearBuilt } : {}),
    }

    expect(CreatePropertySchema.safeParse(somFormuläretSkickar).success).toBe(true)
    expect(UpdatePropertySchema.safeParse(somFormuläretSkickar).success).toBe(true)
  })

  // ── Importens BEFINTLIGA kontrakt ska inte bytas ut ───────────────────────

  it('F056 en blandad fil skriver de giltiga raderna och räknar de ogiltiga — inte allt-eller-inget', async () => {
    const jobb = await kor(
      csv([
        rad({ namn: 'Giltig ett' }),
        rad({ namn: 'N'.repeat(201) }),
        rad({ namn: 'Giltig två' }),
        rad({ postnummer: 'abc' }),
        rad({ namn: 'Giltig tre' }),
      ]),
    )

    expect(jobb.successRows).toBe(3)
    expect(jobb.errorRows).toBe(2)
    const namn = (await rader()).map((r) => r.name).sort()
    expect(namn).toEqual(['Giltig ett', 'Giltig tre', 'Giltig två'])
    // Körningen avbryts inte av en ogiltig rad: raden EFTER felen skrevs.
    expect(jobb.status).toBe('COMPLETED')
    const fel = jobb.errors as unknown as { row: number }[]
    expect(fel.map((f) => f.row).sort()).toEqual([3, 5])
  })

  it('F056 dubblett/återimport av samma beteckning ger befintligt fel och ingen andra rad', async () => {
    const beteckning = `F056 ${randomUUID()}`
    const första = await kor(csv([rad({ beteckning })]))
    expect(första.successRows).toBe(1)

    const andra = await kor(csv([rad({ beteckning, namn: 'Samma beteckning igen' })]))
    expect(andra.successRows).toBe(0)
    expect(andra.errorRows).toBe(1)
    const fel = andra.errors as unknown as { message: string }[]
    expect(fel[0]!.message).toContain(beteckning)
    expect(await rader()).toHaveLength(1)
  })

  it('F056 en kolumn i filen kan inte välja organisation', async () => {
    const jobb = await kor(
      csv(
        [`${rad()},${annanOrgId}`],
        `${MALLENS_RUBRIKER},organizationId`,
      ),
    )

    expect(jobb.successRows).toBe(1)
    expect(await rader(orgId)).toHaveLength(1)
    expect(await rader(annanOrgId)).toHaveLength(0)
  })

  // ── Preview och skrivning måste vara överens ──────────────────────────────

  it('F056 preview och skrivningen är överens om vilka rader som är giltiga', async () => {
    const buffer = csv([
      rad({ namn: 'Giltig' }),
      rad({ namn: 'N'.repeat(201) }),
      rad({ postnummer: 'abc' }),
      rad({ yta: '' }),
    ])

    const preview = importService.previewImport(buffer, 'fastigheter.csv', 'PROPERTIES')
    const jobb = await kor(buffer)

    expect(preview.validRows).toBe(jobb.successRows)
    expect(preview.errorRows).toBe(jobb.errorRows)
    expect(preview.validRows).toBe(1)
    expect(preview.errorRows).toBe(3)
    expect(await rader()).toHaveLength(1)
  })
})
