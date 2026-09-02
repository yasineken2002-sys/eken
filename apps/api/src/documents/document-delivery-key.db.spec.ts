/**
 * LEVERANSNYCKELN: MOTTAGAREN OCH INNEHÅLLET — mot riktig Postgres.
 *
 * ── VAD SOM VAR TRASIGT ─────────────────────────────────────────────────────
 *
 * `storageKey` var `documents/<org>/<uuid()>_<filnamn>`. `Document` bär
 * `@@unique([organizationId, storageKey])`, men en färsk uuid per anrop gör att
 * villkoret aldrig kan slå till. Spärren var inte frånvarande — den var
 * BESEGRAD av nyckelvalet, och varje omkörning gav hyresgästen ett dokument
 * till i portalen.
 *
 * ── VARFÖR MOTTAGAREN MÅSTE IN I NYCKELN ────────────────────────────────────
 *
 * Det andra provet nedan är hela skälet. En ren innehållshash hade kolliderat
 * när SAMMA fil skickas till TVÅ hyresgäster — ett informationsbrev till alla i
 * huset är normalfallet — och hyresgäst nummer två hade tyst blivit utan sitt
 * dokument. Det är den för grova nämnaren som är värre än ingen nämnare alls:
 * inget felmeddelande, inget spår, och en mottagare som saknar ett dokument
 * ingen vet att hen skulle ha fått.
 *
 * ── ORDNINGEN BLEV ETT KRAV AV NYCKELN ──────────────────────────────────────
 *
 * Uppladdning före `create` var ofarligt så länge nyckeln var slumpad: två
 * anrop kunde per konstruktion aldrig träffa samma objekt. Att göra nyckeln
 * härledd INFÖR kollisionen som möjlighet — och därmed också #641:s
 * överskrivning, om ordningen fått stå kvar. Provet på anropsföljden finns
 * därför här och inte som en efterhandsfråga.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Lagringen är en dubbel som bokför anrop. Databasraderna är riktiga; R2 är
 * det inte, och notifieringsmejlet är avstängt (`notify` utelämnat).
 */
