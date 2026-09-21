/**
 * HYRESGÄSTPORTALENS BESIKTNINGS- OCH DEPOSITIONSVY, MOT RIKTIG POSTGRES.
 *
 * ── VARFÖR EN RIKTIG DATABAS ────────────────────────────────────────────────
 *
 * Behörighetsregeln är en FRÅGA, inte en if-sats: ett `where` med ett `OR` över
 * `tenantId` och `leaseId`, scopat på organisationen. Mot en stubbad prisma kan
 * en sådan fråga inte prövas alls — stubben svarar vad den blivit tillsagd,
 * oavsett vad frågan innehöll. Den enda sättet att veta att FÖREGÅENDE
 * hyresgäst i samma lägenhet nekas är att lägga båda i en riktig tabell och
 * ställa frågan.
 *
 * ── DET RÖDA PROVET ─────────────────────────────────────────────────────────
 *
 * "SAMMA BOSTAD RÄCKER INTE" nedan. Den naiva implementationen — att matcha på
 * `unitId` — ser fullständigt rimlig ut och hade gett nästa hyresgäst tillgång
 * till den förras utflyttningsbesiktning med skador, belopp och anteckningar om
 * en annan människa. Provet ska falla om `unitId` någonsin kryper in i
 * villkoret.
 *
 * ── VAD PROVEN INTE BEVISAR ─────────────────────────────────────────────────
 *
 *   • Ingenting om TenantAuthGuard. Proven går på tjänsten och matar in ett
 *     `tenantId`; att guarden härleder rätt id ur sessionen ägs av
 *     `tenant-auth.validatesession.spec.ts`.
 *   • Ingenting om den riktiga lagringen. `getPresignedUrl` och
 *     `getFileBuffer` är stubbade.
 *   • Ingenting om PDF-renderingen. `PdfService` är stubbad; det som prövas är
 *     att vägen NEKAS för fel hyresgäst, inte hur dokumentet ser ut.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { createHash, randomUUID } from 'node:crypto'

import { NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { TenantPortalService } from './tenant-portal.service'
import { InspectionsService } from '../inspections/inspections.service'
import { InspectionImageIntegrityService } from '../inspections/inspection-image-integrity.service'
import { arSlutford } from '../inspections/inspection-versions'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('portalen: besiktningar och deposition', () => {
  let prisma: PrismaClient
  let portal: TenantPortalService
  let inspections: InspectionsService

  let orgA: string
  let orgB: string
  let unitDelad: string
  let propA: string
  let userA: string

  /** Hyresgästen vars protokoll det handlar om. */
  let hgNuvarande: string
  let leaseNuvarande: string
  /** Föregående hyresgäst i SAMMA lägenhet. */
  let hgForegaende: string
  let leaseForegaende: string
  /** En hyresgäst i en helt annan organisation. */
  let hgAnnanOrg: string

  const LAGRING: Record<string, Buffer> = {}
  let renderadHtml = ''

  const nyOrg = async (märke: string) => {
    const sfx = randomUUID().slice(0, 8)
    const o = await prisma.organization.create({
      data: {
        name: `${märke}-${sfx}`,
        email: `${märke}-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    return o.id
  }

  const nyHyresgast = async (organizationId: string, namn: string) => {
    const t = await prisma.tenant.create({
      data: {
        organizationId,
        type: 'INDIVIDUAL',
        firstName: namn,
        lastName: 'Hyresgäst',
        email: `${namn.toLowerCase()}-${randomUUID().slice(0, 8)}@example.se`,
      },
      select: { id: true },
    })
    return t.id
  }

  const nyttAvtal = async (organizationId: string, unitId: string, tenantId: string) => {
    const l = await prisma.lease.create({
      data: {
        organizationId,
        unitId,
        tenantId,
        startDate: new Date('2024-01-01T00:00:00Z'),
        tenancyStartDate: new Date('2024-01-01T00:00:00Z'),
        monthlyRent: 9500,
        depositAmount: 19000,
        status: 'TERMINATED',
      },
      select: { id: true },
    })
    return l.id
  }

  /** Ett slutfört protokoll med en skadepost och två bilagor. */
  const nyBesiktning = async (över: Record<string, unknown> = {}) => {
    const insp = await prisma.inspection.create({
      data: {
        organizationId: orgA,
        propertyId: propA,
        unitId: unitDelad,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        inspectedById: userA,
        type: 'MOVE_OUT',
        status: 'SIGNED',
        signedAt: new Date('2026-03-04T10:00:00Z'),
        scheduledDate: new Date('2026-03-02T09:00:00Z'),
        completedAt: new Date('2026-03-02T10:30:00Z'),
        overallCondition: 'Godtagbart skick',
        notes: 'Protokollets anteckning',
        ...över,
      },
      select: { id: true },
    })
    await prisma.inspectionItem.create({
      data: {
        inspectionId: insp.id,
        room: 'Badrum',
        item: 'Golv',
        condition: 'DAMAGED',
        repairCost: 4500,
        notes: 'Spricka i klinker',
      },
    })
    const nyckel = `inspections/${orgA}/${randomUUID()}.jpg`
    LAGRING[nyckel] = Buffer.from('badrum-bytes')
    await prisma.inspectionImage.create({
      data: {
        inspectionId: insp.id,
        filename: 'badrum.jpg',
        storageKey: nyckel,
        storageUrl: 'https://exempel/badrum.jpg',
        size: 2345,
        contentSha256: createHash('sha256').update(LAGRING[nyckel]!).digest('hex'),
      },
    })
    return insp.id
  }

  /** En faktura att hänga depositionen och en bankrad på. */
  const nyFaktura = async () => {
    const f = await prisma.invoice.create({
      data: {
        organizationId: orgA,
        tenantId: hgNuvarande,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        // DEPOSIT — samma typ som depositionsfakturan har i produkten, så att
        // fixturen inte är en faktura av ett slag som aldrig kopplas till en
        // Deposit.
        type: 'DEPOSIT',
        subtotal: 19000,
        vatTotal: 0,
        total: 19000,
        issueDate: new Date('2024-01-01T00:00:00Z'),
        dueDate: new Date('2024-01-31T00:00:00Z'),
      },
      select: { id: true },
    })
    return f.id
  }

  /** En MATCHAD bankrad kopplad till fakturan — proveniensens enda källa. */
  const nyMatchadBankrad = async (invoiceId: string) => {
    const b = await prisma.bankTransaction.create({
      data: {
        organizationId: orgA,
        date: new Date('2024-01-05T00:00:00Z'),
        description: 'Inbetalning deposition',
        amount: 19000,
        status: 'MATCHED',
        invoiceId,
        matchedAt: new Date('2024-01-05T00:00:00Z'),
      },
      select: { id: true },
    })
    return b.id
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()

    const lagringsstub = {
      getPresignedUrl: async (key: string) => `https://presignerad.exempel/${key}?sig=x`,
      getFileBuffer: async (key: string) => {
        const bytes = LAGRING[key]
        if (!bytes) throw new Error(`NoSuchKey: ${key}`)
        return bytes
      },
    }
    const bildkontroll = new InspectionImageIntegrityService(lagringsstub as never)
    inspections = new InspectionsService(
      prisma as never,
      {
        // HTML:en fångas, inte bara kasseras: provet nedan mäter vad PDF:en
        // FAKTISKT innehåller, och en stubb som bara svarar med bytes kan
        // inte svara på den frågan.
        generateFromHtml: async (html: string) => {
          renderadHtml = html
          return Buffer.from('%PDF-1.4')
        },
      } as never,
      lagringsstub as never,
      bildkontroll,
    )
    portal = new TenantPortalService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      inspections,
      bildkontroll,
      lagringsstub as never,
    )

    orgA = await nyOrg('portal-a')
    orgB = await nyOrg('portal-b')

    const sfx = randomUUID().slice(0, 8)
    const p = await prisma.property.create({
      data: {
        organizationId: orgA,
        name: `Fastighet ${sfx}`,
        propertyDesignation: `Eken ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'Ekgatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 500,
      },
      select: { id: true },
    })
    propA = p.id
    const u = await prisma.unit.create({
      data: {
        propertyId: propA,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 62,
        monthlyRent: 9500,
      },
      select: { id: true },
    })
    unitDelad = u.id

    const anvandare = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `portal-${randomUUID().slice(0, 8)}@example.se`,
        firstName: 'Besiktnings',
        lastName: 'Ansvarig',
        role: 'ADMIN',
      },
      select: { id: true },
    })
    userA = anvandare.id

    hgNuvarande = await nyHyresgast(orgA, 'Nuvarande')
    hgForegaende = await nyHyresgast(orgA, 'Foregaende')
    hgAnnanOrg = await nyHyresgast(orgB, 'Frammande')

    leaseNuvarande = await nyttAvtal(orgA, unitDelad, hgNuvarande)
    // SAMMA lägenhet, en annan människa, ett annat avtal.
    leaseForegaende = await nyttAvtal(orgA, unitDelad, hgForegaende)
  })

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      await prisma.deposit.deleteMany({ where: { organizationId: id } }).catch(() => undefined)
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  // ══ DET RÖDA PROVET ═══════════════════════════════════════════════════════

  it('SAMMA BOSTAD RÄCKER INTE: föregående hyresgäst ser inte den nuvarandes protokoll', async () => {
    const id = await nyBesiktning()

    expect((await portal.getInspections(hgNuvarande)).map((i) => i.id)).toContain(id)

    // Föregående hyresgäst har ett avtal på SAMMA unitId — och ska ändå inte se
    // något. Faller det här provet har `unitId` kommit in i villkoret.
    expect(await portal.getInspections(hgForegaende)).toEqual([])
    await expect(portal.getInspection(hgForegaende, id)).rejects.toBeInstanceOf(NotFoundException)

    await prisma.inspection.delete({ where: { id } })
  })

  it('DIREKTLÄNKARNA ÄR OCKSÅ SKYDDADE — PDF, bild och bildkontroll', async () => {
    const id = await nyBesiktning()
    const bild = await prisma.inspectionImage.findFirstOrThrow({
      where: { inspectionId: id },
      select: { id: true },
    })

    for (const främmande of [hgForegaende, hgAnnanOrg]) {
      await expect(portal.getInspectionPdf(främmande, id)).rejects.toBeInstanceOf(NotFoundException)
      await expect(portal.getInspectionImageUrl(främmande, id, bild.id)).rejects.toBeInstanceOf(
        NotFoundException,
      )
      await expect(portal.getInspectionImageCheck(främmande, id)).rejects.toBeInstanceOf(
        NotFoundException,
      )
    }

    // Och rätt hyresgäst kommer in.
    expect((await portal.getInspectionPdf(hgNuvarande, id)).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await portal.getInspectionImageUrl(hgNuvarande, id, bild.id)).url).toContain(
      'presignerad',
    )

    await prisma.inspection.delete({ where: { id } })
  })

  it('en annan organisations hyresgäst ser ingenting', async () => {
    const id = await nyBesiktning()
    expect(await portal.getInspections(hgAnnanOrg)).toEqual([])
    await expect(portal.getInspection(hgAnnanOrg, id)).rejects.toBeInstanceOf(NotFoundException)
    await prisma.inspection.delete({ where: { id } })
  })

  it('en bilaga i ETT protokoll går inte att hämta via ETT ANNAT protokolls id', async () => {
    const a = await nyBesiktning()
    const b = await nyBesiktning()
    const bildIA = await prisma.inspectionImage.findFirstOrThrow({
      where: { inspectionId: a },
      select: { id: true },
    })

    // Båda protokollen är hyresgästens egna — spärren som prövas är att bilden
    // måste tillhöra just det protokoll som står i sökvägen.
    await expect(portal.getInspectionImageUrl(hgNuvarande, b, bildIA.id)).rejects.toBeInstanceOf(
      NotFoundException,
    )

    await prisma.inspection.deleteMany({ where: { id: { in: [a, b] } } })
  })

  // ══ UTKAST SYNS INTE ══════════════════════════════════════════════════════

  it('ett PÅGÅENDE protokoll är inte tillgängliggjort', async () => {
    const id = await nyBesiktning({ status: 'IN_PROGRESS', signedAt: null, completedAt: null })
    expect(await portal.getInspections(hgNuvarande)).toEqual([])
    await expect(portal.getInspection(hgNuvarande, id)).rejects.toBeInstanceOf(NotFoundException)
    await prisma.inspection.delete({ where: { id } })
  })

  it('EN PÅGÅENDE RÄTTELSE SYNS INTE, och originalet fortsätter gälla', async () => {
    const id = await nyBesiktning()
    const vy = await inspections.findOne(id, orgA)
    const utkast = await inspections.skapaRattelse(
      id,
      { orsak: 'Badrumsposten avsåg fel lägenhet', expectedContentHash: vy.contentHash },
      orgA,
      userA,
    )

    const lista = await portal.getInspections(hgNuvarande)
    expect(lista.map((i) => i.id)).toEqual([id])
    expect(lista[0]!.harRattelser).toBe(false)

    await expect(portal.getInspection(hgNuvarande, utkast.id)).rejects.toBeInstanceOf(
      NotFoundException,
    )

    const detalj = await portal.getInspection(hgNuvarande, id)
    expect(detalj.arGallande).toBe(true)
    expect(detalj.versioner.map((v) => v.version)).toEqual([1])

    await prisma.inspection.delete({ where: { id: utkast.id } })
    await prisma.inspection.delete({ where: { id } })
  })

  it('PDF:EN BÄR INTE ETT UTKASTS ORSAKSTEXT UT TILL HYRESGÄSTEN', async () => {
    // Listan och detaljvyn filtrerar bort utkast. PDF:en renderades av SAMMA
    // metod som hyresvärdens och hade burit utkastets versionsnummer och dess
    // orsakstext — hyresvärdens ofärdiga bedömning av en skada — rakt ut till
    // motparten. Tre vyer med spärr och en utan.
    const id = await nyBesiktning()
    const vy = await inspections.findOne(id, orgA)
    const utkast = await inspections.skapaRattelse(
      id,
      { orsak: 'HEMLIG PÅGÅENDE BEDÖMNING av badrumsskadan', expectedContentHash: vy.contentHash },
      orgA,
      userA,
    )

    renderadHtml = ''
    await portal.getInspectionPdf(hgNuvarande, id)
    expect(renderadHtml).not.toContain('HEMLIG PÅGÅENDE BEDÖMNING')
    expect(renderadHtml).not.toContain('UTKAST')

    // Hyresvärdens egen export ser den däremot — att en rättelse är påbörjad
    // är en uppgift hen ska ha.
    renderadHtml = ''
    await inspections.generateProtocolPdf(id, orgA)
    expect(renderadHtml).toContain('HEMLIG PÅGÅENDE BEDÖMNING')

    await prisma.inspection.delete({ where: { id: utkast.id } })
    await prisma.inspection.delete({ where: { id } })
  })

  it('när rättelsen slutförts visas den — och historiken följer med', async () => {
    const id = await nyBesiktning()
    const vy = await inspections.findOne(id, orgA)
    const rattelse = await inspections.skapaRattelse(
      id,
      { orsak: 'Reparationskostnaden avsåg fel lägenhet', expectedContentHash: vy.contentHash },
      orgA,
      userA,
    )
    const vy2 = await inspections.findOne(rattelse.id, orgA)
    await inspections.update(
      rattelse.id,
      { status: 'SIGNED', expectedContentHash: vy2.contentHash } as never,
      orgA,
    )

    // EN rad i listan — den gällande versionen, inte två.
    const lista = await portal.getInspections(hgNuvarande)
    expect(lista).toHaveLength(1)
    expect(lista[0]!.id).toBe(rattelse.id)
    expect(lista[0]!.version).toBe(2)
    expect(lista[0]!.antalVersioner).toBe(2)
    expect(lista[0]!.harRattelser).toBe(true)

    const detalj = await portal.getInspection(hgNuvarande, rattelse.id)
    expect(detalj.arGallande).toBe(true)
    expect(detalj.versioner).toEqual([
      expect.objectContaining({ version: 1, arGallande: false }),
      expect.objectContaining({
        version: 2,
        arGallande: true,
        correctionReason: 'Reparationskostnaden avsåg fel lägenhet',
      }),
    ])

    // Den ERSATTA versionen går fortfarande att öppna — och säger att den inte
    // gäller. Att dölja den hade dolt att en ändring skett.
    const gammal = await portal.getInspection(hgNuvarande, id)
    expect(gammal.arGallande).toBe(false)

    await prisma.inspection.delete({ where: { id: rattelse.id } })
    await prisma.inspection.delete({ where: { id } })
  })

  // ══ PARITET MELLAN DE TVÅ BESKRIVNINGARNA AV "SLUTFÖRD" ═══════════════════

  /**
   * SQL-FILTRET OCH `arSlutford` MÅSTE SVARA LIKA — PRÖVAT, INTE PÅSTÅTT.
   *
   * "Slutförd" beskrivs på TVÅ ställen: som en TS-predikatfunktion
   * (`inspection-versions.ts`, som avgör vilken version som gäller) och som ett
   * `where` i portalens behörighetsvillkor (som avgör vad hyresgästen ser).
   * Två beskrivningar av samma begrepp är två tillfällen att svara olika, och
   * kommentaren "samma tre villkor" i tjänsten är prosa — den faller inte om
   * någon skärper den ena och glömmer den andra.
   *
   * Mängden är liten nog att prövas UTTÖMMANDE: fyra statusvärden gånger
   * {signerad, osignerad} är åtta fall. Ett stickprov hade missat exakt det
   * fall där de två går isär.
   *
   * VAD PROVET INTE SER: att båda är RIKTIGA. Om begreppet "slutförd" en dag
   * ska betyda något annat säger det här provet bara att de ändrats i takt.
   */
  it('PARITET: SQL-filtret och arSlutford ger samma svar för alla åtta fall', async () => {
    const statusar = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'SIGNED'] as const
    const signaturer = [null, new Date('2026-03-04T10:00:00Z')]

    for (const status of statusar) {
      for (const signedAt of signaturer) {
        const id = await nyBesiktning({
          status,
          signedAt,
          completedAt: status === 'COMPLETED' || status === 'SIGNED' ? new Date() : null,
        })

        const synligIPortalen = (await portal.getInspections(hgNuvarande)).some((i) => i.id === id)
        const enligtPredikatet = arSlutford({ status, signedAt })

        expect({ status, signerad: signedAt !== null, synlig: synligIPortalen }).toEqual({
          status,
          signerad: signedAt !== null,
          synlig: enligtPredikatet,
        })

        await prisma.inspection.delete({ where: { id } })
      }
    }
  })

  // ══ SVARSYTAN ═════════════════════════════════════════════════════════════

  it('svaret bär INGA interna fält — ingen lagringsnyckel, ingen org, ingen besiktningsman', async () => {
    const id = await nyBesiktning()
    const detalj = await portal.getInspection(hgNuvarande, id)
    const platt = JSON.stringify(detalj)

    for (const förbjudet of [
      'storageKey',
      'storageUrl',
      'organizationId',
      'inspectedById',
      'correctedById',
      'actorKind',
      'signedContentHash',
      'tenantSignature',
      'landlordSignature',
      'leaseId',
      'tenantId',
    ]) {
      expect(platt).not.toContain(förbjudet)
    }

    // Och det som SKA finnas finns: protokollets innehåll.
    expect(detalj.items[0]!.repairCost).not.toBeNull()
    expect(detalj.items[0]!.notes).toBe('Spricka i klinker')
    expect(detalj.images[0]!.filename).toBe('badrum.jpg')

    await prisma.inspection.delete({ where: { id } })
  })

  it('bildkontrollen ger hyresgästen samma utfall som hyresvärden — utan digesterna', async () => {
    const id = await nyBesiktning()
    const svar = await portal.getInspectionImageCheck(hgNuvarande, id)

    expect(svar.sammanfattning).toBe('VERIFIERAD')
    expect(svar.bilder[0]!.utfall).toBe('VERIFIERAD')
    // Digesterna är interna spår och säger hyresgästen ingenting.
    expect(JSON.stringify(svar)).not.toContain('forvantadDigest')

    await prisma.inspection.delete({ where: { id } })
  })

  it('en bilaga vars bytes bytts ut rapporteras som AVVIKANDE, inte som verifierad', async () => {
    const id = await nyBesiktning()
    const bild = await prisma.inspectionImage.findFirstOrThrow({
      where: { inspectionId: id },
      select: { storageKey: true },
    })
    LAGRING[bild.storageKey] = Buffer.from('nagon-helt-annan-bild')

    const svar = await portal.getInspectionImageCheck(hgNuvarande, id)
    expect(svar.sammanfattning).toBe('AVVIKANDE')
    expect(svar.bilder[0]!.utfall).toBe('AVVIKANDE')

    await prisma.inspection.delete({ where: { id } })
  })

  // ══ DEPOSITIONEN ══════════════════════════════════════════════════════════

  it('depositionen läses ur verkliga fält — belopp, betalning, avdrag, beslut', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        paidAt: new Date('2024-01-05T00:00:00Z'),
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14500,
        deductions: [{ reason: 'Skada badrumsgolv', amount: 4500 }],
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.belopp).toBe(19000)
    expect(vy!.status).toBe('PARTIALLY_REFUNDED')
    // Formen bär nu proveniensen. Datumet står kvar oförändrat; det som lagts
    // till är vad underlaget styrker OM datumet.
    expect(vy!.mottagenBetalning!.registreradAt).toEqual(new Date('2024-01-05T00:00:00Z'))
    expect(vy!.mottagenBetalning!.proveniens).toBe('KALLA_EJ_FASTSTALLD')
    expect(vy!.avdrag).toEqual([{ anledning: 'Skada badrumsgolv', belopp: 4500 }])
    expect(vy!.avdragSumma).toBe(4500)
    expect(vy!.avdragSummaFullstandig).toBe(true)
    expect(vy!.beslutadAterbetalning).toEqual({
      belopp: 14500,
      beslutadAt: new Date('2026-03-10T00:00:00Z'),
    })

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  it('GENOMFÖRD UTBETALNING ÄR ALLTID OKÄND — ingen bankbekräftelse påstås', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'REFUNDED',
        paidAt: new Date('2024-01-05T00:00:00Z'),
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 19000,
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    // Beslutet FINNS. Utbetalningen är en annan uppgift, och den saknas.
    expect(vy!.beslutadAterbetalning!.belopp).toBe(19000)
    expect(vy!.genomfordUtbetalning.kalla).toBeNull()
    expect(vy!.genomfordUtbetalning.kommentar).toContain('ingen källa')

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  it('en obetald deposition säger INTE att betalning mottagits', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PENDING',
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.mottagenBetalning).toBeNull()
    expect(vy!.beslutadAterbetalning).toBeNull()
    expect(vy!.avdrag).toEqual([])

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  // ══ F3: TOPPNIVÅANTECKNINGEN LÄMNAR INTE SERVERN ══════════════════════════

  it('INTERN MARKÖR I Inspection.notes NÅR ALDRIG HYRESGÄSTEN — lista, detalj, versioner, PDF', async () => {
    // Fältet har aldrig renderats i protokollets PDF och dess publik är inte
    // klassificerad. Markören är avsiktligt omöjlig att förväxla med
    // protokolltext, så att ett läckage syns direkt i stället för att drunkna.
    const MARKOR = 'INTERN-MARKOR-SOM-INTE-FAR-LAMNA-SERVERN-4711'
    const id = await nyBesiktning({ notes: MARKOR })

    // Uppgiften ligger KVAR i databasen — den döljs, den raderas inte.
    const lagrad = await prisma.inspection.findUniqueOrThrow({
      where: { id },
      select: { notes: true },
    })
    expect(lagrad.notes).toBe(MARKOR)

    // Ingen av hyresgästens fyra vyer bär den.
    expect(JSON.stringify(await portal.getInspections(hgNuvarande))).not.toContain(MARKOR)

    const detalj = await portal.getInspection(hgNuvarande, id)
    expect(JSON.stringify(detalj)).not.toContain(MARKOR)
    expect('notes' in detalj).toBe(false)
    expect(JSON.stringify(detalj.versioner)).not.toContain(MARKOR)

    renderadHtml = ''
    await portal.getInspectionPdf(hgNuvarande, id)
    expect(renderadHtml).not.toContain(MARKOR)

    // Och hyresvärdens väg ser den fortfarande — åtkomsten är inte borttagen.
    const hyresvardensVy = await inspections.findOne(id, orgA)
    expect(hyresvardensVy.notes).toBe(MARKOR)

    await prisma.inspection.delete({ where: { id } })
  })

  it('POSTENS anteckning och helhetsbedömningen visas fortfarande — inget urskillningslöst döljande', async () => {
    const id = await nyBesiktning({ notes: 'toppnivå, dold', overallCondition: 'Godtagbart skick' })

    const detalj = await portal.getInspection(hgNuvarande, id)
    // `item.notes` ÄR protokollets text och motiveringen till skadeposten.
    expect(detalj.items[0]!.notes).toBe('Spricka i klinker')
    expect(detalj.overallCondition).toBe('Godtagbart skick')

    await prisma.inspection.delete({ where: { id } })
  })

  // ══ F1: VAD UNDERLAGET STYRKER OM DEN MOTTAGNA BETALNINGEN ════════════════

  it('MANUELLT REGISTRERAD BETALNING: källa ej fastställd, inget aktörspåstående', async () => {
    // Ingen bankrad finns. `paidAt` kan komma från en manuell markering — och
    // vyn säger just det, inte "registrerad av hyresvärden".
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PAID',
        paidAt: new Date('2024-01-05T00:00:00Z'),
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.mottagenBetalning!.proveniens).toBe('KALLA_EJ_FASTSTALLD')
    expect(vy!.mottagenBetalning!.kommentar).toContain('manuell registrering')
    expect(JSON.stringify(vy)).not.toContain('Registrerad av hyresvärden')

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  it('BANKMATCHNING FINNS: proveniensen härleds ur en matchad bankrad', async () => {
    const invoiceId = await nyFaktura()
    const bankradId = await nyMatchadBankrad(invoiceId)
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        invoiceId,
        amount: 19000,
        status: 'PAID',
        paidAt: new Date('2024-01-05T00:00:00Z'),
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.mottagenBetalning!.proveniens).toBe('BANKMATCHNING_FINNS')
    // Texten får inte säga mer än uppslaget mätte. Den bekräftar att en
    // matchning finns OCH att det inte i sig gör hela depositionen
    // bankbekräftad eller säger hur mottagningsdatumet registrerades.
    expect(vy!.mottagenBetalning!.kommentar).toContain('matchad bankbetalning')
    expect(vy!.mottagenBetalning!.kommentar).toContain('inte i sig')
    expect(vy!.mottagenBetalning!.kommentar).toContain('bankbekräftad')
    expect(vy!.mottagenBetalning!.kommentar).toContain('mottagningsdatumet')
    // Och den påstår inte att uppgiften VILAR på bankhändelsen.
    expect(vy!.mottagenBetalning!.kommentar).not.toContain('vilar därmed')
    // Bankradens och fakturans id är interna och får inte följa med.
    expect(JSON.stringify(vy)).not.toContain(bankradId)
    expect(JSON.stringify(vy)).not.toContain(invoiceId)

    await prisma.deposit.delete({ where: { id: d.id } })
    await prisma.bankTransaction.delete({ where: { id: bankradId } })
    await prisma.invoice.delete({ where: { id: invoiceId } })
  })

  it('EN AVMATCHAD bankrad ger INTE bankproveniens — okänt sägs som okänt', async () => {
    const invoiceId = await nyFaktura()
    const bankradId = await nyMatchadBankrad(invoiceId)
    // Någon avmatchade raden efteråt. Då finns ingen matchning att vila på.
    await prisma.bankTransaction.update({
      where: { id: bankradId },
      data: { status: 'UNMATCHED', invoiceId: null, matchedAt: null },
    })
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        invoiceId,
        amount: 19000,
        status: 'PAID',
        paidAt: new Date('2024-01-05T00:00:00Z'),
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.mottagenBetalning!.proveniens).toBe('KALLA_EJ_FASTSTALLD')

    await prisma.deposit.delete({ where: { id: d.id } })
    await prisma.bankTransaction.delete({ where: { id: bankradId } })
    await prisma.invoice.delete({ where: { id: invoiceId } })
  })

  it('EN LAGRAD MEN OMATCHAD bankrad ger INTE bankproveniens — status-villkoret bär ensamt', async () => {
    // ── VARFÖR DET HÄR PROVET BEHÖVS UTÖVER "avmatchad" OVAN ──────────────
    //
    // Provet ovan nollar BÅDE `status` och `invoiceId`, och kan därför inte
    // säga vilket av de två villkoren som gjorde jobbet. Här är länken KVAR och
    // bara statusen är fel — så om `status: 'MATCHED'` någon gång faller ur
    // where-satsen fälls det här provet, och bara det.
    //
    // Formen är inte hypotetisk. T2:s kontoseparation (#F034c) inför ett tredje
    // ingest-utfall: en rad som matchar en KONTOLÖS historisk rad i allt filen
    // bär LAGRAS men MATCHAS ALDRIG, eftersom identiteten inte går att avgöra.
    // Sådana rader står UNMATCHED med tomma länkar, och de får inte räknas som
    // proveniens — de väntar på en människa, och att en människa ännu inte
    // avgjort något är inte ett underlag.
    const invoiceId = await nyFaktura()
    const bankradId = await nyMatchadBankrad(invoiceId)
    await prisma.bankTransaction.update({
      where: { id: bankradId },
      data: { status: 'UNMATCHED', matchedAt: null },
    })
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        invoiceId,
        amount: 19000,
        status: 'PAID',
        paidAt: new Date('2024-01-05T00:00:00Z'),
      },
    })

    // Länken finns kvar på bankraden — bara matchningen saknas.
    const kvar = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: bankradId },
      select: { invoiceId: true, status: true },
    })
    expect(kvar).toEqual({ invoiceId, status: 'UNMATCHED' })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.mottagenBetalning!.proveniens).toBe('KALLA_EJ_FASTSTALLD')

    await prisma.deposit.delete({ where: { id: d.id } })
    await prisma.bankTransaction.delete({ where: { id: bankradId } })
    await prisma.invoice.delete({ where: { id: invoiceId } })
  })

  it('ETT ÅTERBETALNINGSBESLUT UTAN BANKBEKRÄFTELSE: beslutet visas, utbetalningen okänd', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        paidAt: new Date('2024-01-05T00:00:00Z'),
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14500,
        deductions: [{ reason: 'Skada badrumsgolv', amount: 4500 }],
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.beslutadAterbetalning).toEqual({
      belopp: 14500,
      beslutadAt: new Date('2026-03-10T00:00:00Z'),
    })
    // Beslutet finns. Utbetalningen är en annan uppgift och saknas fortfarande.
    expect(vy!.genomfordUtbetalning.kalla).toBeNull()
    // Och ingen bankmatchning finns, så inbetalningssidan påstår inget heller.
    expect(vy!.mottagenBetalning!.proveniens).toBe('KALLA_EJ_FASTSTALLD')

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  // ══ F2: BELOPPEN ══════════════════════════════════════════════════════════

  it('ÖREN BEVARAS i avdragsrader och i summan', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14199.3,
        deductions: [
          { reason: 'Skada badrumsgolv', amount: 4500.5 },
          { reason: 'Städning', amount: 300.2 },
        ],
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.avdrag.map((r) => r.belopp)).toEqual([4500.5, 300.2])
    expect(vy!.avdragSumma).toBeCloseTo(4800.7, 2)
    expect(vy!.avdragSummaFullstandig).toBe(true)
    expect(vy!.beslutadAterbetalning!.belopp).toBeCloseTo(14199.3, 2)

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  it('ETT SAKNAT AVDRAGSBELOPP BLIR INTE NOLL — raden märks och summan sägs ofullständig', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14500,
        // Andra raden saknar belopp, tredje bär en tom sträng. Ingen av dem är
        // ett avdrag på noll kronor.
        deductions: [
          { reason: 'Skada badrumsgolv', amount: 4500 },
          { reason: 'Okänt' },
          { reason: 'Tomt belopp', amount: '' },
        ],
      },
    })

    const [vy] = await portal.getDeposits(hgNuvarande)
    expect(vy!.avdrag.map((r) => r.belopp)).toEqual([4500, null, null])
    expect(vy!.avdragSumma).toBe(4500)
    expect(vy!.avdragSummaFullstandig).toBe(false)
    expect(vy!.avdragUtanBelopp).toBe(2)
    expect(vy!.avdragSummaAr).toContain('inte ett saldo ur bokföringen')

    await prisma.deposit.delete({ where: { id: d.id } })
  })

  it('en annan hyresgästs deposition syns inte', async () => {
    const d = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseForegaende,
        tenantId: hgForegaende,
        amount: 12000,
        status: 'PAID',
        paidAt: new Date('2024-01-05T00:00:00Z'),
      },
    })

    expect(await portal.getDeposits(hgNuvarande)).toEqual([])
    expect((await portal.getDeposits(hgForegaende))[0]!.belopp).toBe(12000)

    await prisma.deposit.delete({ where: { id: d.id } })
  })
})
