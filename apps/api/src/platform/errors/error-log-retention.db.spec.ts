/**
 * GALLRINGEN AV `ErrorLog` — PRÖVAD I BÅDA RIKTNINGARNA (#612).
 *
 * ── VARFÖR BÅDA RIKTNINGARNA ────────────────────────────────────────────────
 *
 * En gallring utan prov är en cron som KANSKE kör. Men ett prov som bara visar
 * att rätt rader försvinner är halva svaret, och den sämre halvan: en gallring
 * som tar för mycket är värre än ingen gallring alls — den förstör underlag
 * tyst, och ingen upptäcker det förrän någon letar efter en rad som skulle ha
 * funnits.
 *
 * Riggen sätter därför ut rader på BÅDA sidor om varje gräns och kräver ett
 * exakt sluttillstånd, inte bara ett antal.
 *
 * ── DEN SKARPA RADEN ────────────────────────────────────────────────────────
 *
 * `olöst-mitt-emellan` är hela poängen: en OLÖST rad som är äldre än den LÖSTA
 * fristen men yngre än den olösta. Den enda buggen som är verkligt sannolik här
 * — att en frist används för båda hinkarna, eller att `resolved`-villkoret
 * faller bort — raderar just den raden och inga andra. Ett prov utan den hade
 * varit grönt för den buggen.
 *
 * ÅLDERN OCH NAMNEN ÄR HÄRLEDDA, INTE SKRIVNA. Raden hette tidigare
 * `olöst-100d` med åldern 100 hårdkodad — sant så länge den olösta fristen var
 * 180, falskt i samma sekund den sänktes till 90 (2026-09-02): en 100 dagar
 * gammal rad ligger då PÅ FEL SIDA om gränsen, och den skarpa raden hade tyst
 * slutat vara skarp. Åldern räknas därför mitt emellan fristerna, och
 * kanariefågeln nedan kräver att den ligger strikt mellan dem — annars mäter
 * riggen ingenting och säger det.
 *
 * ── VAD RIGGEN INTE SER ─────────────────────────────────────────────────────
 *
 * Att cron-dekoratorn är påkopplad och att schemat är rätt ägs av
 * `check-cron-classification.mjs` och `check-cron-error-sink.mjs`. Den här filen
 * anropar `runRetention` direkt och skulle vara grön även om `@Cron` togs bort.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { ErrorLogRetentionService } from './error-log-retention.service'
import { RESOLVED_RETENTION_DAYS, UNRESOLVED_RETENTION_DAYS } from './error-log-retention'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })

  it('KANARIEFÅGEL: fristerna är olika — annars mäter riggen ingen differentiering', () => {
    expect(RESOLVED_RETENTION_DAYS).toBeLessThan(UNRESOLVED_RETENTION_DAYS)
  })

  it('KANARIEFÅGEL: den skarpa radens ålder ligger STRIKT mellan fristerna', () => {
    // Utan den här faller riggens skärpa tyst om fristerna kryper ihop: en
    // mittpunkt som sammanfaller med en gräns prövar inte längre att hinkarna
    // hålls isär, och alla övriga påståenden förblir gröna.
    expect(MITT_EMELLAN_DAGAR).toBeGreaterThan(RESOLVED_RETENTION_DAYS)
    expect(MITT_EMELLAN_DAGAR).toBeLessThan(UNRESOLVED_RETENTION_DAYS)
  })
})

const DYGN = 24 * 60 * 60 * 1000

/**
 * Den skarpa radens ålder: mitt emellan fristerna, aldrig ett skrivet tal.
 *
 * Samma skäl som `cutoffFor` exporteras för produktionskoden — ett prov som
 * räknar sin egen gräns bevisar bara att två uträkningar råkar stämma överens
 * i dag.
 */
const MITT_EMELLAN_DAGAR = Math.round((RESOLVED_RETENTION_DAYS + UNRESOLVED_RETENTION_DAYS) / 2)

