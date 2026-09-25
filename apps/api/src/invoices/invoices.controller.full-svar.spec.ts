/**
 * FAKTURAVY-RÄTTNINGEN — mutationssvaren är den FULLSTÄNDIGA fakturan.
 *
 * Kundprovet på #924 (T1, DEFEKT-1): PATCH /invoices/:id/status svarade med
 * fakturaraden utan `lines`, webben satte svaret som vald faktura och vyn
 * kraschade efter att statusen redan sparats. Samma form fanns på PATCH /:id och
 * POST /:id/pay.
 *
 * ── VAD DEN MÄTER ──────────────────────────────────────────────────────────
 *
 * Att de tre controller-vägarna (1) utför tjänstens mutation och (2) svarar med
 * `findOne` — samma form som GET /:id — och ALDRIG med mutationens egen retur.
 * Tjänstens retur är här medvetet en ofullständig rad utan `lines`: skulle en
 * väg returnera den blir provet rött.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Att webben renderar svaret utan krasch. Det bärs av webbläsarprovet i
 * leveransmappen FAKTURAVY-RATTNING-20260925 (desktop + 390 px, riktig
 * inloggning, riktig DB) och av dess negativkontroll.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('./pdf.service', () => ({ PdfService: class {} }))

import { InvoicesController } from './invoices.controller'

const ORG = 'org-1'
const ID = 'inv-1'
const USER = { sub: 'user-1', role: 'OWNER', email: 'a@example.invalid' } as never

/** Det tjänsternas mutationer returnerar: fakturaraden, UTAN relationer. */
const ofullstandig = { id: ID, status: 'SENT', invoiceNumber: 'F-1', total: '1200' }
/** Det GET /:id returnerar. */
const full = { ...ofullstandig, lines: [{ id: 'l1', description: 'Rad' }], outstanding: 1200 }

function bygg() {
  const service = {
    update: jest.fn().mockResolvedValue(ofullstandig),
    transitionStatus: jest.fn().mockResolvedValue(ofullstandig),
    markAsPaidManually: jest.fn().mockResolvedValue(ofullstandig),
    findOne: jest.fn().mockResolvedValue(full),
  }
  const c = new InvoicesController(service as never, {} as never, {} as never)
  return { c, service }
}

describe('fakturornas mutationssvar är den fullständiga fakturan', () => {
  it('PATCH /:id: uppdaterar och svarar med findOne', async () => {
    const { c, service } = bygg()
    const svar = await c.update(ID, ORG, USER, { notes: 'x' } as never)
    expect(service.update).toHaveBeenCalledWith(ID, ORG, 'user-1', { notes: 'x' })
    expect(service.findOne).toHaveBeenCalledWith(ID, ORG)
    expect(svar).toBe(full)
    expect(Array.isArray(svar.lines)).toBe(true)
  })

  it('PATCH /:id/status: övergår och svarar med findOne — aldrig tjänstens rad', async () => {
    const { c, service } = bygg()
    const svar = await c.transitionStatus(ID, ORG, USER, { status: 'SENT' } as never)
    expect(service.transitionStatus).toHaveBeenCalledWith(ID, ORG, 'SENT', 'user-1', 'USER', {})
    expect(service.findOne).toHaveBeenCalledWith(ID, ORG)
    expect(svar).toBe(full)
    expect(svar).not.toBe(ofullstandig)
  })

  it('PATCH /:id/status PAID avvisas fortfarande före allt (oförändrat)', async () => {
    const { c, service } = bygg()
    await expect(c.transitionStatus(ID, ORG, USER, { status: 'PAID' } as never)).rejects.toThrow(
      /betalningsregistrering/,
    )
    expect(service.transitionStatus).not.toHaveBeenCalled()
    expect(service.findOne).not.toHaveBeenCalled()
  })

  it('POST /:id/pay: registrerar och svarar med findOne', async () => {
    const { c, service } = bygg()
    const svar = await c.registerPayment(ID, ORG, USER, {
      amount: 100,
      paymentMethod: 'BANK',
    } as never)
    expect(service.markAsPaidManually).toHaveBeenCalledTimes(1)
    expect(service.findOne).toHaveBeenCalledWith(ID, ORG)
    expect(svar).toBe(full)
  })

  it('misslyckas mutationen läses ingenting (inget svar som ser lyckat ut)', async () => {
    const { c, service } = bygg()
    service.transitionStatus.mockRejectedValueOnce(new Error('nej'))
    await expect(c.transitionStatus(ID, ORG, USER, { status: 'VOID' } as never)).rejects.toThrow(
      'nej',
    )
    expect(service.findOne).not.toHaveBeenCalled()
  })
})
