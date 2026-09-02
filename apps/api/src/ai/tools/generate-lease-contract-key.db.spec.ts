/**
 * `generate_lease_contract`: TVÅ AVTAL FÖR SAMMA HYRESGÄST SAMMA DAG — mot riktig Postgres.
 *
 * ── VAD SOM VAR TRASIGT ─────────────────────────────────────────────────────
 *
 * Lagringsnyckeln var `kontrakt_<hyresgästnamn>_<datum>.pdf` och bar inte
 * `leaseId`. En hyresgäst med både lägenhet och p-plats — vardagsmat i
 * onboarding — fick båda kontrakten på samma nyckel, och eftersom
 * uppladdningen låg FÖRE `document.create` blev utfallet:
 *
 *     avtal A → PUT K            → Document(leaseId = A)
 *     avtal B → PUT SAMMA K      → A:s bytes överskrivna
 *             → create ger P2002 → ingen rad för B
 *
 * Alltså fel bindande handling under fel avtal, i hyresgästportalen, och ett
 * verktygssvar som sa "fanns redan — ingen dubblett skapades" om en fil det
 * just hade förstört.
 *
 * ── PROVET ÄR SKRIVET SÅ ATT DET SÄGER VILKET KRAV SOM BRISTER ──────────────
 *
 * Tre krav, tre namngivna prov. En rättning som bara löser ett av dem ska
 * göra det synligt VILKET som står kvar, i stället för att ge ett rött prov
 * som kräver läsning för att tolkas:
 *
 *   KRAV 1  nyckeln får inte kunna kollidera mellan två avtal
 *   KRAV 2  inga bytes får skrivas innan raden finns (anspråk före innehåll)
 *   KRAV 3  svaret får aldrig påstå "fanns redan" om något skrevs över
 *
 * De två första är oberoende, och det är avsiktligt: med rätt ORDNING men fel
 * NYCKEL sker ingen överskrivning (anspråket faller först) — avtal B blir bara
 * utan dokument. Det är därför båda proven behövs, och därför ett av dem inte
 * kan ersätta det andra.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Lagringen är en dubbel som BOKFÖR anrop, inte riktig R2. Provet mäter vilka
 * nycklar som skrivs, i vilken ordning, och med vilket innehåll — det säger
 * ingenting om att R2 faktiskt lagrar det, och inget om PDF:ens utseende.
 * Databasraderna är däremot riktiga.
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

medDb('generate_lease_contract — lagringsnyckeln identifierar avtalet', () => {
  let prisma: PrismaService
  let audit: AiAuditService
  let orgId: string
  let userId: string
  let tenantId: string
  const leaseIds: string[] = []
  const unitIds: string[] = []
  let propertyId: string

  /**
   * Lagringsdubbel som bokför HELA anropsföljden, inte bara sluttillståndet.
   * Ordningskravet går inte att mäta på ett slutresultat: efter en
   * överskrivning ser lagringen likadan ut som efter en enda skrivning.
   */
  const byggLagring = () => {
    const logg: string[] = []
    const objekt = new Map<string, string>()
    return {
      logg,
      objekt,
      getPresignedUrl: async (key: string) => `https://r2.example/${key}`,
      uploadFile: async (buf: Buffer, key: string) => {
        logg.push(`put:${key}`)
        objekt.set(key, buf.toString('utf8'))
        return `https://r2.example/${key}`
      },
    }
  }

  /** PDF-dubbel som ger UNIKA bytes per avtal, så förväxling går att se. */
  const byggPdf = (märke: () => string) => ({
    generateFromHtml: async () => Buffer.from(märke(), 'utf8'),
  })

  const byggExecutor = (
    lagring: ReturnType<typeof byggLagring>,
    pdf: { generateFromHtml: () => Promise<Buffer> },
  ) => {
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    // Prisma-dubbeln bokför anspråket i SAMMA logg som uppladdningen, så
    // ordningen mellan dem blir mätbar.
    const prismaLoggande = new Proxy(prisma, {
      get(mål, prop: string | symbol) {
        if (prop !== 'document') return Reflect.get(mål, prop) as unknown
        return new Proxy(prisma.document, {
          get(dmål, dprop: string | symbol) {
            if (dprop !== 'create') return Reflect.get(dmål, dprop) as unknown
            return async (args: { data: { storageKey: string } }) => {
              lagring.logg.push(`claim:${args.data.storageKey}`)
              return (prisma.document.create as (a: unknown) => Promise<unknown>)(args)
            }
          },
        })
      },
    }) as PrismaService

    Object.assign(executor, {
      prisma: prismaLoggande,
      audit,
      storage: lagring,
      pdfService: pdf,
      logger: new Logger('spec'),
    })
    return executor
  }

  const kör = (executor: ToolExecutorService, leaseId: string) =>
    executor.executeTool(
      'generate_lease_contract',
      { leaseId, contractType: 'RESIDENTIAL' },
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
        name: `kontrakt-${sfx}`,
        email: `kontrakt-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `kontrakt-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'K',
        lastName: 'T',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Eva',
        lastName: 'Ek',
        email: `kontrakt-t-${sfx}@example.se`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `EKEN ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id

    // TVÅ enheter, samma hyresgäst — lägenheten och p-platsen. Det är hela
    // premissen: samma visningsnamn, samma dag, två olika avtal.
    for (const [i, namn] of ['Lägenhet 1101', 'P-plats 12'].entries()) {
      const unit = await prisma.unit.create({
        data: {
          propertyId,
          name: namn,
          unitNumber: `${1101 + i}`,
          type: i === 0 ? 'APARTMENT' : 'PARKING',
          area: 60 - i * 50,
          rooms: 2,
          monthlyRent: 9000 - i * 8000,
        },
        select: { id: true },
      })
      unitIds.push(unit.id)
      const lease = await prisma.lease.create({
        data: {
          organizationId: orgId,
          tenantId,
          unitId: unit.id,
          contractNumber: `HK-${sfx}-${i}`,
          monthlyRent: 9000 - i * 8000,
          depositAmount: 0,
          startDate: new Date('2026-09-01'),
          tenancyStartDate: new Date('2026-09-01'),
          status: 'DRAFT',
        },
        select: { id: true },
      })
      leaseIds.push(lease.id)
    }
  })

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
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

  // Varje prov börjar utan dokument. Utan det här bygger prov två på prov ett:
  // andra körningen ser sitt eget spår från den första och rapporterar
  // "genererades redan" — riggen hade då mätt sin egen ordningsföljd i stället
  // för koden, och det är samma defekt som en rigg som lånar omgivningens data.
  beforeEach(async () => {
    await prisma.document.deleteMany({ where: { organizationId: orgId } })
  })

  /** Kör båda avtalen i följd med samma lagring — "samma dag" per definition. */
  const körBådaAvtalen = async () => {
    const lagring = byggLagring()
    let aktuellt = ''
    const pdf = byggPdf(() => `PDF-FÖR-${aktuellt}`)
    const svar: Array<{ success: boolean; message?: string }> = []
    for (const leaseId of leaseIds) {
      aktuellt = leaseId
      svar.push(await kör(byggExecutor(lagring, pdf), leaseId))
    }
    const rader = await prisma.document.findMany({
      where: { organizationId: orgId, category: 'CONTRACT' },
      select: { leaseId: true, storageKey: true },
    })
    return { lagring, svar, rader }
  }

  it('KRAV 1: två avtal för samma hyresgäst samma dag ger två nycklar, två objekt och två rader', async () => {
    const { lagring, rader } = await körBådaAvtalen()

    const nycklar = [...lagring.objekt.keys()]
    expect(nycklar).toHaveLength(2)
    expect(new Set(nycklar).size).toBe(2)
    expect(rader).toHaveLength(2)
    expect(new Set(rader.map((r) => r.leaseId)).size).toBe(2)

    // Rätt innehåll i vardera — det är förväxlingen som var skadan, inte
    // antalet rader. Varje avtals rad ska peka på ETT objekt som bär just
    // det avtalets bytes.
    for (const rad of rader) {
      expect(lagring.objekt.get(rad.storageKey)).toBe(`PDF-FÖR-${rad.leaseId}`)
    }
  })

  it('KRAV 2: inga bytes skrivs innan raden finns, och inget objekt skrivs över', async () => {
    const { lagring } = await körBådaAvtalen()

    // Varje PUT måste föregås av sitt eget anspråk. Med den gamla ordningen
    // (upload före create) står `put:` först i loggen och provet faller här.
    for (const [i, post] of lagring.logg.entries()) {
      if (!post.startsWith('put:')) continue
      const nyckel = post.slice(4)
      const anspråk = lagring.logg.indexOf(`claim:${nyckel}`)
      expect(anspråk).toBeGreaterThanOrEqual(0)
      expect(anspråk).toBeLessThan(i)
    }

    // Och ingen nyckel får skrivas två gånger — en överskrivning syns inte i
    // sluttillståndet, bara i anropsföljden.
    const puts = lagring.logg.filter((p) => p.startsWith('put:'))
    expect(new Set(puts).size).toBe(puts.length)
  })

  it('KRAV 3: svaret påstår aldrig "fanns redan" när något skapades', async () => {
    const { svar, rader } = await körBådaAvtalen()

    expect(svar.every((s) => s.success)).toBe(true)
    expect(rader).toHaveLength(2)
    // Båda avtalen fick ett eget dokument, alltså får inget av svaren säga att
    // det redan fanns.
    //
    // Provet biter även med den gamla nyckeln men RÄTT ordning, och det är
    // avsiktligt: då skrivs ingenting över, men avtal B:s svar säger ändå att
    // ett kontrakt "för det här avtalet" redan genererats — medan raden som
    // fanns tillhörde avtal A. Påståendet är osant om VILKET avtal, inte om
    // huruvida något skrevs. Kontraktsnumret står i texten just för att den
    // osanningen ska gå att se.
    for (const s of svar) {
      expect(s.message).not.toMatch(/fanns redan|genererades redan/i)
    }
  })

  it('MOTPROV: ett äkta omtag på SAMMA avtal skapar inget nytt och säger det sant', async () => {
    // Utan det här provet skulle "skapa alltid ett nytt dokument" passera de
    // tre kraven ovan. Dedupen måste finnas kvar — den var aldrig felet.
    const lagring = byggLagring()
    const pdf = byggPdf(() => `PDF-FÖR-${leaseIds[0]}`)

    const första = await kör(byggExecutor(lagring, pdf), leaseIds[0]!)
    const andra = await kör(byggExecutor(lagring, pdf), leaseIds[0]!)

    expect(första.success).toBe(true)
    expect(andra.success).toBe(true)
    expect(första.message).not.toMatch(/genererades redan/i)
    expect(andra.message).toMatch(/genererades redan i dag/i)

    const rader = await prisma.document.findMany({
      where: { organizationId: orgId, category: 'CONTRACT', leaseId: leaseIds[0]! },
      select: { id: true },
    })
    expect(rader).toHaveLength(1)
    // Och omtaget rörde inte lagringen alls — anspråket föll först.
    expect(lagring.logg.filter((p) => p.startsWith('put:'))).toHaveLength(1)
  })
})