medDb('ErrorLog-gallring (#612)', () => {
  const prisma = new PrismaClient()
  const märke = `QQ612-${randomUUID()}`
  const nu = new Date('2026-09-01T12:00:00.000Z')

  /** Rader satta ut på båda sidor om båda gränserna. */
  const RADER = [
    // NAMNEN BÄR INGA TAL. De hette tidigare 'löst-31d', 'olöst-179d' och så
    // vidare — sant mot 30/180, falskt mot 30/90, och ett namn som ljuger om
    // sitt eget värde är värre än inget namn: felutskriften pekar då ut en rad
    // som inte finns. Åldern härleds ur konstanten, namnet säger bara sidan.
    {
      namn: 'löst-över-frist',
      resolved: true,
      ålderDagar: RESOLVED_RETENTION_DAYS + 1,
      orgLös: false,
      skaBort: true,
    },
    {
      namn: 'löst-under-frist',
      resolved: true,
      ålderDagar: RESOLVED_RETENTION_DAYS - 1,
      orgLös: false,
      skaBort: false,
    },
    {
      namn: 'olöst-över-frist',
      resolved: false,
      ålderDagar: UNRESOLVED_RETENTION_DAYS + 1,
      orgLös: false,
      skaBort: true,
    },
    {
      namn: 'olöst-under-frist',
      resolved: false,
      ålderDagar: UNRESOLVED_RETENTION_DAYS - 1,
      orgLös: false,
      skaBort: false,
    },
    // DEN SKARPA: äldre än lösta fristen, yngre än olösta. Ska STANNA.
    {
      namn: 'olöst-mitt-emellan',
      resolved: false,
      ålderDagar: MITT_EMELLAN_DAGAR,
      orgLös: false,
      skaBort: false,
    },
    // Utan organisation — dessa var odödliga före #612 (enda raderingsvägen
    // matchade på organizationId).
    {
      namn: 'löst-över-frist-utan-org',
      resolved: true,
      ålderDagar: RESOLVED_RETENTION_DAYS + 1,
      orgLös: true,
      skaBort: true,
    },
    {
      namn: 'olöst-under-frist-utan-org',
      resolved: false,
      ålderDagar: UNRESOLVED_RETENTION_DAYS - 1,
      orgLös: true,
      skaBort: false,
    },
  ] as const

  let orgId: string

  const nyckel = (namn: string) => `${märke}::${namn}`

  async function såRader(): Promise<void> {
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    for (const r of RADER) {
      await prisma.errorLog.create({
        data: {
          severity: 'ERROR',
          source: 'API',
          message: nyckel(r.namn),
          resolved: r.resolved,
          createdAt: new Date(nu.getTime() - r.ålderDagar * DYGN),
          ...(r.orgLös ? {} : { organizationId: orgId }),
        },
      })
    }
  }

  async function kvarvarande(): Promise<string[]> {
    const rows = await prisma.errorLog.findMany({
      where: { message: { contains: märke } },
      select: { message: true },
    })
    return rows.map((r) => r.message.split('::')[1] ?? r.message).sort()
  }

  const service = () => new ErrorLogRetentionService(prisma as never, null as never)

  // RIGGEN SKAPAR SIN EGEN ORGANISATION.
  //
  // Första lydelsen lånade `organization.findFirst()` — den råkade vara grön
  // lokalt, där dev-databasen har data, och föll i CI där den är tom. En rigg
  // som lånar omgivningens data mäter omgivningen, inte koden: den kan bli grön
  // av fel skäl och röd av fel skäl, och lokal grönska bevisar då mindre än den
  // ser ut att göra. Samma mönster som `cron-error-sink-e2e.db.spec.ts` följer.
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

  afterAll(async () => {
    // ErrorLog FÖRE Organization: FK:n är Restrict, inte Cascade.
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  beforeEach(såRader)

  it('tar bort exakt de rader som passerat SIN frist', async () => {
    await service().runRetention('enforce', nu)

    const skaFinnasKvar = RADER.filter((r) => !r.skaBort)
      .map((r) => r.namn)
      .sort()
    expect(await kvarvarande()).toEqual(skaFinnasKvar)
  })

  it('LÄMNAR KVAR raderna som inte passerat sin frist — inklusive den olösta mitt-emellan-raden', async () => {
    await service().runRetention('enforce', nu)
    const kvar = await kvarvarande()

    // Riktningen som gör "för mycket" synlig. Skrivs som enskilda påståenden
    // och inte bara som en mängdjämförelse, så att ett fel pekar ut VILKEN rad.
    expect(kvar).toContain('olöst-mitt-emellan')
    expect(kvar).toContain('löst-under-frist')
    expect(kvar).toContain('olöst-under-frist')
    expect(kvar).toContain('olöst-under-frist-utan-org')
  })

  it('tar rader UTAN organisation — de föll tidigare utanför allt', async () => {
    const utfall = await service().runRetention('enforce', nu)

    expect(await kvarvarande()).not.toContain('löst-över-frist-utan-org')
    // Och att de RÄKNAS som sådana i rapporten, inte bara råkar försvinna.
    const löst = utfall.buckets.find((b) => b.bucket === 'resolved')
    expect(löst?.utanOrganisation).toBeGreaterThanOrEqual(1)
  })

  it('dry-run räknar samma rader men raderar ingenting', async () => {
    const torr = await service().runRetention('dry-run', nu)
    const allaKvar = RADER.map((r) => r.namn).sort()
    expect(await kvarvarande()).toEqual(allaKvar)

    const skarp = await service().runRetention('enforce', nu)
    expect(skarp.total).toBe(torr.total)
    expect(torr.total).toBe(RADER.filter((r) => r.skaBort).length)
  })

  it('är idempotent: en andra körning träffar noll rader (klass B-invarianten)', async () => {
    await service().runRetention('enforce', nu)
    const andra = await service().runRetention('enforce', nu)
    expect(andra.total).toBe(0)
  })
})
