/**
 * IDOR-fix (issue #114) — updateItem på PATCH /inspections/:id/items/:itemId verifierar
 * HELA kedjan item → inspection → org innan posten skrivs.
 *
 * Tidigare scopades update:en enbart på itemId; en användare kunde ändra en post i en
 * annan besiktning/annan organisation genom att byta itemId. Verifierar att:
 *   • egen org + rätt inspection → uppdaterar posten
 *   • posten hör till en annan inspection / annan org / finns ej → NotFoundException,
 *     update körs ALDRIG
 *   • org-scopingen sker via inspection-relationen (organizationId från JWT, ej input)
 *   • samma fel (NotFound) i alla nekande fall → ingen existensläcka
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { InspectionsService } from './inspections.service'

function makeService(opts: { itemFound: boolean }) {
  const findFirst = jest.fn().mockResolvedValue(opts.itemFound ? { id: 'item-1' } : null)
  const update = jest.fn().mockResolvedValue({ id: 'item-1', condition: 'DAMAGED' })
  const prisma = { inspectionItem: { findFirst, update } }
  const service = new InspectionsService(prisma as never, {} as never)
  return { service, findFirst, update }
}

const dto = { repairCost: 5000 } as never

describe('InspectionsService.updateItem — IDOR-spärr (item→inspection→org)', () => {
  it('egen org + post tillhör angiven inspection → uppdaterar', async () => {
    const { service, findFirst, update } = makeService({ itemFound: true })
    const res = await service.updateItem('insp-1', 'item-1', dto, 'org-1')

    // Hela kedjan verifieras i EN query: item-id + inspectionId + org via relationen.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'item-1', inspectionId: 'insp-1', inspection: { organizationId: 'org-1' } },
      select: { id: true },
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].where).toEqual({ id: 'item-1' })
    expect(res).toMatchObject({ id: 'item-1' })
  })

  it('post tillhör annan inspection / annan org / finns ej → NotFound, INGEN update', async () => {
    const { service, update } = makeService({ itemFound: false })
    await expect(service.updateItem('insp-1', 'item-X', dto, 'org-1')).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('org-scopingen kommer från orgId-parametern (JWT), inte från klient-input', async () => {
    const { service, findFirst } = makeService({ itemFound: true })
    await service.updateItem('insp-1', 'item-1', dto, 'org-TRUSTED')
    expect(findFirst.mock.calls[0]![0].where.inspection).toEqual({ organizationId: 'org-TRUSTED' })
  })

  it('ingen existensläcka: samma NotFound-meddelande oavsett nekande orsak', async () => {
    const { service } = makeService({ itemFound: false })
    // "annan org"-fall och "finns ej"-fall är omöjliga att skilja åt utifrån felet.
    const errA = await service.updateItem('insp-1', 'item-other-org', dto, 'org-1').catch((e) => e)
    const errB = await service.updateItem('insp-1', 'item-missing', dto, 'org-1').catch((e) => e)
    expect(errA).toBeInstanceOf(NotFoundException)
    expect(errB).toBeInstanceOf(NotFoundException)
    expect(errA.message).toBe(errB.message)
  })
})
