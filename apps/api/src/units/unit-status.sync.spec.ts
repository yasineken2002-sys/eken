/**
 * I1/#62 — Unit.status ↔ Lease.status-synk.
 *
 * syncUnitStatusFromLeases är ENDA platsen som härleder enhetsstatus ur
 * kontraktens status. Testerna låser reglerna:
 *   • ≥1 ACTIVE-kontrakt → OCCUPIED.
 *   • 0 ACTIVE → VACANT, men bara om enheten är OCCUPIED (manuella tillstånd
 *     UNDER_RENOVATION/RESERVED får aldrig klobbras).
 */

import { syncUnitStatusFromLeases } from './unit-status.sync'

function makeDb(activeCount: number) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const db = {
    lease: { count: jest.fn().mockResolvedValue(activeCount) },
    unit: { updateMany },
  }
  return { db, updateMany }
}

describe('syncUnitStatusFromLeases', () => {
  it('aktivt kontrakt → enheten sätts OCCUPIED (även från VACANT/RESERVED)', async () => {
    const { db, updateMany } = makeDb(1)
    await syncUnitStatusFromLeases(db as never, 'unit-1')
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'unit-1', status: { not: 'OCCUPIED' } },
      data: { status: 'OCCUPIED' },
    })
  })

  it('inget aktivt kontrakt → endast OCCUPIED-enhet återgår till VACANT', async () => {
    const { db, updateMany } = makeDb(0)
    await syncUnitStatusFromLeases(db as never, 'unit-1')
    // Filtret status:'OCCUPIED' garanterar att UNDER_RENOVATION/RESERVED lämnas orörda.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'unit-1', status: 'OCCUPIED' },
      data: { status: 'VACANT' },
    })
  })

  it('räknar aktiva kontrakt scopat på enheten', async () => {
    const { db } = makeDb(2)
    await syncUnitStatusFromLeases(db as never, 'unit-42')
    expect(db.lease.count).toHaveBeenCalledWith({
      where: { unitId: 'unit-42', status: 'ACTIVE' },
    })
  })
})
