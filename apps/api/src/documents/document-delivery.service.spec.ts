/**
 * DocumentDeliveryService — den delade primitiven "lägg ett dokument i en
 * hyresgästs portal". Verifierar:
 *   • tenanten verifieras inom org → tenant i annan org levereras inte.
 *   • dokumentet skapas med tenantId från den VERIFIERADE tenanten (server-
 *     side), vilket gör det portal-synligt för exakt den hyresgästen.
 *   • category=INVOICE coercas till OTHER (annars döljs dokumentet i portalen).
 *   • notis är best-effort: ett mejlfel får inte fälla leveransen.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { DocumentDeliveryService } from './document-delivery.service'

const TENANT = {
  id: 'tenant-1',
  type: 'INDIVIDUAL',
  firstName: 'Tim',
  lastName: 'Johansson',
  companyName: null,
  email: 'tim@example.com',
}

function makeService(tenantRow: typeof TENANT | null = TENANT) {
  const tenantFindFirst = jest.fn().mockResolvedValue(tenantRow)
  const documentCreate = jest.fn().mockResolvedValue({ id: 'doc-1' })
  const orgFindUnique = jest.fn().mockResolvedValue({ name: 'Hyresvärd AB' })
  const prisma = {
    tenant: { findFirst: tenantFindFirst },
    document: { create: documentCreate },
    organization: { findUnique: orgFindUnique },
  }
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://r2.example/doc.pdf') }
  const mail = { sendCustomEmail: jest.fn().mockResolvedValue('msg-1') }
  const service = new DocumentDeliveryService(prisma as never, storage as never, mail as never)
  return { service, tenantFindFirst, documentCreate, storage, mail }
}

describe('DocumentDeliveryService.deliverToTenant', () => {
  it('verifierar tenant inom org och skapar Document med tenantId (portal-synligt)', async () => {
    const { service, tenantFindFirst, documentCreate, storage } = makeService()
    const res = await service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('%PDF-1.4'),
      fileName: 'brev.pdf',
      name: 'Informationsbrev',
    })

    // org-scoping: uppslagningen kräver både id och organizationId
    expect(tenantFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tenant-1', organizationId: 'org-1' } }),
    )
    expect(storage.uploadFile).toHaveBeenCalledTimes(1)
    const data = documentCreate.mock.calls[0][0].data
    expect(data.tenantId).toBe('tenant-1') // härlett från verifierad tenant
    expect(data.organizationId).toBe('org-1')
    expect(data.category).toBe('OTHER')
    expect(res).toEqual({ documentId: 'doc-1', tenantId: 'tenant-1' })
  })

  it('tenant i annan org → NotFound, inget laddas upp och inget dokument skapas', async () => {
    const { service, documentCreate, storage } = makeService(null)
    await expect(
      service.deliverToTenant({
        organizationId: 'org-2',
        tenantId: 'tenant-1',
        content: Buffer.from('x'),
        fileName: 'brev.pdf',
        name: 'Brev',
      }),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
    expect(documentCreate).not.toHaveBeenCalled()
  })

  it('category=INVOICE coercas till OTHER (annars osynligt i portalen)', async () => {
    const { service, documentCreate } = makeService()
    await service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('x'),
      fileName: 'brev.pdf',
      name: 'Brev',
      category: 'INVOICE' as never,
    })
    expect(documentCreate.mock.calls[0][0].data.category).toBe('OTHER')
  })

  it('notify=true skickar e-post; notify utelämnat → ingen e-post', async () => {
    const { service, mail } = makeService()
    await service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('x'),
      fileName: 'brev.pdf',
      name: 'Brev',
      notify: true,
    })
    expect(mail.sendCustomEmail).toHaveBeenCalledTimes(1)
    expect(mail.sendCustomEmail.mock.calls[0][0].to).toBe('tim@example.com')

    const second = makeService()
    await second.service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('x'),
      fileName: 'brev.pdf',
      name: 'Brev',
    })
    expect(second.mail.sendCustomEmail).not.toHaveBeenCalled()
  })

  it('notis-mejlet escapar tenant-namn och dokumentnamn (XSS-skydd)', async () => {
    const { service, mail } = makeService({
      ...TENANT,
      firstName: 'Kalle<script>alert(1)</script>',
      lastName: '',
    })
    await service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('x'),
      fileName: 'brev.pdf',
      name: 'Brev <img src=x onerror=alert(2)>',
      notify: true,
    })
    const body = mail.sendCustomEmail.mock.calls[0][0].bodyHtml as string
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('<img')
    expect(body).toContain('&lt;script&gt;')
  })

  it('notis är best-effort: mejlfel fäller inte leveransen (dokumentet ligger redan i portalen)', async () => {
    const { service, mail, documentCreate } = makeService()
    mail.sendCustomEmail.mockRejectedValueOnce(new Error('SMTP nere'))
    const res = await service.deliverToTenant({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      content: Buffer.from('x'),
      fileName: 'brev.pdf',
      name: 'Brev',
      notify: true,
    })
    expect(documentCreate).toHaveBeenCalledTimes(1)
    expect(res.documentId).toBe('doc-1')
  })
})
