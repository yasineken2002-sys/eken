/**
 * T5 A1 (BFL 5:6) — avi + intäktsverifikat skapas ATOMISKT, och ett fel på EN
 * lease avbryter inte resten av orgens körning (#54). Bevisar:
 *   • tx-trädning: bokföringen körs INUTI avins $transaction (atomiskt),
 *   • per-lease-isolering: lease A:s bokförings-fel rullar tillbaka A (ingen
 *     orphan) men lease B får ändå sin avi (created=1, failed=1).
 */

// AviseringService importerar transitivt StorageService (→ @aws-sdk/client-s3) —
// mocka så importen inte drar in tunga beroenden i denna enhetstest.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

function makeLease(id: string, tenantId: string) {
  return {
    id,
    organizationId: 'org-1',
    tenantId,
    monthlyRent: 10000,
    monthlyRentExcludingVat: false,
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: null,
    status: 'ACTIVE',
    unit: { type: 'APARTMENT', voluntaryTaxLiability: false, name: 'Lgh', property: {} },
    tenant: { id: tenantId, email: null, firstName: 'A', lastName: 'B' },
  }
}

function makeRig(leases: unknown[]) {
  let seq = 0
  const prisma = {
    lease: { findMany: jest.fn().mockResolvedValue(leases) },
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]), // existing-koll + nextNoticeNumber
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: `rn-${++seq}`,
          ...data,
          type: 'RENT',
          lease: { unit: { type: 'APARTMENT', property: {} } },
          tenant: { email: null },
        }),
      ),
    },
    $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
  }
  const accounting = { createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je' }) }
  const noop = {}
  const service = new AviseringService(
    prisma as never,
    { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') } as never,
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    accounting as never,
    { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
    { attachMiscChargesToRentNotice: jest.fn().mockResolvedValue(0) } as never,
    { ensureDepositForNotice: jest.fn() } as never,
    {} as never, // rentNoticeEvents
  )
  return { service, prisma, accounting }
}

describe('T5 A1 · atomicitet + per-lease-isolering (generateMonthlyNotices)', () => {
  it('bokföringen körs INUTI avins $transaction (verifikatet är atomiskt med avin)', async () => {
    const { service, prisma, accounting } = makeRig([makeLease('lease-1', 't-1')])
    const result = await service.generateMonthlyNotices('org-1', 6, 2026)

    expect(result.created).toBe(1)
    // 4:e argumentet till bokföringen är transaktionsklienten → körs i samma tx
    // som avin (annars vore verifikatet inte atomiskt med avin).
    const txArg = accounting.createJournalEntryForRentNotice.mock.calls[0]![3]
    expect(txArg).toBe(prisma) // $transaction-mocken trädde prisma som tx
  })

  it('lease A:s bokförings-fel rullar tillbaka A men lease B får sin avi', async () => {
    const { service, accounting } = makeRig([
      makeLease('lease-A', 't-A'),
      makeLease('lease-B', 't-B'),
    ])
    // Bokföringen kastar för FÖRSTA lease:n, lyckas för andra.
    accounting.createJournalEntryForRentNotice
      .mockRejectedValueOnce(new Error('stängd period'))
      .mockResolvedValueOnce({ id: 'je-B' })

    const result = await service.generateMonthlyNotices('org-1', 6, 2026)

    // A rullades tillbaka (atomiskt, ingen orphan) men avbröt INTE körningen;
    // B skapades. Tidigare kraschade A hela orgens loop → B fick ingen avi.
    expect(result.created).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.notices).toHaveLength(1)
    expect(accounting.createJournalEntryForRentNotice).toHaveBeenCalledTimes(2)
  })
})
