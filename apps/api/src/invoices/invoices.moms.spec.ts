/**
 * FIX 9 · PR 3 — Momsvalidering vid fakturering (LAGBROTT 5, ML 3 kap 2 §).
 *
 * En momsfri upplåtelse får inte faktureras med moms:
 *   • Bostad (APARTMENT) → alltid momsfri.
 *   • Lokal utan frivillig skattskyldighet → momsfri.
 * Lokal MED frivillig skattskyldighet får faktureras med 25 %.
 */

// InvoicesService → PdfService → StorageService drar in @aws-sdk/client-s3 (ESM
// som jest inte transformerar). Mocka modulerna så importen blir lätt.
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import type { UnitType } from '@prisma/client'
import { InvoicesService } from './invoices.service'

function makeService(unit: { type: UnitType; voluntaryTaxLiability: boolean }) {
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        status: 'ACTIVE',
        tenantId: 'tenant-1',
        unit,
      }),
    },
    invoice: { findUnique: jest.fn().mockResolvedValue(null) },
    // Dubbelbokförings-spärren slår upp befintlig hyresavi — ingen för testet.
    rentNotice: { findFirst: jest.fn().mockResolvedValue(null) },
    // Validering sker före $transaction; för OK-fallet räcker en fejkad faktura.
    $transaction: jest.fn().mockResolvedValue({ id: 'inv-1', invoiceNumber: 'F-2026-0001' }),
  }
  const noop = {}
  const service = new InvoicesService(
    prisma as never,
    noop as never, // events
    noop as never, // pdf
    noop as never, // mail
    noop as never, // accounting
    noop as never, // notifications
    noop as never, // ocr
    noop as never, // pdfQueue
  )
  return { service, prisma }
}

function dto(vatRate: number) {
  return {
    type: 'RENT' as const,
    leaseId: '11111111-1111-1111-1111-111111111111',
    lines: [{ description: 'Hyra', quantity: 1, unitPrice: 10_000, vatRate }],
    dueDate: '2026-06-30',
    issueDate: '2026-06-01',
  }
}

describe('FIX 9 · PR 3 — InvoicesService.create momsvalidering', () => {
  it('bostad + moms 25% → BadRequestException (ML 3 kap 2 §)', async () => {
    const { service } = makeService({ type: 'APARTMENT', voluntaryTaxLiability: false })
    await expect(service.create('org-1', 'user-1', dto(25))).rejects.toThrow(BadRequestException)
    await expect(service.create('org-1', 'user-1', dto(25))).rejects.toThrow(/3 kap 2 §/)
  })

  it('lokal utan frivillig skattskyldighet + moms 25% → BadRequestException', async () => {
    const { service } = makeService({ type: 'OFFICE', voluntaryTaxLiability: false })
    await expect(service.create('org-1', 'user-1', dto(25))).rejects.toThrow(
      /frivillig skattskyldighet/,
    )
  })

  it('bostad + moms 0% → ingen momsinvändning (passerar valideringen)', async () => {
    const { service, prisma } = makeService({ type: 'APARTMENT', voluntaryTaxLiability: false })
    await service.create('org-1', 'user-1', dto(0))
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('lokal MED frivillig skattskyldighet + moms 25% → tillåts', async () => {
    const { service, prisma } = makeService({ type: 'OFFICE', voluntaryTaxLiability: true })
    await service.create('org-1', 'user-1', dto(25))
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  // Omvänd kontroll: momspliktig upplåtelse får inte faktureras momsfritt.
  it('parkering + moms 0% → BadRequestException (ML 3 kap 3 § 5)', async () => {
    const { service } = makeService({ type: 'PARKING', voluntaryTaxLiability: false })
    await expect(service.create('org-1', 'user-1', dto(0))).rejects.toThrow(/3 kap 3 § 5/)
  })

  it('parkering + moms 25% → tillåts', async () => {
    const { service, prisma } = makeService({ type: 'PARKING', voluntaryTaxLiability: false })
    await service.create('org-1', 'user-1', dto(25))
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('lokal MED frivillig skattskyldighet + moms 0% → BadRequestException', async () => {
    const { service } = makeService({ type: 'OFFICE', voluntaryTaxLiability: true })
    await expect(service.create('org-1', 'user-1', dto(0))).rejects.toThrow(
      /frivillig skattskyldighet/,
    )
  })
})
