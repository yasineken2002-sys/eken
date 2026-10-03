/**
 * F-IMP-1 (FORTNOX-100, BYGGLEDARE-IMPORTGRANSKNING-002): importLeases kopplade avtal till
 * enhet på ENDAST enhetsnummer. Numret är unikt per fastighet (@@unique([propertyId,
 * unitNumber])), så två hus med lgh 1001 gav avtalet till det hus som råkade komma först —
 * utan felmeddelande. Provet: tvetydigt nummer utan fastighet avvisas med husen uppräknade,
 * angiven fastighet (namn eller beteckning) kopplar rätt, entydigt nummer fungerar som förut.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { PrismaService } from '../common/prisma/prisma.service'
import { ImportService } from './import.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('F-IMP-1: importLeases och fastigheten', () => {
  let prisma: PrismaService
  let service: ImportService
  let orgId: string
  let jobId: string
  const sfx = randomUUID().slice(0, 8)
  const enhet: Record<string, string> = {}

  beforeAll(async () => {
    prisma = new PrismaService()
    let n = 0
    service = new ImportService(
      prisma,
      {} as ConfigService,
      { allocate: async () => `FIMP-${sfx}-${++n}` } as never,
      {} as never,
    )
    orgId = (
      await prisma.organization.create({
        data: {
          name: `fimp-${sfx}`,
          email: `fimp-${sfx}@example.se`,
          street: 'a',
          postalCode: '11111',
          city: 'S',
        },
        select: { id: true },
      })
    ).id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `fimp-${sfx}@example.invalid`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
        role: 'OWNER',
      },
      select: { id: true },
    })
    jobId = (
      await prisma.importJob.create({
        data: {
          organizationId: orgId,
          type: 'LEASES',
          filename: 'avtal.csv',
          createdById: user.id,
        },
        select: { id: true },
      })
    ).id
    for (const [namn, bet] of [
      ['Eken A', `Syntet ${sfx} 1:1`],
      ['Eken B', `Syntet ${sfx} 1:2`],
    ] as const) {
      const p = await prisma.property.create({
        data: {
          organizationId: orgId,
          name: namn,
          propertyDesignation: bet,
          type: 'RESIDENTIAL',
          street: 'g',
          city: 'S',
          postalCode: '11111',
          totalArea: 100,
        },
        select: { id: true },
      })
      for (const nr of namn === 'Eken A' ? ['1001', '1002'] : ['1001']) {
        enhet[`${namn}:${nr}`] = (
          await prisma.unit.create({
            data: {
              propertyId: p.id,
              name: `Lgh ${nr}`,
              unitNumber: nr,
              type: 'APARTMENT',
              area: 50,
              monthlyRent: 6000,
            },
            select: { id: true },
          })
        ).id
      }
    }
    for (const t of ['a', 'b', 'c']) {
      await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: t,
          lastName: 'H',
          email: `fimp-${t}-${sfx}@example.se`,
        },
      })
    }
  })

  afterAll(async () => {
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.importJob.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const rad = (rowNumber: number, data: Record<string, string>) => ({ rowNumber, data })
  const avtalPå = (unitId: string) =>
    prisma.lease.count({ where: { organizationId: orgId, unitId } })

  it('tvetydigt nummer UTAN fastighet avvisas med fastigheterna uppräknade; inget avtal skapas', async () => {
    const r = await service.importLeases(
      [
        rad(2, {
          tenantEmail: `fimp-a-${sfx}@example.se`,
          unitNumber: '1001',
          startDate: '2026-01-01',
          monthlyRent: '6000',
        }),
      ],
      orgId,
      jobId,
    )
    expect(r.successRows).toBe(0)
    expect(r.errors[0]!.message).toMatch(/finns i flera fastigheter \(Eken A, Eken B\)/)
    expect(await avtalPå(enhet['Eken A:1001']!)).toBe(0)
    expect(await avtalPå(enhet['Eken B:1001']!)).toBe(0)
  })

  it('angiven fastighet (namn eller beteckning) kopplar avtalet till rätt hus', async () => {
    const r = await service.importLeases(
      [
        rad(2, {
          tenantEmail: `fimp-a-${sfx}@example.se`,
          unitNumber: '1001',
          propertyName: 'eken b',
          startDate: '2026-01-01',
          monthlyRent: '6000',
        }),
        rad(3, {
          tenantEmail: `fimp-b-${sfx}@example.se`,
          unitNumber: '1001',
          propertyDesignation: `Syntet ${sfx} 1:1`,
          startDate: '2026-01-01',
          monthlyRent: '6000',
        }),
      ],
      orgId,
      jobId,
    )
    expect(r).toMatchObject({ successRows: 2, errorRows: 0 })
    expect(await avtalPå(enhet['Eken B:1001']!)).toBe(1)
    expect(await avtalPå(enhet['Eken A:1001']!)).toBe(1)
  })

  it('entydigt nummer utan fastighet fungerar som förut; fel fastighet ger tydligt fel', async () => {
    const r = await service.importLeases(
      [
        rad(2, {
          tenantEmail: `fimp-c-${sfx}@example.se`,
          unitNumber: '1002',
          startDate: '2026-01-01',
          monthlyRent: '6000',
        }),
        rad(3, {
          tenantEmail: `fimp-c-${sfx}@example.se`,
          unitNumber: '1002',
          propertyName: 'Eken B',
          startDate: '2026-01-01',
          monthlyRent: '6000',
        }),
      ],
      orgId,
      jobId,
    )
    expect(r.successRows).toBe(1)
    expect(await avtalPå(enhet['Eken A:1002']!)).toBe(1)
    expect(r.errors[0]!.message).toMatch(/hittades inte i fastigheten "Eken B"/)
  })
})
