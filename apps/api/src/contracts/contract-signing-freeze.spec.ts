/**
 * WYSIWYS-frysning (Item 4, S1): medan ett kontrakt för en lease är UNDER SIGNERING
 * (SigningRequest PENDING/SIGNING_IN_PROGRESS) får kontrakts-PDF:en INTE regenereras
 * — den frusna contentHash är exakt det parterna signerar.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { ContractTemplateService } from './contract-template.service'

function makeService(activeSigning: boolean) {
  const prisma = {
    lease: { findFirst: jest.fn().mockResolvedValue({ id: 'lease-1', updatedAt: new Date() }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org-1' }) },
    signingRequest: {
      findFirst: jest.fn().mockResolvedValue(activeSigning ? { id: 'req-1' } : null),
    },
    document: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const pdf = { generatePdf: jest.fn() }
  const storage = { getFileBuffer: jest.fn() }
  // runWithLock kör bara callbacken (ingen riktig Redis i test).
  const locks = { runWithLock: jest.fn((_k: string, fn: () => unknown) => fn()) }
  const service = new ContractTemplateService(
    prisma as never,
    pdf as never,
    storage as never,
    locks as never,
  )
  return { service, prisma, pdf }
}

describe('ContractTemplateService — WYSIWYS-frysning under signering', () => {
  it('vägrar regenerera kontraktet när en signering pågår', async () => {
    const { service, prisma, pdf } = makeService(true)
    await expect(
      service.generateLeaseContract('lease-1', 'org-1', 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException)
    // Kollar aktiv signering INNAN dedup/PDF-generering — inget genereras.
    expect(prisma.signingRequest.findFirst).toHaveBeenCalled()
    expect(pdf.generatePdf).not.toHaveBeenCalled()
  })

  it('släpper igenom när ingen signering pågår (guarden blockerar inte normalflödet)', async () => {
    const { service, prisma } = makeService(false)
    // Frysnings-guarden ska INTE trigga; flödet faller vidare (och kraschar längre
    // ned på den avskalade mocken — irrelevant här). Det vi bevisar är att felet
    // aldrig är frysnings-BadRequestException:en.
    const err = await service
      .generateLeaseContract('lease-1', 'org-1', 'user-1')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(prisma.signingRequest.findFirst).toHaveBeenCalled() // guarden utvärderades
    expect(err).not.toBeInstanceOf(BadRequestException) // men blockerade inte
  })
})
