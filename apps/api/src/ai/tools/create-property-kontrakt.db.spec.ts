/**
 * F056 — AI-VERKTYGETS SKAPA-VÄG GÅR GENOM SAMMA SAKREGLER SOM HTTP-VÄGEN.
 *
 * ── VAD SOM MÄTS, OCH VARFÖR MOT EN RIKTIG DATABAS ──────────────────────────
 *
 * HTTP-vägens skydd ligger i `CreatePropertyDto` och ValidationPipe. Verktyget
 * anropar `PropertiesService.create` DIREKT och passerar alltså varken DTO:n
 * eller pipen — fram till den här rättningen castades modellens värden i
 * stället: `name: toolInput.name as string`. Ett cast gör ingen kontroll, så ett
 * namn på 201 tecken och postnumret "abc" blev NYA rader som samma formulär
 * sedan inte kan redigera. Det är exakt den rad F056 finns för att förhindra.
 *
 * Ett prov mot en attrapp hade inte kunnat skilja "avvisad" från "skrev inget
 * eftersom attrappen inte kan skriva". Därför RIKTIG Prisma mot en RIKTIG
 * syntetisk PostgreSQL, och därför är assertionen ANTALET RADER — inte bara
 * svaret. Skyddet ska ligga FÖRE DB-effekten, inte efter.
 *
 * Kedjan som körs är produktionens: `executeToolUnsafe` → `case
 * 'create_property'` → `PropertiesService.create` → Prisma → rad. Ingen modell
 * och inga externa anrop ingår; verktygsindata byggs syntetiskt i filen.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaService } from '../../common/prisma/prisma.service'
import { PropertiesService } from '../../properties/properties.service'
import { ToolExecutorService } from './tool-executor.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

type Utfall = { success: boolean; message?: string }

medDb('F056: create_property genom verktyget', () => {
  let prisma: PrismaService
  let körVerktyg: (input: Record<string, unknown>) => Promise<Utfall>
  let orgId: string
  let annanOrgId: string

  const indata = (extra: Record<string, unknown> = {}) => ({
    name: `Torget ${randomUUID().slice(0, 6)}`,
    propertyDesignation: `T ${randomUUID().slice(0, 6)}`,
    type: 'RESIDENTIAL',
    street: 'Storgatan 1',
    city: 'Ort',
    postalCode: '11111',
    ...extra,
  })

  const antalRader = (organizationId = orgId) =>
    prisma.property.count({ where: { organizationId } })

  const skapaOrg = async () => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `f056-verktyg-${sfx}`,
        email: `f056-verktyg-${sfx}@example.invalid`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    return org.id
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    const propertiesService = new PropertiesService(prisma)
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { prisma, propertiesService })
    const unsafe = (
      executor as unknown as {
        executeToolUnsafe: (
          t: string,
          i: Record<string, unknown>,
          o: string,
          u: string | null,
          r: string,
        ) => Promise<Utfall>
      }
    ).executeToolUnsafe.bind(executor)
    körVerktyg = (input) => unsafe('create_property', input, orgId, 'f056-user', 'OWNER')

    orgId = await skapaOrg()
    annanOrgId = await skapaOrg()
  }, 60_000)

  afterEach(async () => {
    await prisma.property.deleteMany({
      where: { organizationId: { in: [orgId, annanOrgId] } },
    })
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.property.deleteMany({
        where: { organizationId: { in: [orgId, annanOrgId] } },
      })
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, annanOrgId].filter(Boolean) } },
      })
      await prisma.$disconnect()
    }
  })

  it('F056 avvisar ett 201-teckensnamn från verktyget före DB-effekt', async () => {
    const r = await körVerktyg(indata({ name: 'N'.repeat(201) }))
    expect(r.success).toBe(false)
    expect(r.message).toContain('Namn får ha högst 200 tecken')
    expect(r.message).toContain('name')
    expect(await antalRader()).toBe(0)
  })

  it('F056 avvisar postnummer "abc" från verktyget före DB-effekt', async () => {
    const r = await körVerktyg(indata({ postalCode: 'abc' }))
    expect(r.success).toBe(false)
    expect(r.message).toContain('Ogiltigt postnummer')
    expect(r.message).toContain('postalCode')
    expect(await antalRader()).toBe(0)
  })

  it.each([
    ['tomt namn', { name: '' }, 'Namn krävs'],
    ['tom beteckning', { propertyDesignation: '   ' }, 'Fastighetsbeteckning krävs'],
    ['tom gata', { street: '' }, 'Gatuadress krävs'],
    ['tom stad', { city: '' }, 'Stad krävs'],
    ['postnummer utanför intervallet', { postalCode: '98500' }, 'Ogiltigt postnummer'],
  ])('F056 avvisar %s före DB-effekt', async (_etikett, extra, text) => {
    const r = await körVerktyg(indata(extra))
    expect(r.success).toBe(false)
    expect(r.message).toContain(text)
    expect(await antalRader()).toBe(0)
  })

  /**
   * KANARIEFÅGEL MOT INSTRUMENTET. Proven ovan är gröna även om riggen aldrig
   * nådde verktyget — ett `{ success: false }` kan komma från vad som helst.
   * Det här kräver att ett GILTIGT anrop tar en ANNAN väg och faktiskt SKRIVER
   * raden. Faller det mäter proven ovan ingenting.
   */
  it('F056 ett giltigt verktygsanrop skapar fortfarande fastigheten', async () => {
    const giltig = indata()
    const r = await körVerktyg(giltig)
    expect(r.success).toBe(true)
    expect(r.message).toContain(giltig.name)
    const rad = await prisma.property.findFirstOrThrow({
      where: { organizationId: orgId, name: giltig.name },
    })
    expect(rad.postalCode).toBe('11111')
    expect(rad.country).toBe('SE')
    expect(Number(rad.totalArea)).toBe(1)
  })

  it('F056 organisationsgränsen håller — raden hamnar inte hos någon annan', async () => {
    await körVerktyg(indata())
    expect(await antalRader(orgId)).toBe(1)
    expect(await antalRader(annanOrgId)).toBe(0)
  })
})
