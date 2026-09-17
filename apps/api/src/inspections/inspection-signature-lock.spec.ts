/**
 * F025 — ETT SIGNERAT BESIKTNINGSPROTOKOLL GÅR INTE ATT ÄNDRA I EFTERHAND.
 *
 * Fyndet: `update`, `updateItem`, `analyze` och `delete` läste aldrig
 * besiktningens status. Efter att hyresgästen skrivit under kunde en post
 * vändas GOOD → DAMAGED med en reparationskostnad — det belopp ett
 * depositionsavdrag vilar på — och hela protokollet kunde raderas spårlöst.
 *
 * ── VAD DEN HÄR FILEN ÄGER, OCH VAD DEN INTE GÖR ────────────────────────────
 *
 * Här mäts FORMEN på spärren mot en stubbad prisma: att varje skrivväg frågar,
 * att den frågar i rätt ordning (lås före läsning), att tidpunkten kommer från
 * servern och att öppna protokoll fortfarande går att redigera.
 *
 * Att spärren HÅLLER mot två samtidiga transaktioner kan inte mätas här — en
 * stub har inga lås. Det ägs av `inspection-signature-lock.db.spec.ts`, som kör
 * mot riktig Postgres.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'

import { InspectionsService } from './inspections.service'
import {
  BESIKTNING_SIGNERAD_MEDDELANDE,
  buildSignedContent,
  computeSignedContentHash,
} from './inspection-signature'

type Läge = {
  status?: string
  signedAt?: Date | null
  finns?: boolean
}

const PLANERAT = new Date('2026-03-02T00:00:00.000Z')

function protokoll(över: Record<string, unknown> = {}) {
  return {
    id: 'insp-1',
    type: 'MOVE_OUT',
    scheduledDate: PLANERAT,
    completedAt: null,
    overallCondition: 'Godtagbart',
    notes: null,
    status: 'COMPLETED',
    signedAt: null,
    items: [
      {
        id: 'item-1',
        room: 'Kök',
        item: 'Golv',
        condition: 'GOOD',
        notes: null,
        repairCost: null,
      },
    ],
    images: [],
    ...över,
  }
}

function rigg(läge: Läge = {}) {
  const status = läge.status ?? 'COMPLETED'
  const signedAt = läge.signedAt ?? null
  const finns = läge.finns ?? true

  const anropsordning: string[] = []

  const prisma = {
    $queryRaw: jest.fn((...args: unknown[]) => {
      anropsordning.push(`queryRaw:${String((args[0] as string[])?.join('?'))}`)
      return Promise.resolve(finns ? [{ id: 'insp-1' }] : [])
    }),
    inspection: {
      // Två läsningar med olika form: spärrens smala `select` och signeringens
      // `include: FULL_INCLUDE` (innehållet FÖRE anropets egna ändringar).
      findFirst: jest.fn((args?: { include?: unknown }) => {
        anropsordning.push('inspection.findFirst')
        if (!finns) return Promise.resolve(null)
        if (args?.include) return Promise.resolve(protokoll({ status, signedAt }))
        return Promise.resolve({ id: 'insp-1', status, signedAt })
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        anropsordning.push('inspection.update')
        return Promise.resolve(protokoll({ status, ...args.data }))
      }),
      delete: jest.fn(() => {
        anropsordning.push('inspection.delete')
        return Promise.resolve({ id: 'insp-1' })
      }),
    },
    inspectionItem: {
      findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'item-1', room: 'Kök', item: 'Golv' }]),
      update: jest.fn((args: unknown) => {
        anropsordning.push('inspectionItem.update')
        void args
        return Promise.resolve({ id: 'item-1' })
      }),
      create: jest.fn(() => {
        anropsordning.push('inspectionItem.create')
        return Promise.resolve({ id: 'item-2' })
      }),
    },
    inspectionImage: {
      create: jest.fn(() => {
        anropsordning.push('inspectionImage.create')
        return Promise.resolve({ id: 'img-1' })
      }),
    },
    // Tilldelas efter objektet: `$transaction` kör återanropet mot samma stub,
    // och en självreferens inne i literalen gör typen implicit `any`.
    $transaction: undefined as unknown as jest.Mock,
  }
  prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma))

  const service = new InspectionsService(prisma as never, {} as never, {} as never)
  return { service, prisma, anropsordning }
}

const SIGNERAT: Läge = { status: 'SIGNED', signedAt: new Date('2026-03-04T10:00:00.000Z') }

/** Förutsättningen en klient hade fått ur `contentHash` vid läsning av `läge`. */
const förutsättning = (läge: Läge = {}) =>
  computeSignedContentHash(
    protokoll({ status: läge.status ?? 'COMPLETED', signedAt: läge.signedAt ?? null }) as never,
  )

