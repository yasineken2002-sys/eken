/**
 * Bankavstämnings-härdning PR 4 (B) — betalningsdatans färskhet.
 *
 * Verifierar PaymentFreshnessService:
 *   • evaluate: STALE när paymentDataThrough är äldre än tröskeln; tröskeln är
 *     konfigurerbar per org; NULL through → INTE stale (manuellt avstämmande org
 *     bricks aldrig).
 *   • recordPaymentDataThrough: monotont framåt; nollställer larm-markören när datan
 *     blir färsk igen.
 *   • evaluateAndAlert: returnerar stale-org-mängden, larmar EN gång per stale-period
 *     (inte per körning), per-org-isolerat, idempotent.
 */

import { PaymentFreshnessService } from './payment-freshness.service'

const DAY = 24 * 60 * 60 * 1000

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY)
}

function makeService(opts?: {
  orgs?: Array<Record<string, unknown>>
  findUnique?: Record<string, unknown> | null
}) {
  const sendCustomEmail = jest.fn().mockResolvedValue('msg-1')
  const update = jest.fn().mockResolvedValue({})
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(opts?.findUnique ?? null),
      findMany: jest.fn().mockResolvedValue(opts?.orgs ?? []),
      update,
      updateMany,
    },
  }
  const mail = { sendCustomEmail }
  const service = new PaymentFreshnessService(prisma as never, mail as never)
  return { service, prisma, sendCustomEmail, update, updateMany }
}

const NOW = new Date('2026-06-08T09:00:00.000Z')

describe('PaymentFreshnessService.evaluate', () => {
  it('NULL paymentDataThrough → INTE stale (grinden engagerar ej för manuell-only org)', () => {
    const { service } = makeService()
    const r = service.evaluate({ paymentDataThrough: null, paymentDataStaleDays: 3 }, NOW)
    expect(r.stale).toBe(false)
    expect(r.ageDays).toBe(Infinity)
  })

  it('färsk data (idag) → inte stale', () => {
    const { service } = makeService()
    const r = service.evaluate({ paymentDataThrough: NOW, paymentDataStaleDays: 3 }, NOW)
    expect(r.stale).toBe(false)
    expect(r.ageDays).toBe(0)
  })

  it('5 dagar gammal data, tröskel 3 → STALE', () => {
    const { service } = makeService()
    const through = new Date('2026-06-03T00:00:00.000Z')
    const r = service.evaluate({ paymentDataThrough: through, paymentDataStaleDays: 3 }, NOW)
    expect(r.stale).toBe(true)
    expect(r.ageDays).toBe(5)
  })

  it('tröskeln är KONFIGURERBAR: samma 5-dagars data, tröskel 7 → inte stale', () => {
    const { service } = makeService()
    const through = new Date('2026-06-03T00:00:00.000Z')
    const r = service.evaluate({ paymentDataThrough: through, paymentDataStaleDays: 7 }, NOW)
    expect(r.stale).toBe(false)
  })

  it('exakt på tröskeln (3 dagar, tröskel 3) → inte stale; 4 dagar → stale', () => {
    const { service } = makeService()
    const onThreshold = service.evaluate(
      { paymentDataThrough: new Date('2026-06-05T00:00:00.000Z'), paymentDataStaleDays: 3 },
      NOW,
    )
    expect(onThreshold.stale).toBe(false) // 3 dagar, ej > 3
    const over = service.evaluate(
      { paymentDataThrough: new Date('2026-06-04T00:00:00.000Z'), paymentDataStaleDays: 3 },
      NOW,
    )
    expect(over.stale).toBe(true) // 4 dagar
  })
})

describe('PaymentFreshnessService.recordPaymentDataThrough — atomisk monoton + larm-reset', () => {
  it('flyttar fram via ATOMISK compare-and-set (WHERE null OR lt) — monotonin i DB, ej i appen', async () => {
    const { service, updateMany } = makeService({ findUnique: { paymentDataStaleDays: 3 } })
    await service.recordPaymentDataThrough('org-1', daysAgo(0))
    const advance = updateMany.mock.calls[0][0]
    expect(advance.where.id).toBe('org-1')
    expect(advance.where.OR).toEqual([
      { paymentDataThrough: null },
      { paymentDataThrough: { lt: expect.any(Date) } },
    ])
    expect(advance.data.paymentDataThrough).toBeInstanceOf(Date)
  })

  it('DB avvisar bakåtskrivning (advance count 0) → ingen reset, ingen staleDays-läsning', async () => {
    const { service, prisma, updateMany } = makeService({ findUnique: { paymentDataStaleDays: 3 } })
    updateMany.mockResolvedValueOnce({ count: 0 }) // compare-and-set matchade inte → bakåt
    await service.recordPaymentDataThrough('org-1', daysAgo(10))
    expect(prisma.organization.findUnique).not.toHaveBeenCalled()
    expect(updateMany).toHaveBeenCalledTimes(1) // bara advance-försöket
  })

  it('färsk framflyttning nollställer larm-markören (ny stale-period kan larma igen)', async () => {
    const { service, updateMany } = makeService({ findUnique: { paymentDataStaleDays: 3 } })
    await service.recordPaymentDataThrough('org-1', daysAgo(0)) // färsk
    // Andra updateMany = reset av larm-markören.
    const reset = updateMany.mock.calls[1][0]
    expect(reset.data).toEqual({ paymentDataStaleAlertedAt: null })
  })

  it('framflyttning som FORTFARANDE är stale rör inte larm-markören (ingen re-larm-spam)', async () => {
    const { service, updateMany } = makeService({ findUnique: { paymentDataStaleDays: 3 } })
    await service.recordPaymentDataThrough('org-1', daysAgo(10)) // framåt men 10 dgr > 3
    expect(updateMany).toHaveBeenCalledTimes(1) // bara advance, ingen reset
  })

  it('FRAMTIDA datum klampas till idag (avaktiverar inte grinden)', async () => {
    const { service, updateMany } = makeService({ findUnique: { paymentDataStaleDays: 3 } })
    const future = new Date(Date.now() + 5 * DAY)
    await service.recordPaymentDataThrough('org-1', future)
    const stored = updateMany.mock.calls[0][0].data.paymentDataThrough as Date
    // Klampat till idag (UTC-midnatt) — aldrig 5 dagar fram i tiden.
    const todayMid = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    )
    expect(stored.getTime()).toBe(todayMid.getTime())
  })
})

