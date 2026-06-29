/**
 * PR 5a — SÄKERHETSFIX: bevis att hyresgästportalen aldrig läcker interna
 * MaintenanceTicket-fält.
 *
 * Tidigare returnerade getMaintenanceTickets()/addMaintenanceComment()/
 * submitMaintenanceRequest() hela ärenderaden (+ `include: { property: true,
 * unit: true }`) och exportTenantData() hela ärendet med `include`. Det läckte
 * estimatedCost/actualCost (hyresvärdens interna kostnader), tenantToken
 * (@unique, credential-liknande), chargeId, organizationId, reportedById/
 * assignedToId samt property.fireSafetyNotes och unit.monthlyRent till
 * hyresgästen.
 *
 * Testet matar varje väg med en "smutsig" rad där ALLA interna fält är satta och
 * asserterar att svaret SAKNAR dem (lager 2 = mapTicket) samt att queryn använder
 * SAFE_TICKET_SELECT (lager 1 = allow-list-select). Detta är beviset att läckan
 * är stängd.
 */

// MaintenanceService → StorageService drar in @aws-sdk/client-s3 (ESM som jest
// inte transformerar). Mocka leaf-modulen (samma mönster som invitations-specen).
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { TenantPortalService, mapPortalImage } from './tenant-portal.service'

// De interna fält som ALDRIG får nå hyresgästen (PR 5a allow-list-exkludering).
const FORBIDDEN_TICKET_FIELDS = [
  'organizationId',
  'estimatedCost',
  'actualCost',
  'reportedById',
  'assignedToId',
  'tenantToken',
  'chargeId',
  'tenantNotified',
] as const

// En ärenderad där varje internt fält är satt till ett sentinel-värde. Om något
// av dem syns i svaret är läckan öppen.
function dirtyTicket() {
  return {
    // Hyresgäst-vänligt (kontraktet PortalMaintenanceTicket)
    id: 'ticket-1',
    ticketNumber: 'AR-1',
    title: 'Trasig kran',
    description: 'Det droppar',
    category: 'PLUMBING',
    priority: 'NORMAL',
    status: 'NEW',
    scheduledDate: null,
    completedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    property: {
      id: 'prop-1',
      name: 'Storgatan 1',
      street: 'Storgatan 1',
      city: 'Lund',
      postalCode: '22222',
      // skulle läcka om `include: true` användes:
      organizationId: 'org-1',
      fireSafetyNotes: 'BRANDCELL-HEMLIGT',
      consumptionBillingMode: 'RENT_NOTICE_LINE',
    },
    unit: {
      id: 'unit-1',
      name: 'Lgh 1001',
      unitNumber: '1001',
      floor: 2,
      // skulle läcka om `include: true` användes:
      monthlyRent: 12000,
      voluntaryTaxLiability: true,
    },
    comments: [
      {
        id: 'c1',
        content: 'Tittar på det',
        isInternal: false,
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        ticketId: 'ticket-1',
        userId: 'staff-1',
      },
    ],
    // ── INTERNA FÄLT (läckan) ──────────────────────────────────────────────
    organizationId: 'org-1',
    estimatedCost: 5000,
    actualCost: 4200,
    reportedById: 'staff-1',
    assignedToId: 'staff-2',
    tenantToken: 'SECRET-TICKET-TOKEN-abc123',
    chargeId: 'charge-1',
    tenantNotified: true,
    propertyId: 'prop-1',
    unitId: 'unit-1',
    tenantId: 'tenant-1',
  }
}

function expectNoLeak(ticket: Record<string, unknown>) {
  for (const key of FORBIDDEN_TICKET_FIELDS) {
    expect(ticket).not.toHaveProperty(key)
  }
  // Nästlade objekt: bara namnet exponeras, inga interna fält.
  expect(ticket.property).toEqual({ name: 'Storgatan 1' })
  expect(ticket.unit).toEqual({ name: 'Lgh 1001' })
  expect(ticket.property).not.toHaveProperty('fireSafetyNotes')
  expect(ticket.unit).not.toHaveProperty('monthlyRent')
  // Kommentarer: bara säkra fält — aldrig internt userId/ticketId (audit LOW).
  const comments = ticket.comments as Array<Record<string, unknown>>
  expect(Array.isArray(comments)).toBe(true)
  for (const c of comments) {
    expect(c).not.toHaveProperty('userId')
    expect(c).not.toHaveProperty('ticketId')
    expect(Object.keys(c).sort()).toEqual(['content', 'createdAt', 'id', 'isInternal'])
  }
}