// ════════════════════════════════════════════════════════════════════════════
// DET SOM VAR RÖTT FÖRE RÄTTNINGEN
// ════════════════════════════════════════════════════════════════════════════

describe('F025 — signerat protokoll är stängt för skrivning', () => {
  it('MANÖVERN UR FYNDET: vända en post GOOD → DAMAGED med belopp efter signering → nekas', async () => {
    const { service, prisma } = rigg(SIGNERAT)

    await expect(
      service.updateItem(
        'insp-1',
        'item-1',
        { condition: 'DAMAGED', repairCost: 18000 } as never,
        'org-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    // Ingenting skrevs. Det är hela poängen: ett nekande som ändå hinner skriva
    // är inget nekande.
    expect(prisma.inspectionItem.update).not.toHaveBeenCalled()
  })

  it('update() på ett signerat protokoll → nekas, ingen skrivning', async () => {
    const { service, prisma } = rigg(SIGNERAT)
    await expect(
      service.update('insp-1', { overallCondition: 'Omdömet ändrat' } as never, 'org-1'),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('delete() på ett signerat protokoll → nekas (A055:s skärpning: värre än att ändra)', async () => {
    const { service, prisma } = rigg(SIGNERAT)
    await expect(service.delete('insp-1', 'org-1')).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspection.delete).not.toHaveBeenCalled()
  })

  it('analysvägens SKRIVNING nekas — även om signeringen skedde under modellanropet', async () => {
    // Det här är fallet controllerns tidiga kontroll INTE fångar: besiktningen
    // var öppen när analysen började och signerades medan vision-modellen
    // arbetade. Kontrollen görs därför om vid skrivningen.
    const { service, prisma } = rigg(SIGNERAT)
    await expect(
      service.applyAnalysis('insp-1', 'org-1', {
        overallCondition: 'Skador i kök',
        notes: 'AI',
        items: [
          {
            room: 'Kök',
            item: 'Golv',
            condition: 'DAMAGED' as never,
            notes: null,
            repairCost: 9000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspectionItem.update).not.toHaveBeenCalled()
    expect(prisma.inspectionItem.create).not.toHaveBeenCalled()
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('analysens BILDER nekas också — bilden är en del av beviset', async () => {
    const { service, prisma } = rigg(SIGNERAT)
    await expect(
      service.saveAnalysisImages('insp-1', 'org-1', [
        {
          filename: 'kok.jpg',
          storageKey: 'inspections/org-1/x.jpg',
          storageUrl: 'https://r2/x',
          caption: null,
          room: null,
          size: 100,
          contentSha256: 'e'.repeat(64),
        },
      ]),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspectionImage.create).not.toHaveBeenCalled()
  })

  it('findOneUnsigned() nekar tidigt — före uppladdning och modellkostnad', async () => {
    const { service } = rigg(SIGNERAT)
    await expect(service.findOneUnsigned('insp-1', 'org-1')).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('DUBBEL SIGNERING: ett andra signeringsförsök nekas, det är ingen fribiljett', async () => {
    const { service, prisma } = rigg(SIGNERAT)
    await expect(
      service.update(
        'insp-1',
        { status: 'SIGNED', expectedContentHash: förutsättning(SIGNERAT) } as never,
        'org-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('INGEN TYST ÅTERÖPPNING: status kan inte sättas tillbaka till IN_PROGRESS', async () => {
    const { service, prisma } = rigg(SIGNERAT)
    await expect(
      service.update('insp-1', { status: 'IN_PROGRESS' } as never, 'org-1'),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('signedAt utan SIGNED-status räcker för att neka (data som skrevs före spärren)', async () => {
    const { service } = rigg({ status: 'COMPLETED', signedAt: new Date('2026-02-01T00:00:00Z') })
    await expect(
      service.updateItem('insp-1', 'item-1', { condition: 'DAMAGED' } as never, 'org-1'),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// FORMEN PÅ SPÄRREN
// ════════════════════════════════════════════════════════════════════════════

describe('spärrens form', () => {
  it('RADLÅSET TAS FÖRE STATUSLÄSNINGEN — annars är kontrollen en TOCTOU', async () => {
    const { service, anropsordning } = rigg()
    await service.updateItem('insp-1', 'item-1', { condition: 'DAMAGED' } as never, 'org-1')

    const lås = anropsordning.findIndex((a) => a.startsWith('queryRaw'))
    const läsning = anropsordning.indexOf('inspection.findFirst')
    const skrivning = anropsordning.indexOf('inspectionItem.update')

    expect(lås).toBeGreaterThanOrEqual(0)
    expect(lås).toBeLessThan(läsning)
    expect(läsning).toBeLessThan(skrivning)
  })

  it('låset är ett FOR UPDATE på Inspection, org-scopat', async () => {
    const { service, prisma } = rigg()
    await service.delete('insp-1', 'org-1')
    const sql = (prisma.$queryRaw.mock.calls[0]![0] as string[]).join('?')
    expect(sql).toContain('"Inspection"')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain('"organizationId"')
  })

  it('alla fyra skrivvägarna kör i en transaktion', async () => {
    const vägar: Array<[string, (s: InspectionsService) => Promise<unknown>]> = [
      ['update', (s) => s.update('insp-1', { notes: 'x' } as never, 'org-1')],
      ['updateItem', (s) => s.updateItem('insp-1', 'item-1', { notes: 'x' } as never, 'org-1')],
      ['delete', (s) => s.delete('insp-1', 'org-1')],
      [
        'applyAnalysis',
        (s) => s.applyAnalysis('insp-1', 'org-1', { overallCondition: 'a', notes: 'b', items: [] }),
      ],
      [
        'saveAnalysisImages',
        (s) =>
          s.saveAnalysisImages('insp-1', 'org-1', [
            {
              filename: 'a.jpg',
              storageKey: 'k',
              storageUrl: 'u',
              caption: null,
              room: null,
              size: 1,
              contentSha256: 'f'.repeat(64),
            },
          ]),
      ],
    ]
    for (const [namn, kör] of vägar) {
      const { service, prisma } = rigg()
      await kör(service)
      expect([namn, prisma.$transaction.mock.calls.length]).toEqual([namn, 1])
    }
  })

  it('ORGANISATIONSGRÄNSEN: en främmande orgs besiktning ger NotFound, inte Conflict', async () => {
    // Läckte spärren skillnaden mellan "finns inte" och "är signerad" vore den
    // en existensorakel för andra kunders protokoll.
    const { service, prisma } = rigg({ finns: false })
    await expect(service.delete('insp-1', 'org-FRÄMMANDE')).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(prisma.inspection.delete).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ÖPPNA PROTOKOLL SKA FORTSÄTTA FUNGERA
// ════════════════════════════════════════════════════════════════════════════

describe('öppet protokoll — befintliga flöden bevaras', () => {
  it.each(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'])(
    'status %s → posten går att ändra',
    async (status) => {
      const { service, prisma } = rigg({ status })
      await service.updateItem(
        'insp-1',
        'item-1',
        { condition: 'DAMAGED', repairCost: 4500 } as never,
        'org-1',
      )
      expect(prisma.inspectionItem.update).toHaveBeenCalledTimes(1)
      expect(prisma.inspectionItem.update.mock.calls[0]![0]).toMatchObject({
        where: { id: 'item-1' },
        data: { condition: 'DAMAGED', repairCost: 4500 },
      })
    },
  )

  it('IDOR-spärren är kvar: fel inspection/org → NotFound, INGEN update', async () => {
    const { service, prisma } = rigg()
    prisma.inspectionItem.findFirst.mockResolvedValue(null)
    await expect(
      service.updateItem('insp-1', 'item-X', { notes: 'x' } as never, 'org-1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.inspectionItem.update).not.toHaveBeenCalled()
  })

  it('ett öppet protokoll går att radera', async () => {
    const { service, prisma } = rigg({ status: 'IN_PROGRESS' })
    await service.delete('insp-1', 'org-1')
    expect(prisma.inspection.delete).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SIGNERINGEN SJÄLV
// ════════════════════════════════════════════════════════════════════════════

describe('signeringen binder innehållet', () => {
  it('TIDPUNKTEN ÄR SERVERNS — en klientskickad signedAt finns inte längre att skicka', async () => {
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    const före = Date.now()
    await service.update(
      'insp-1',
      { status: 'SIGNED', expectedContentHash: förutsättning() } as never,
      'org-1',
    )
    const efter = Date.now()

    const sista = prisma.inspection.update.mock.calls.at(-1)![0] as {
      data: { signedAt: Date; signedContentHash: string }
    }
    expect(sista.data.signedAt).toBeInstanceOf(Date)
    expect(sista.data.signedAt.getTime()).toBeGreaterThanOrEqual(före)
    expect(sista.data.signedAt.getTime()).toBeLessThanOrEqual(efter)
  })

  it('hashen skrivs vid signering, och är hashen över det som faktiskt lagrades', async () => {
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    await service.update(
      'insp-1',
      { status: 'SIGNED', expectedContentHash: förutsättning() } as never,
      'org-1',
    )

    const [, andra] = prisma.inspection.update.mock.calls
    const data = (andra![0] as { data: { signedContentHash: string } }).data
    // `inspection.update` i riggen returnerar `protokoll()` — samma innehåll som
    // hashen ska ha räknats på.
    expect(data.signedContentHash).toBe(
      computeSignedContentHash(protokoll({ status: 'SIGNED' }) as never),
    )
  })

  it('ett vanligt statusbyte (COMPLETED) skriver INGEN hash och INGEN signedAt', async () => {
    const { service, prisma } = rigg({ status: 'IN_PROGRESS' })
    await service.update('insp-1', { status: 'COMPLETED' } as never, 'org-1')
    expect(prisma.inspection.update).toHaveBeenCalledTimes(1)
    const data = (prisma.inspection.update.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data
    expect(data).not.toHaveProperty('signedContentHash')
    expect(data).not.toHaveProperty('signedAt')
    expect(data.completedAt).toBeInstanceOf(Date)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// FÖRUTSÄTTNINGEN — VISAD VERSION MOT SIGNERAD VERSION
// ════════════════════════════════════════════════════════════════════════════

describe('signeringens förutsättning (expectedContentHash)', () => {
  it('SAKNAD förutsättning vid signering → 400, och INGENTING signeras', async () => {
    // En spärr som går att tysta genom att utelämna ett fält är ingen spärr.
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    await expect(
      service.update('insp-1', { status: 'SIGNED' } as never, 'org-1'),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('FEL förutsättning → 409, och INGENTING signeras', async () => {
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    await expect(
      service.update(
        'insp-1',
        { status: 'SIGNED', expectedContentHash: 'b'.repeat(64) } as never,
        'org-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('konfliktens besked är svenskt och pekar på att läsa om', async () => {
    const { service } = rigg({ status: 'COMPLETED' })
    const fel = await service
      .update('insp-1', { status: 'SIGNED', expectedContentHash: 'b'.repeat(64) } as never, 'org-1')
      .catch((e: Error) => e)
    expect((fel as Error).message).toMatch(/ändrats sedan du läste det/i)
    expect((fel as Error).message).toMatch(/[Ll]äs om/)
    expect((fel as Error).message).toMatch(/inget har signerats/i)
  })

  it('RÄTT förutsättning → signeras', async () => {
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    await service.update(
      'insp-1',
      { status: 'SIGNED', expectedContentHash: förutsättning() } as never,
      'org-1',
    )
    const sista = prisma.inspection.update.mock.calls.at(-1)![0] as {
      data: { signedContentHash: string }
    }
    expect(sista.data.signedContentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('förutsättning UTAN signering → 400 (den skyddar inget där och ska inte se ut att göra det)', async () => {
    const { service, prisma } = rigg({ status: 'IN_PROGRESS' })
    await expect(
      service.update(
        'insp-1',
        { notes: 'x', expectedContentHash: förutsättning() } as never,
        'org-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.inspection.update).not.toHaveBeenCalled()
  })

  it('kontrollen sker EFTER spärren: ett signerat protokoll ger konflikt, inte formatfel', async () => {
    const { service } = rigg(SIGNERAT)
    const fel = await service
      .update('insp-1', { status: 'SIGNED' } as never, 'org-1')
      .catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toBe(BESIKTNING_SIGNERAD_MEDDELANDE)
  })

  it('ändring OCH signering i samma anrop går igenom (den egna ändringen skrivs)', async () => {
    // Att jämförelsen sker mot innehållet FÖRE anropets egna ändringar går inte
    // att mäta här: attrappen svarar med samma rad oavsett vad som skrivits, så
    // det finns inget "efter"-tillstånd att skilja mot. Det mäts mot riktig
    // Postgres i `inspection-signing-precondition.db.spec.ts`
    // ("EGEN ändring i samma anrop är ingen konflikt med sig själv"). Här mäts
    // bara att kontraktet släpper igenom anropet och skriver den egna ändringen.
    const { service, prisma } = rigg({ status: 'COMPLETED' })
    await service.update(
      'insp-1',
      {
        overallCondition: 'Egen slutkommentar',
        status: 'SIGNED',
        expectedContentHash: förutsättning(),
      } as never,
      'org-1',
    )
    expect(prisma.inspection.update).toHaveBeenCalledTimes(2)
    expect(
      (prisma.inspection.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data
        .overallCondition,
    ).toBe('Egen slutkommentar')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// UNDERLAGET — VAD SIGNERINGEN OMFATTAR
// ════════════════════════════════════════════════════════════════════════════

describe('signaturunderlaget', () => {
  it('VERSIONEN ÄR PINNAD — en formändring utan bump blir röd här', () => {
    // Filens egen regel: ändras formen måste `SIGNATUR_UNDERLAG_VERSION` räknas
    // upp, annars blir gamla hashar tyst ojämförbara med nya. Utan den här
    // raden kunde bumpen glömmas utan att något sa ifrån.
    expect(buildSignedContent(protokoll() as never).v).toBe(2)
  })

  it('täcker de uppgifter ett depositionsavdrag vilar på', () => {
    const underlag = buildSignedContent(protokoll() as never)
    expect(Object.keys(underlag)).toEqual([
      'v',
      'inspectionId',
      'type',
      'scheduledDate',
      'completedAt',
      'overallCondition',
      'notes',
      'items',
      'images',
    ])
    expect((underlag.items as Record<string, unknown>[])[0]).toEqual({
      id: 'item-1',
      room: 'Kök',
      item: 'Golv',
      condition: 'GOOD',
      notes: null,
      repairCost: null,
    })
  })

  it.each([
    ['skicket', { condition: 'DAMAGED' }],
    ['reparationskostnaden', { repairCost: 18000 }],
    ['anteckningen', { notes: 'Brännmärke' }],
  ])('hashen ändras när %s ändras', (_namn, ändring) => {
    const före = computeSignedContentHash(protokoll() as never)
    const efter = computeSignedContentHash(
      protokoll({ items: [{ ...protokoll().items[0], ...ändring }] }) as never,
    )
    expect(efter).not.toBe(före)
  })

  it('underlaget bär contentSha256 för VARJE bild — annars binder det bara nyckeln', () => {
    // Utan det här fältet beskriver underlaget var bilden ligger, inte vad den
    // innehöll. `PutObject` mot samma nyckel hade då varit osynlig.
    const underlag = buildSignedContent(
      protokoll({
        images: [
          {
            id: 'img-1',
            filename: 'a.jpg',
            storageKey: 'k',
            caption: null,
            room: null,
            size: 10,
            contentSha256: 'a'.repeat(64),
          },
        ],
      }) as never,
    )
    expect((underlag.images as Record<string, unknown>[])[0]).toEqual({
      id: 'img-1',
      filename: 'a.jpg',
      storageKey: 'k',
      caption: null,
      room: null,
      size: 10,
      contentSha256: 'a'.repeat(64),
    })
  })

  it('hashen ändras när bildens INNEHÅLL byts men nyckel och storlek är oförändrade', () => {
    // Exakt det byte som mätningen mot syntetiskt objektlager visade att
    // lagringsporten tillåter: samma nyckel, samma längd, andra bytes.
    const bild = {
      id: 'img-1',
      filename: 'kok.jpg',
      storageKey: 'inspections/org-1/kok.jpg',
      caption: null,
      room: null,
      size: 15,
    }
    const original = computeSignedContentHash(
      protokoll({ images: [{ ...bild, contentSha256: 'a'.repeat(64) }] }) as never,
    )
    const utbytt = computeSignedContentHash(
      protokoll({ images: [{ ...bild, contentSha256: 'b'.repeat(64) }] }) as never,
    )
    expect(utbytt).not.toBe(original)
  })

  it('en bild UTAN digest (uppladdad före v2) är ärligt null, inte utelämnad', () => {
    const underlag = buildSignedContent(
      protokoll({
        images: [
          {
            id: 'img-1',
            filename: 'gammal.jpg',
            storageKey: 'k',
            caption: null,
            room: null,
            size: 10,
            contentSha256: null,
          },
        ],
      }) as never,
    )
    const bild = (underlag.images as Record<string, unknown>[])[0]!
    expect('contentSha256' in bild).toBe(true)
    expect(bild.contentSha256).toBeNull()
  })

  it('hashen ändras när en bild läggs till', () => {
    const före = computeSignedContentHash(protokoll() as never)
    const efter = computeSignedContentHash(
      protokoll({
        images: [
          {
            id: 'img-1',
            filename: 'a.jpg',
            storageKey: 'k',
            caption: null,
            room: null,
            size: 10,
            contentSha256: 'a'.repeat(64),
          },
        ],
      }) as never,
    )
    expect(efter).not.toBe(före)
  })

  it('hashen är OBEROENDE av radordningen — Prisma garanterar ingen ordning', () => {
    const två = [
      { id: 'b', room: 'Kök', item: 'Golv', condition: 'GOOD', notes: null, repairCost: null },
      { id: 'a', room: 'Bad', item: 'Golv', condition: 'DAMAGED', notes: null, repairCost: 1000 },
    ]
    const framlänges = computeSignedContentHash(protokoll({ items: två }) as never)
    const baklänges = computeSignedContentHash(protokoll({ items: [...två].reverse() }) as never)
    expect(framlänges).toBe(baklänges)
  })

  it('belopp normaliseras: 5000 och Decimal("5000.00") ger samma hash', () => {
    const somTal = computeSignedContentHash(
      protokoll({ items: [{ ...protokoll().items[0], repairCost: 5000 }] }) as never,
    )
    const somDecimal = computeSignedContentHash(
      protokoll({
        items: [{ ...protokoll().items[0], repairCost: { toFixed: () => '5000.00' } }],
      }) as never,
    )
    expect(somTal).toBe(somDecimal)
  })

  it('status, signedAt och signaturfälten ligger UTANFÖR underlaget', () => {
    // Annars hade hashen behövt täcka sitt eget resultat.
    const a = computeSignedContentHash(protokoll({ status: 'COMPLETED' }) as never)
    const b = computeSignedContentHash(
      protokoll({
        status: 'SIGNED',
        signedAt: new Date(),
        tenantSignature: 'Anna',
        landlordSignature: 'Bo',
      }) as never,
    )
    expect(a).toBe(b)
  })
})
