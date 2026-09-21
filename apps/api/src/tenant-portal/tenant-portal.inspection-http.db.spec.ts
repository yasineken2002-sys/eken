/**
 * DIREKTLÄNKARNA ÖVER HTTP — MED RIKTIG SESSION OCH RIKTIG GUARD.
 *
 * ── VARFÖR TJÄNSTEPROVET INTE RÄCKER ────────────────────────────────────────
 *
 * `tenant-portal.inspection-deposit.db.spec.ts` matar in ett `tenantId` direkt
 * i tjänsten. Det bevisar att NEKANDET är riktigt — men inte att rätt
 * `tenantId` når fram, och inte att sökvägens parametrar är rätt kopplade.
 *
 * Två fel som tjänsteprovet är blint för, och som båda är enradiga:
 *
 *   1. `@Param('id')` och `@Param('imageId')` förväxlade i bildvägen. Tjänsten
 *      hade då fått bild-id:t som protokoll-id och svarat 404 på ALLT — eller,
 *      värre, tvärtom vid en annan skrivning.
 *   2. En endpoint som råkar hamna utanför `@UseGuards(TenantAuthGuard)`. Den
 *      hade svarat lika fint utan session.
 *
 * Provet går därför genom `app.inject` mot en riktig Fastify-instans, med en
 * RIKTIG `TenantSession`-rad och en riktig Bearer-token. Guarden är inte
 * överskriven — den slår upp sessionen i databasen som i drift.
 *
 * ── VAD PROVET INTE ÄR ──────────────────────────────────────────────────────
 *
 *   • Ingen webbläsare. `app.inject` är Fastifys egen injektion, inte en klient
 *     över nätet. CORS, cookies och redirects prövas inte här.
 *   • Ingen PDF-rendering. `PdfService` är stubbad; det som mäts är statuskoden
 *     och vem som får den.
 *   • Ingen lagring. Presignering och byte-läsning är stubbade.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { createHash, randomUUID } from 'node:crypto'

import { VersioningType } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'

import { TenantPortalController } from './tenant-portal.controller'
import { TenantPortalService } from './tenant-portal.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantAuthService } from './tenant-auth.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { PdfService } from '../invoices/pdf.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { NotificationsService } from '../notifications/notifications.service'
import { AviseringService } from '../avisering/avisering.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { InspectionsService } from '../inspections/inspections.service'
import { InspectionImageIntegrityService } from '../inspections/inspection-image-integrity.service'
import { MailService } from '../mail/mail.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { LockService } from '../common/redis/lock.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { ConfigService } from '@nestjs/config'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('portalens besiktningsendpoints över HTTP', () => {
  let app: NestFastifyApplication
  let prisma: PrismaClient

  let orgA: string
  let orgB: string
  let hgNuvarande: string
  let hgForegaende: string
  let hgAnnanOrg: string
  let inspectionId: string
  let imageId: string

  /** Klartexttoken per hyresgäst. Databasen bär sha256 av dem. */
  const token: Record<string, string> = {}

  const LAGRING: Record<string, Buffer> = {}

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

  /** Hyresgäst MED en riktig session — guarden ska kunna slå upp den. */
  const nyHyresgastMedSession = async (organizationId: string, namn: string) => {
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
    const klartext = randomUUID() + randomUUID()
    await prisma.tenantSession.create({
      data: {
        tenantId: t.id,
        token: sha256(klartext),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    token[t.id] = klartext
    return t.id
  }

  const hämta = (väg: string, tenantId: string | null) =>
    app.inject({
      method: 'GET',
      url: `/v1/portal${väg}`,
      ...(tenantId ? { headers: { authorization: `Bearer ${token[tenantId]}` } } : {}),
    })

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

    const moduleRef = await Test.createTestingModule({
      controllers: [TenantPortalController],
      providers: [
        TenantPortalService,
        TenantAuthGuard,
        TenantAuthService,
        InspectionsService,
        InspectionImageIntegrityService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: lagringsstub },
        {
          provide: PdfService,
          useValue: { generateFromHtml: async () => Buffer.from('%PDF-1.4') },
        },
        { provide: MaintenanceService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AviseringService, useValue: {} },
        { provide: PersonalNumberService, useValue: { reveal: () => null } },
        // ── TenantAuthService BEHÅLLS ÄKTA ───────────────────────────────
        //
        // Guarden ska slå upp sessionen i databasen precis som i drift, och
        // det är `validateSession` som gör det. Att stubba den hade gjort
        // provet till en mätning av stubben.
        //
        // Dess ÖVRIGA beroenden är stubbade: `validateSession` rör varken
        // mejl, kontraktsmallar, lås eller cron-felsänkan. En stubb som inte
        // ligger på den prövade vägen mäter ingenting och döljer ingenting.
        { provide: MailService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: { record: () => undefined } },
      ],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    // Samma svarshölje som `main.ts` sätter globalt. Utan det svarar provet med
    // en annan form än driften, och assertionerna hade mätt riggen.
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    orgA = await nyOrg('http-a')
    orgB = await nyOrg('http-b')

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
    const u = await prisma.unit.create({
      data: {
        propertyId: p.id,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 62,
        monthlyRent: 9500,
      },
      select: { id: true },
    })
    const användare = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `http-${randomUUID().slice(0, 8)}@example.se`,
        firstName: 'Besiktnings',
        lastName: 'Ansvarig',
        role: 'ADMIN',
      },
      select: { id: true },
    })

    hgNuvarande = await nyHyresgastMedSession(orgA, 'Nuvarande')
    hgForegaende = await nyHyresgastMedSession(orgA, 'Foregaende')
    hgAnnanOrg = await nyHyresgastMedSession(orgB, 'Frammande')

    const avtal = async (tenantId: string) =>
      (
        await prisma.lease.create({
          data: {
            organizationId: orgA,
            unitId: u.id,
            tenantId,
            startDate: new Date('2024-01-01T00:00:00Z'),
            tenancyStartDate: new Date('2024-01-01T00:00:00Z'),
            monthlyRent: 9500,
            depositAmount: 19000,
            status: 'TERMINATED',
          },
          select: { id: true },
        })
      ).id

    const leaseNuvarande = await avtal(hgNuvarande)
    // SAMMA lägenhet, en annan människa.
    await avtal(hgForegaende)

    const insp = await prisma.inspection.create({
      data: {
        organizationId: orgA,
        propertyId: p.id,
        unitId: u.id,
        leaseId: leaseNuvarande,
        tenantId: hgNuvarande,
        inspectedById: användare.id,
        type: 'MOVE_OUT',
        status: 'SIGNED',
        signedAt: new Date('2026-03-04T10:00:00Z'),
        scheduledDate: new Date('2026-03-02T09:00:00Z'),
        completedAt: new Date('2026-03-02T10:30:00Z'),
      },
      select: { id: true },
    })
    inspectionId = insp.id

    const nyckel = `inspections/${orgA}/${randomUUID()}.jpg`
    LAGRING[nyckel] = Buffer.from('badrum-bytes')
    const bild = await prisma.inspectionImage.create({
      data: {
        inspectionId,
        filename: 'badrum.jpg',
        storageKey: nyckel,
        storageUrl: 'https://exempel/badrum.jpg',
        size: 2345,
        contentSha256: sha256('badrum-bytes'),
      },
      select: { id: true },
    })
    imageId = bild.id
  })

  afterAll(async () => {
    await app?.close()
    for (const id of [orgA, orgB]) {
      await prisma.deposit.deleteMany({ where: { organizationId: id } }).catch(() => undefined)
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  /** De fem läsvägarna, i den form en direktlänk har. */
  const VÄGAR = () => [
    '/inspections',
    `/inspections/${inspectionId}`,
    `/inspections/${inspectionId}/pdf`,
    `/inspections/${inspectionId}/bildkontroll`,
    `/inspections/${inspectionId}/images/${imageId}`,
    '/deposits',
  ]

  it('UTAN SESSION: varje väg svarar 401 — ingen ligger utanför guarden', async () => {
    for (const väg of VÄGAR()) {
      const svar = await hämta(väg, null)
      expect({ väg, status: svar.statusCode }).toEqual({ väg, status: 401 })
    }
  })

  it('FEL HYRESGÄST I SAMMA BOSTAD: direktlänkarna svarar 404, inte innehåll', async () => {
    for (const väg of VÄGAR()) {
      const svar = await hämta(väg, hgForegaende)
      // Listorna är tomma, de radspecifika vägarna nekas. Ingen av dem läcker.
      if (väg === '/inspections' || väg === '/deposits') {
        expect(JSON.parse(svar.body).data).toEqual([])
      } else {
        expect({ väg, status: svar.statusCode }).toEqual({ väg, status: 404 })
      }
    }
  })

  it('FEL ORGANISATION: samma utfall', async () => {
    for (const väg of VÄGAR()) {
      const svar = await hämta(väg, hgAnnanOrg)
      if (väg === '/inspections' || väg === '/deposits') {
        expect(JSON.parse(svar.body).data).toEqual([])
      } else {
        expect({ väg, status: svar.statusCode }).toEqual({ väg, status: 404 })
      }
    }
  })

  it('RÄTT HYRESGÄST kommer in på samtliga vägar', async () => {
    for (const väg of VÄGAR()) {
      const svar = await hämta(väg, hgNuvarande)
      expect({ väg, status: svar.statusCode }).toEqual({ väg, status: 200 })
    }
  })

  it('SÖKVÄGENS PARAMETRAR ÄR RÄTT KOPPLADE — bild-id:t läses som bild-id', async () => {
    // Förväxlade `@Param('id')` och `@Param('imageId')` hade gett 404 här med
    // en korrekt behörighetskontroll bakom. Provet skiljer de två felen åt:
    // rätt kombination ger 200 och en presignerad URL, fel bild ger 404.
    const rätt = await hämta(`/inspections/${inspectionId}/images/${imageId}`, hgNuvarande)
    expect(rätt.statusCode).toBe(200)
    expect(JSON.parse(rätt.body).data.url).toContain('presignerad')
    expect(JSON.parse(rätt.body).data.filename).toBe('badrum.jpg')

    const felBild = await hämta(`/inspections/${inspectionId}/images/${randomUUID()}`, hgNuvarande)
    expect(felBild.statusCode).toBe(404)
  })

  it('PDF-vägen svarar med ett PDF-dokument, inte med JSON', async () => {
    const svar = await hämta(`/inspections/${inspectionId}/pdf`, hgNuvarande)
    expect(svar.statusCode).toBe(200)
    expect(svar.headers['content-type']).toBe('application/pdf')
    expect(svar.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('svarskroppen över HTTP bär inga interna fält', async () => {
    const svar = await hämta(`/inspections/${inspectionId}`, hgNuvarande)
    for (const förbjudet of ['storageKey', 'storageUrl', 'organizationId', 'inspectedById']) {
      expect(svar.body).not.toContain(förbjudet)
    }
  })
})