describe('TenantPortalService — PR 5a läcktätning (MaintenanceTicket)', () => {
  it('getMaintenanceTickets: svaret saknar interna fält + queryn använder allow-list-select', async () => {
    const prisma = {
      maintenanceTicket: {
        findMany: jest.fn().mockResolvedValue([dirtyTicket()]),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getMaintenanceTickets('tenant-1')

    expect(result).toHaveLength(1)
    expectNoLeak(result[0] as Record<string, unknown>)

    // Lager 1: queryn selekterar (aldrig `include`), så raderna lämnar aldrig DB
    // med de interna kolumnerna.
    const arg = prisma.maintenanceTicket.findMany.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
    for (const key of FORBIDDEN_TICKET_FIELDS) {
      expect(arg.select).not.toHaveProperty(key)
    }
  })

  it('addMaintenanceComment: svaret saknar interna fält + findUnique selekterar allow-list', async () => {
    const prisma = {
      maintenanceTicket: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ticket-1', tenantId: 'tenant-1' }),
        findUnique: jest.fn().mockResolvedValue(dirtyTicket()),
      },
      maintenanceComment: {
        create: jest.fn().mockResolvedValue({ id: 'c-new' }),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.addMaintenanceComment('tenant-1', 'ticket-1', 'Tack!')

    expectNoLeak(result as Record<string, unknown>)
    const arg = prisma.maintenanceTicket.findUnique.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
  })

  it('submitMaintenanceRequest: create()-payloaden strippas innan den når hyresgästen', async () => {
    const prisma = {
      lease: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lease-1',
          organizationId: 'org-1',
          unitId: 'unit-1',
          unit: { id: 'unit-1', property: { id: 'prop-1' } },
          tenant: { firstName: 'Anna', lastName: 'Svensson', companyName: null, email: 'a@x.se' },
        }),
      },
    }
    // MaintenanceService.create() returnerar HELA ärenderaden (interna fält och
    // allt) — portalen måste strippa den.
    const maintenanceService = {
      create: jest.fn().mockResolvedValue(dirtyTicket()),
    }
    const notifications = {
      createForAllOrgUsers: jest.fn().mockResolvedValue(undefined),
    }
    const service = new TenantPortalService(
      prisma as never,
      maintenanceService as never,
      notifications as never,
    )

    const result = await service.submitMaintenanceRequest('tenant-1', {
      title: 'Trasig kran',
      description: 'Det droppar',
    })

    expectNoLeak(result as Record<string, unknown>)
  })

  it('exportTenantData (GDPR): ärenden hämtas via allow-list-select, aldrig `include` med interna kostnader', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tenant-1',
          organization: { id: 'org-1', name: 'Eken' },
          leases: [],
          invoices: [],
          rentNotices: [],
          maintenanceTickets: [],
          documents: [],
        }),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    await service.exportTenantData('tenant-1')

    const arg = prisma.tenant.findUnique.mock.calls[0][0]
    const ticketsArg = arg.include.maintenanceTickets
    // Lager 1: select (allow-list), inte include. estimatedCost/actualCost och
    // övriga interna fält får inte ens efterfrågas.
    expect(ticketsArg.select).toBeDefined()
    expect(ticketsArg.include).toBeUndefined()
    for (const key of FORBIDDEN_TICKET_FIELDS) {
      expect(ticketsArg.select).not.toHaveProperty(key)
    }
    // Hyresgästens egna bilder behålls men utan intern R2-nyckel.
    expect(ticketsArg.select.images.select).not.toHaveProperty('storageKey')
    expect(ticketsArg.select.images.select.storageUrl).toBe(true)

    // Lease-kedjan i exporten: property/unit allow-list, documents utan storageKey.
    const leasesArg = arg.include.leases
    const propSel = leasesArg.include.unit.select.property.select
    expect(propSel).not.toHaveProperty('fireSafetyNotes')
    expect(propSel).not.toHaveProperty('consumptionBillingMode')
    expect(leasesArg.include.unit.select).not.toHaveProperty('monthlyRent')
    expect(leasesArg.include.documents.select).not.toHaveProperty('storageKey')
    // Hyresgästens egna signeringsspår behålls (Art. 15).
    expect(leasesArg.include.documents.select.signedFromIp).toBe(true)

    // Top-level documents (round-2-fynd): aldrig `include: true`; ingen R2-nyckel.
    const docsArg = arg.include.documents
    expect(docsArg).not.toBe(true)
    expect(docsArg.select).toBeDefined()
    for (const key of [
      'storageKey',
      'storageUrl',
      'uploadedById',
      'contentHash',
      'organizationId',
    ]) {
      expect(docsArg.select).not.toHaveProperty(key)
    }
    // rentNotices: allow-list-select (RentNotice-läcktätnings-PR ersatte det
    // tidigare omit-mönstret). Detaljerad fält-assertion i
    // tenant-portal.rentnotice-leak.spec.ts.
    expect(arg.include.rentNotices.select).toBeDefined()
    expect(arg.include.rentNotices.omit).toBeUndefined()
    expect(arg.include.rentNotices.select).not.toHaveProperty('reminderPdfStorageKey')
  })

  it('getLease: query använder allow-list-select; läcker aldrig property.fireSafetyNotes / unit.monthlyRent / documents', async () => {
    const prisma = { lease: { findFirst: jest.fn().mockResolvedValue(null) } }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    await service.getLease('tenant-1')

    const arg = prisma.lease.findFirst.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
    // Lease-rot: inga interna fält efterfrågas.
    expect(arg.select).not.toHaveProperty('organizationId')
    expect(arg.select).not.toHaveProperty('consumptionBillingMode')
    // documents utelämnas helt (konsumeras inte av portalen, bär storageKey).
    expect(arg.select).not.toHaveProperty('documents')
    // unit-allow-list: inget monthlyRent / voluntaryTaxLiability.
    expect(arg.select.unit.select).not.toHaveProperty('monthlyRent')
    expect(arg.select.unit.select).not.toHaveProperty('voluntaryTaxLiability')
    // property-allow-list: inget fireSafetyNotes / consumptionBillingMode / organizationId.
    const propSel = arg.select.unit.select.property.select
    expect(propSel).not.toHaveProperty('fireSafetyNotes')
    expect(propSel).not.toHaveProperty('consumptionBillingMode')
    expect(propSel).not.toHaveProperty('organizationId')
  })

  it('getDocuments: query selekterar allow-list; läcker aldrig storageKey/uploadedById/signedFromIp', async () => {
    const prisma = { document: { findMany: jest.fn().mockResolvedValue([]) } }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    await service.getDocuments('tenant-1')

    const arg = prisma.document.findMany.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
    for (const key of [
      'storageKey',
      'uploadedById',
      'signedFromIp',
      'signedUserAgent',
      'contentHash',
      'organizationId',
    ]) {
      expect(arg.select).not.toHaveProperty(key)
    }
  })

  it('getDashboard: använder count() för öppna ärenden — drar aldrig fulla ärenderader i minnet', async () => {
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 'tenant-1' }) },
      lease: { findFirst: jest.fn().mockResolvedValue(null) },
      maintenanceTicket: { count: jest.fn().mockResolvedValue(3) },
      invoice: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getDashboard('tenant-1')

    // count anropas; findMany finns inte ens på mocken → skulle kasta om koden
    // regredierade till findMany.
    expect(prisma.maintenanceTicket.count).toHaveBeenCalledTimes(1)
    expect(result.openMaintenanceTickets).toBe(3)
  })

  it('mapPortalImage: bildsvaret (POST .../images) strippar intern R2-nyckel storageKey', () => {
    const mapped = mapPortalImage({
      id: 'img-1',
      filename: 'skada.jpg',
      storageUrl: 'https://cdn.example/skada.jpg',
      size: 12345,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      // addImages returnerar HELA raden — dessa måste strippas:
      storageKey: 'maintenance/ticket-1/secret-key.jpg',
      ticketId: 'ticket-1',
    } as never)

    expect(mapped).not.toHaveProperty('storageKey')
    expect(mapped).not.toHaveProperty('ticketId')
    expect(Object.keys(mapped).sort()).toEqual([
      'createdAt',
      'filename',
      'id',
      'size',
      'storageUrl',
    ])
  })
})