describe('PaymentFreshnessService.evaluateAndAlert — paus + idempotent larm', () => {
  const staleOrg = (over?: Record<string, unknown>) => ({
    id: 'org-stale',
    name: 'Stale AB',
    paymentDataThrough: new Date('2026-06-01T00:00:00.000Z'), // 7 dagar gammalt
    paymentDataStaleDays: 3,
    paymentDataStaleAlertedAt: null,
    users: [{ email: 'owner@stale.se', firstName: 'Owe' }],
    ...over,
  })

  it('stale org → returneras i mängden + larm skickas + alertedAt sätts', async () => {
    const { service, sendCustomEmail, updateMany } = makeService({ orgs: [staleOrg()] })
    const stale = await service.evaluateAndAlert(['org-stale'], NOW)
    expect(stale.has('org-stale')).toBe(true)
    expect(sendCustomEmail).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'org-stale', paymentDataStaleAlertedAt: null },
      data: { paymentDataStaleAlertedAt: NOW },
    })
  })

  it('EN notis per stale-period: redan alertedAt satt → org pausas men INGET nytt larm', async () => {
    const { service, sendCustomEmail } = makeService({
      orgs: [staleOrg({ paymentDataStaleAlertedAt: new Date('2026-06-05') })],
    })
    const stale = await service.evaluateAndAlert(['org-stale'], NOW)
    expect(stale.has('org-stale')).toBe(true) // pausas fortfarande
    expect(sendCustomEmail).not.toHaveBeenCalled() // men inget nytt larm
  })

  it('larm-claim förlorad (count 0, parallell körning) → inget dubbel-larm', async () => {
    const { service, sendCustomEmail, updateMany } = makeService({ orgs: [staleOrg()] })
    updateMany.mockResolvedValueOnce({ count: 0 })
    const stale = await service.evaluateAndAlert(['org-stale'], NOW)
    expect(stale.has('org-stale')).toBe(true)
    expect(sendCustomEmail).not.toHaveBeenCalled()
  })

  it('PER-ORG: en stale + en färsk → bara den stale pausas och larmas', async () => {
    const freshOrg = {
      id: 'org-fresh',
      name: 'Fresh AB',
      paymentDataThrough: NOW,
      paymentDataStaleDays: 3,
      paymentDataStaleAlertedAt: null,
      users: [{ email: 'a@fresh.se', firstName: 'A' }],
    }
    const { service, sendCustomEmail } = makeService({ orgs: [staleOrg(), freshOrg] })
    const stale = await service.evaluateAndAlert(['org-stale', 'org-fresh'], NOW)
    expect(stale.has('org-stale')).toBe(true)
    expect(stale.has('org-fresh')).toBe(false)
    expect(sendCustomEmail).toHaveBeenCalledTimes(1)
    expect(sendCustomEmail.mock.calls[0][0].to).toBe('owner@stale.se')
  })

  it('mail-kön kastar → larm-markören RULLAS TILLBAKA (nästa körning får larma igen)', async () => {
    const { service, sendCustomEmail, updateMany } = makeService({ orgs: [staleOrg()] })
    sendCustomEmail.mockRejectedValueOnce(new Error('Redis nere'))
    const stale = await service.evaluateAndAlert(['org-stale'], NOW)
    expect(stale.has('org-stale')).toBe(true) // pausas fortfarande
    // 1:a updateMany = claim (alertedAt=now), 2:a = rollback (alertedAt=null).
    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(updateMany.mock.calls[1][0].data).toEqual({ paymentDataStaleAlertedAt: null })
  })

  it('tom org-lista → tom mängd, ingen DB-läsning', async () => {
    const { service, prisma } = makeService()
    const stale = await service.evaluateAndAlert([], NOW)
    expect(stale.size).toBe(0)
    expect(prisma.organization.findMany).not.toHaveBeenCalled()
  })

  it('idempotens-nyckel på larm-mailet binder till stale-periodens through-datum', async () => {
    const { service, sendCustomEmail } = makeService({ orgs: [staleOrg()] })
    await service.evaluateAndAlert(['org-stale'], NOW)
    expect(sendCustomEmail.mock.calls[0][0].idempotencyKey).toBe(
      'payment-data-stale:org-stale:2026-06-01:owner@stale.se',
    )
  })
})
