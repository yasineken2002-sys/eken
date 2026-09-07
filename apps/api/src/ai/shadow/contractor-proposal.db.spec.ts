/**
 * HANTVERKARFÖRSLAGET MOT EN RIKTIG DATABAS.
 *
 * Agenten får föreslå en hantverkare BARA ur organisationens eget register,
 * filtrerat på ärendets kategori. Två av de tre grinderna går inte att pröva
 * utan en riktig databas:
 *
 *   ORGANISATIONEN  menyn byggs ur en org-avgränsad `findMany`. En attrapp
 *                   returnerar det den blev tillsagd oavsett `where`, alltså
 *                   hade provet varit grönt även om avgränsningen tappats.
 *   KATEGORIN       `Contractor.categories` är en array-kolumn; filtret är en
 *                   ren funktion, men att posterna FINNS med rätt kategorier
 *                   är en egenskap hos raderna.
 *
 * Den tredje — att ett id utanför menyn inte lagras — prövas mot samma rader.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer, egna hantverkare i var och en. Städning i FK-riktning,
 * prövad mot en TOM databas och körd TVÅ gånger mot samma.
 */
import { randomUUID } from 'node:crypto'

import { PrismaService } from '../../common/prisma/prisma.service'
import { godkandHantverkare, hantverkarmeny, type Hantverkarpost } from './contractor-menu'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('hantverkarförslaget', () => {
  let prisma: PrismaService
  let orgId: string
  let annanOrgId: string
  let rorId: string
  let elId: string
  let frammandeRorId: string

  /** Menyn byggd ur PRODUKTIONENS väg: org-avgränsad läsning + ren filterfunktion. */
  const menyFor = async (org: string, kategori: string) => {
    const register = await prisma.contractor.findMany({
      where: { organizationId: org, isActive: true },
      select: { id: true, name: true, categories: true },
      orderBy: { name: 'asc' },
    })
    return hantverkarmeny(register as Hantverkarpost[], kategori as never)
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    const sfx = randomUUID().slice(0, 8)
    const skapaOrg = async (namn: string) =>
      (
        await prisma.organization.create({
          data: {
            name: `${namn}-${sfx}`,
            email: `${namn}-${sfx}@example.invalid`,
            street: 'a',
            city: 'b',
            postalCode: '11111',
          },
          select: { id: true },
        })
      ).id
    orgId = await skapaOrg('hv')
    annanOrgId = await skapaOrg('hv-annan')

    const skapaHantverkare = async (org: string, name: string, categories: string[]) =>
      (
        await prisma.contractor.create({
          data: { organizationId: org, name, categories: categories as never },
          select: { id: true },
        })
      ).id
    rorId = await skapaHantverkare(orgId, 'Nilssons Rör AB', ['PLUMBING'])
    elId = await skapaHantverkare(orgId, 'Elfirman AB', ['ELECTRICAL'])
    frammandeRorId = await skapaHantverkare(annanOrgId, 'Andra Orgs Rör AB', ['PLUMBING'])
  }, 60_000)

  afterAll(async () => {
    for (const org of [orgId, annanOrgId]) {
      await prisma.contractor.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
    }
    await prisma.$disconnect()
  })

  // ── 1. RÄTT ORG, RÄTT KATEGORI → ACCEPTERAS ────────────────────────────
  it('en hantverkare ur RÄTT org och RÄTT kategori accepteras', async () => {
    const meny = await menyFor(orgId, 'PLUMBING')
    expect(meny.map((m) => m.id)).toEqual([rorId])
    expect(godkandHantverkare(rorId, meny)).toBe(rorId)
    // ETIKETTEN BÄR BETYDELSE, inte bara ett id — samma lärdom som
    // verktygsmenyn: ett naket UUID går bara att gissa på.
    expect(meny[0]!.etikett).toContain('Nilssons Rör AB')
    expect(meny[0]!.etikett).toContain('PLUMBING')
  })

  // ── 2. ANNAN ORGS HANTVERKARE → AVVISAS FÖRE LAGRING ───────────────────
  it('en ANNAN organisations hantverkare avvisas', async () => {
    const meny = await menyFor(orgId, 'PLUMBING')
    // Samma yrke, samma kategori — det ENDA som skiljer är organisationen.
    expect(godkandHantverkare(frammandeRorId, meny)).toBeUndefined()
  })

  // NEGATIVKONTROLL: i SIN EGEN organisation är exakt samma id giltigt. Utan
  // den kan avvisningen bero på att id:t inte finns alls i stället för på
  // org-gränsen — och då mäter provet ingenting.
  it('NEGATIVKONTROLL: samma hantverkare är giltig i SIN EGEN org', async () => {
    const meny = await menyFor(annanOrgId, 'PLUMBING')
    expect(godkandHantverkare(frammandeRorId, meny)).toBe(frammandeRorId)
  })

  // ── 3. FEL KATEGORI → AVVISAS ──────────────────────────────────────────
  it('en hantverkare med FEL yrke avvisas', async () => {
    const meny = await menyFor(orgId, 'ELECTRICAL')
    // Rörmokaren finns i organisationen men gör inte eljobb.
    expect(godkandHantverkare(rorId, meny)).toBeUndefined()
  })

  // NEGATIVKONTROLL: elektrikern går igenom på samma ärende. Utan den kan
  // avvisningen bero på att menyn är tom.
  it('NEGATIVKONTROLL: rätt yrke går igenom på samma kategori', async () => {
    const meny = await menyFor(orgId, 'ELECTRICAL')
    expect(meny.map((m) => m.id)).toEqual([elId])
    expect(godkandHantverkare(elId, meny)).toBe(elId)
  })

  // ── 4. TOM MENY ────────────────────────────────────────────────────────
  it('en kategori UTAN hantverkare ger tom meny, och allt avvisas', async () => {
    const meny = await menyFor(orgId, 'CLEANING')
    expect(meny).toEqual([])
    expect(godkandHantverkare(rorId, meny)).toBeUndefined()
    expect(godkandHantverkare(elId, meny)).toBeUndefined()
  })

  // ── 5. `OTHER` ÄR FRÅNVARON AV EN KATEGORI ─────────────────────────────
  it('OTHER ger HELA registret — inte en tom meny', async () => {
    const meny = await menyFor(orgId, 'OTHER')
    expect(meny.map((m) => m.id).sort()).toEqual([rorId, elId].sort())
    // …men fortfarande bara den EGNA organisationens.
    expect(godkandHantverkare(frammandeRorId, meny)).toBeUndefined()
  })

  // ── 6. AVAKTIVERAD FALLER UR ───────────────────────────────────────────
  it('en AVAKTIVERAD hantverkare försvinner ur menyn', async () => {
    await prisma.contractor.update({ where: { id: elId }, data: { isActive: false } })
    try {
      const meny = await menyFor(orgId, 'ELECTRICAL')
      expect(meny).toEqual([])
      expect(godkandHantverkare(elId, meny)).toBeUndefined()
    } finally {
      // ÅTERSTÄLLS i finally: nästa körning mot samma databas ska inte ärva
      // det här provets tillstånd. Riggen städar sina egna förutsättningar.
      await prisma.contractor.update({ where: { id: elId }, data: { isActive: true } })
    }
  })

  // ── 7. SKRÄP ───────────────────────────────────────────────────────────
  it('fritext, tom sträng och fel typ avvisas', async () => {
    const meny = await menyFor(orgId, 'PLUMBING')
    for (const skräp of ['', 'Nilssons Rör AB', randomUUID(), null, undefined, 42, {}]) {
      expect(godkandHantverkare(skräp, meny)).toBeUndefined()
    }
    // …och det GILTIGA id:t går fortfarande igenom, så provet ovan inte är
    // grönt av att funktionen avvisar allt.
    expect(godkandHantverkare(rorId, meny)).toBe(rorId)
  })
})
