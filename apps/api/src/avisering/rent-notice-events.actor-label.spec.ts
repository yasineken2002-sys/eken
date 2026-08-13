/**
 * #340 — aktörsetiketten ska denormaliseras för USER-grenen, inte bara SYSTEM.
 *
 * VARFÖR HÅLET ÖVERLEVDE: de befintliga testerna asserterade `actorType` och
 * `actorId`, aldrig `actorLabel`. Ett anrop som skrev ett rent UUID passerade
 * dem alla. Ärendet sa det rakt ut — "annars fångas regressionen inte, vilket
 * var precis varför hålet överlevde till nu" — så bevakningen ligger här, på
 * `record()` självt, och inte bara i de anropande tjänsternas specar.
 *
 * VARFÖR DET SPELAR ROLL: `users.service.ts` gör en RIKTIG delete, ingen
 * soft-delete. Raderas användaren som utlöste händelsen står bara ett UUID kvar
 * i historiken — namnet är borta för alltid. Denormaliseringen vid
 * skrivtillfället är hela skälet till att `record()` finns, och dess egen
 * kommentar säger det: "finns kvar i historiken även om användaren senare tas
 * bort".
 *
 * DISKRIMINERANDE DATA: förnamn och efternamn är olika ord, och etiketten
 * jämförs mot den sammansatta strängen — ett test mot bara `toBeDefined()`
 * hade passerat även om koden skrivit fel fält.
 */

import { RentNoticeEventsService } from './rent-notice-events.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'

const ANVÄNDARE = { firstName: 'Astrid', lastName: 'Lindgren' }
const ETIKETT = 'Astrid Lindgren'
const USER_ID = 'user-42'

function makePrisma(user: { firstName: string; lastName: string } | null) {
  const create = jest.fn().mockResolvedValue({})
  return {
    prisma: {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      rentNoticeEvent: { create },
      invoiceEvent: { create },
    },
    create,
  }
}

describe('#340 · RentNoticeEventsService.record — aktörsetiketten', () => {
  it('USER: etiketten denormaliseras till "Förnamn Efternamn"', async () => {
    const { prisma, create } = makePrisma(ANVÄNDARE)
    const service = new RentNoticeEventsService(prisma as never)

    await service.record('rn-1', 'NOTE_ADDED', 'USER', USER_ID, { action: 'x' })

    const data = create.mock.calls[0]![0].data
    expect(data.actorId).toBe(USER_ID)
    // Kärnan: INTE bara ett UUID.
    expect(data.actorLabel).toBe(ETIKETT)
  })

  it('SYSTEM: etiketten är "System" och inget uppslag görs', async () => {
    const { prisma, create } = makePrisma(ANVÄNDARE)
    const service = new RentNoticeEventsService(prisma as never)

    await service.record('rn-1', 'NOTE_ADDED', 'SYSTEM', null, {})

    expect(create.mock.calls[0]![0].data.actorLabel).toBe('System')
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('raderad användare: etiketten utelämnas hellre än att bli felaktig', async () => {
    const { prisma, create } = makePrisma(null)
    const service = new RentNoticeEventsService(prisma as never)

    await service.record('rn-1', 'NOTE_ADDED', 'USER', USER_ID, {})

    const data = create.mock.calls[0]![0].data
    expect(data.actorId).toBe(USER_ID)
    expect(data.actorLabel).toBeUndefined()
  })

  it('uppslaget går via TRANSAKTIONSKLIENTEN när en sådan skickas (#326 C/#288)', async () => {
    const { prisma } = makePrisma(ANVÄNDARE)
    const txUser = { findUnique: jest.fn().mockResolvedValue(ANVÄNDARE) }
    const tx = {
      user: txUser,
      rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const service = new RentNoticeEventsService(prisma as never)

    await service.record('rn-1', 'NOTE_ADDED', 'USER', USER_ID, {}, { tx: tx as never })

    // Ligger uppslaget på poolen ockuperas en andra anslutning under hela tiden
    // anroparens transaktion håller sitt radlås — en liten pool kan då svälta
    // sig själv.
    expect(txUser.findUnique).toHaveBeenCalled()
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })
})

describe('#340 · InvoiceEventsService.record — samma invariant på fakturasidan', () => {
  it('USER: etiketten denormaliseras', async () => {
    const { prisma, create } = makePrisma(ANVÄNDARE)
    const service = new InvoiceEventsService(prisma as never)

    await service.record('inv-1', 'CREATED', 'USER', USER_ID, {})

    const data = create.mock.calls[0]![0].data
    expect(data.actorLabel).toBe(ETIKETT)
  })
})