// De riktiga klasserna drar in ESM-beroenden jest inte kan läsa (S3-klienten).
// Attrapperna ersätter bara KONSTRUKTORERNA — instanserna vi matar in nedan är
// våra egna dubbletter, och prisma är på riktigt.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { DocumentDeliveryService } from './document-delivery.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('deliverToTenant — nyckeln bär mottagaren och innehållet', () => {
  let prisma: PrismaClient
  let orgId: string
  const tenantIds: string[] = []

  /** Bokför HELA anropsföljden — ordningen går inte att mäta på sluttillståndet. */
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

  const byggService = (lagring: ReturnType<typeof byggLagring>) => {
    // Anspråket bokförs i SAMMA logg som uppladdningen, så ordningen mellan dem
    // blir mätbar. Proxyn lämnar allt annat orört.
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
    })
    return new DocumentDeliveryService(
      prismaLoggande as never,
      lagring as never,
      { sendCustomEmail: async () => 'msg' } as never,
    )
  }

  const leverera = (
    service: DocumentDeliveryService,
    tenantId: string,
    innehåll: string,
    namn = 'Information till boende',
  ) =>
    service.deliverToTenant({
      organizationId: orgId,
      tenantId,
      content: Buffer.from(innehåll, 'utf8'),
      fileName: 'info.pdf',
      name: namn,
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `lev-${sfx}`,
        email: `lev-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    for (let i = 0; i < 2; i++) {
      const t = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: `Hyres${i}`,
          lastName: 'Gäst',
          email: `lev-t${i}-${sfx}@example.se`,
        },
        select: { id: true },
      })
      tenantIds.push(t.id)
    }
  }, 30_000)

  beforeEach(async () => {
    // Varje prov börjar utan dokument — annars mäter prov två sitt eget spår
    // från prov ett i stället för koden.
    await prisma.document.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const raderIOrg = () =>
    prisma.document.findMany({
      where: { organizationId: orgId },
      select: { tenantId: true, storageKey: true },
    })

  it('SAMMA fil till TVÅ hyresgäster ger TVÅ objekt och TVÅ rader', async () => {
    // Det för grova alternativet — en ren innehållshash — hade gett EN rad här,
    // och hyresgäst två hade tyst blivit utan sitt dokument.
    const lagring = byggLagring()
    const service = byggService(lagring)

    await leverera(service, tenantIds[0]!, 'samma byten')
    await leverera(service, tenantIds[1]!, 'samma byten')

    const rader = await raderIOrg()
    expect(rader).toHaveLength(2)
    expect(new Set(rader.map((r) => r.tenantId)).size).toBe(2)
    expect(new Set(rader.map((r) => r.storageKey)).size).toBe(2)
    expect(lagring.objekt.size).toBe(2)
  })

  it('SAMMA fil till SAMMA hyresgäst två gånger ger EN rad, ETT objekt och EN uppladdning', async () => {
    const lagring = byggLagring()
    const service = byggService(lagring)

    const a = await leverera(service, tenantIds[0]!, 'samma byten')
    const b = await leverera(service, tenantIds[0]!, 'samma byten')

    // Samma dokument tillbaka — inte ett nytt.
    expect(b.documentId).toBe(a.documentId)
    expect(await raderIOrg()).toHaveLength(1)
    // Och den andra körningen rörde inte lagringen alls: anspråket föll först.
    expect(lagring.logg.filter((p) => p.startsWith('put:'))).toHaveLength(1)
  })

  it('en omkörning skickar INGEN andra notis — utskicket följer dokumentet', async () => {
    // Nyckeln dedupar raden. Gjorde den inte samma sak med utskicket vore
    // halva jobbet gjort: hyresgästen får ett andra mejl om ett dokument som
    // inte är nytt, och det är just den dubblett en människa utanför systemet
    // ser. Mejlen räknas här, inte i lagringsdubbeln.
    const lagring = byggLagring()
    const mejl: string[] = []
    const prismaVanlig = prisma as unknown as never
    const service = new DocumentDeliveryService(
      prismaVanlig,
      lagring as never,
      {
        sendCustomEmail: async (o: { to: string }) => {
          mejl.push(o.to)
          return 'msg'
        },
      } as never,
    )

    const skicka = () =>
      service.deliverToTenant({
        organizationId: orgId,
        tenantId: tenantIds[0]!,
        content: Buffer.from('samma byten', 'utf8'),
        fileName: 'info.pdf',
        name: 'Information till boende',
        notify: true,
      })

    await skicka()
    await skicka()

    expect(await raderIOrg()).toHaveLength(1)
    expect(mejl).toHaveLength(1)
  })

  it('OLIKA innehåll till samma hyresgäst ger TVÅ rader — nyckeln är inte bara mottagaren', async () => {
    const lagring = byggLagring()
    const service = byggService(lagring)

    await leverera(service, tenantIds[0]!, 'första brevet')
    await leverera(service, tenantIds[0]!, 'andra brevet')

    expect(await raderIOrg()).toHaveLength(2)
    expect(lagring.objekt.size).toBe(2)
  })

  it('ORDNINGEN: inga bytes skrivs innan raden finns, och inget objekt skrivs över', async () => {
    const lagring = byggLagring()
    const service = byggService(lagring)

    await leverera(service, tenantIds[0]!, 'samma byten')
    await leverera(service, tenantIds[1]!, 'samma byten')
    await leverera(service, tenantIds[0]!, 'samma byten')

    for (const [i, post] of lagring.logg.entries()) {
      if (!post.startsWith('put:')) continue
      const nyckel = post.slice(4)
      const anspråk = lagring.logg.indexOf(`claim:${nyckel}`)
      expect(anspråk).toBeGreaterThanOrEqual(0)
      expect(anspråk).toBeLessThan(i)
    }
    const puts = lagring.logg.filter((p) => p.startsWith('put:'))
    expect(new Set(puts).size).toBe(puts.length)
  })

  it('KLIENTENS FILNAMN når aldrig lagringsnyckeln', async () => {
    // Samma felklass som den borttagna kontraktsnyckeln: ett namn med
    // snedstreck skrev ett extra katalogsteg in i R2-sökvägen. Ändelsen härleds
    // ur mimetypen via den delade `extensionForDetectedMime`.
    const lagring = byggLagring()
    const service = byggService(lagring)

    await service.deliverToTenant({
      organizationId: orgId,
      tenantId: tenantIds[0]!,
      content: Buffer.from('nyttolast', 'utf8'),
      fileName: '../../etc/passwd',
      name: 'Ett dokument',
    })

    const [rad] = await raderIOrg()
    expect(rad!.storageKey).not.toContain('passwd')
    expect(rad!.storageKey).not.toContain('..')
    expect(rad!.storageKey).toBe(
      `documents/${orgId}/${tenantIds[0]}/${rad!.storageKey.split('/').pop()}`,
    )
  })
})
