/**
 * VAKT: varje EventActorType-värde ska ge en aktörsetikett.
 *
 * `actorLabel` härleds med en if/else-kedja UTAN default, i två tjänster. Ett
 * nytt värde i enumen utan egen gren ger därför `actorLabel = undefined`: raden
 * skrivs, tidslinjen visar en tom rad, och ingenting blir rött —
 * `exactOptionalPropertyTypes` fångar det inte, för det är inte en uttömmande
 * switch, och frontend renderar bara strängen som kommer.
 *
 * Det var precis det som hade hänt när `AI` lades till i #494 beslut 4.
 *
 * Vakten läser värdena ur den GENERERADE Prisma-enumen, inte ur en egen lista.
 * En uppräkning här hade haft samma blinda fläck som kedjan den vaktar.
 */

import { EventActorType } from '@prisma/client'
import { InvoiceEventsService } from '../../invoices/invoice-events.service'
import { RentNoticeEventsService } from '../../avisering/rent-notice-events.service'

const ALLA_VARDEN = Object.values(EventActorType)

/** Prisma-attrapp: användaruppslag ger ett namn, skrivningen fångas. */
function makePrisma(captured: Record<string, unknown>[]) {
  const create = jest.fn(async (args: { data: Record<string, unknown> }) => {
    captured.push(args.data)
    return args.data
  })
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Anna', lastName: 'Svensson' }) },
    invoiceEvent: { create },
    rentNoticeEvent: { create },
  }
}

describe('aktörsetiketten täcker varje EventActorType', () => {
  it('enumen har minst de fyra kända värdena', () => {
    // Kanariefågel för vakten själv: läser vi tom lista är allt nedan grönt
    // och betyder ingenting.
    expect(ALLA_VARDEN).toEqual(expect.arrayContaining(['USER', 'SYSTEM', 'WEBHOOK', 'AI']))
    expect(ALLA_VARDEN.length).toBeGreaterThanOrEqual(4)
  })

  it.each(ALLA_VARDEN)('InvoiceEventsService ger en etikett för %s', async (actorType) => {
    const captured: Record<string, unknown>[] = []
    const svc = new InvoiceEventsService(makePrisma(captured) as never)
    // actorId sätts alltid — USER-grenen kräver den, övriga ignorerar den.
    await svc.record('inv-1', 'CREATED' as never, actorType, 'user-1')
    expect(captured).toHaveLength(1)
    expect(captured[0]!['actorLabel']).toEqual(expect.any(String))
    expect(String(captured[0]!['actorLabel']).length).toBeGreaterThan(0)
  })

  it.each(ALLA_VARDEN)('RentNoticeEventsService ger en etikett för %s', async (actorType) => {
    const captured: Record<string, unknown>[] = []
    const svc = new RentNoticeEventsService(makePrisma(captured) as never)
    await svc.record('rn-1', 'CREATED' as never, actorType, 'user-1')
    expect(captured).toHaveLength(1)
    expect(captured[0]!['actorLabel']).toEqual(expect.any(String))
    expect(String(captured[0]!['actorLabel']).length).toBeGreaterThan(0)
  })

  it('AI-etiketten är den svenska texten som visas för operatören', async () => {
    const captured: Record<string, unknown>[] = []
    const svc = new InvoiceEventsService(makePrisma(captured) as never)
    await svc.record('inv-1', 'CREATED' as never, 'AI', 'user-1')
    expect(captured[0]!['actorLabel']).toBe('AI-assistenten')
  })
})
