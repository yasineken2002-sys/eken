// PENGAR — buyCredits() ska allokera CR-{åååmm}-numret via den DELADE atomiska
// sekvensen (PlatformInvoiceNumberSequence), i samma tx som fakturan skapas, så
// att den INTE längre är en andra count()+1-skrivare som kan kollidera med
// PlatformInvoicesService.create() eller med sig själv vid samtidiga köp.
import { AiUsagePageService } from './ai-usage.service'

// Stateful mock-tx: sekvens-upsert med atomär increment per scope (speglar
// Postgres row-lock) + platformInvoice.create som ekar tillbaka numret.
function makeService() {
  const counters: Record<string, number> = {}
  const seqUpsert = jest.fn(
    async ({ where, create }: { where: { scope: string }; create: { lastNumber: number } }) => {
      const s = where.scope
      counters[s] = counters[s] === undefined ? create.lastNumber : counters[s] + 1
      return { lastNumber: counters[s] }
    },
  )
  const invoiceCreate = jest.fn(async ({ data }: { data: { invoiceNumber: string } }) => ({
    id: `inv-${data.invoiceNumber}`,
    invoiceNumber: data.invoiceNumber,
    dueDate: new Date('2026-07-24T00:00:00Z'),
    status: 'SENT',
  }))
  const tx = {
    platformInvoiceNumberSequence: { upsert: seqUpsert },
    platformInvoice: { create: invoiceCreate },
  }
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const svc = new AiUsagePageService(prisma as never)
  return { svc, seqUpsert, invoiceCreate, prisma }
}

describe('AiUsagePageService.buyCredits — delad atomisk fakturanummer-sekvens', () => {
  it('allokerar numret via sekvens-upsert med increment (INTE count()+1)', async () => {
    const { svc, seqUpsert, prisma } = makeService()
    const r = await svc.buyCredits('org-1', 100)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1) // allokering + insert atomiskt
    expect(seqUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { lastNumber: { increment: 1 } } }),
    )
    expect(r.invoiceNumber).toMatch(/^CR-\d{6}-\d{4}$/)
  })

  it('två samtidiga köp får OLIKA fakturanummer (ingen kollision)', async () => {
    const { svc } = makeService()
    const [a, b] = await Promise.all([svc.buyCredits('org-1', 100), svc.buyCredits('org-2', 100)])
    expect(a.invoiceNumber).not.toBe(b.invoiceNumber)
  })
})
