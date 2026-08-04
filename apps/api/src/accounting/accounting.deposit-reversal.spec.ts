/**
 * #301 — depositionens accrual reverseras vid makulering/annullering.
 *
 * Depositionens 1510 D / 2890 K ligger i en EGEN NAMNRYMD:
 *   sourceId = `deposit-invoice:<depositId>`
 *
 * De två syskonfunktionerna letar på `<invoiceId>` respektive
 * `rent-notice:<noticeId>` och kan därför ALDRIG träffa den — inte för att posten
 * är fel-nycklad, utan för att den bor någon annanstans, nycklad på DEPOSITIONENS
 * id. Före #301 blev reverseringen en tyst no-op och 1510/2890 stod kvar öppna
 * efter makulering (BFL 5 kap 6 §).
 *
 * TESTERNA ÄR DISKRIMINERANDE PÅ NAMNRYMDEN: attrappen svarar BARA på det exakta
 * sourceId:t, och varje test hävdar vilken nyckel som faktiskt slogs upp. En
 * implementation som letar på fakturans id ser inget original och blir no-op —
 * alltså exakt den bugg #301 lagar — och testet faller. En attrapp som svarar på
 * vad som helst hade inte kunnat skilja de två.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { AccountingService } from './accounting.service'

const DEPOSIT_ID = 'dep-1'
const INVOICE_ID = 'inv-1'
const DEPOSITION = 20_000

function makeService(opts: { originalFinns?: boolean } = {}) {
  const original = {
    id: 'je-accrual',
    description: 'Deposition F-2026-0001',
    lines: [
      {
        accountId: 'acc-1510',
        debit: new Prisma.Decimal(DEPOSITION),
        credit: null,
        description: 'Depositionsfordran',
      },
      {
        accountId: 'acc-2890',
        debit: null,
        credit: new Prisma.Decimal(DEPOSITION),
        description: 'Mottagen deposition',
      },
    ],
  }

  // Svarar BARA på depositionens namnrymd. Frågar koden efter fakturans id
  // (eller något annat) får den null — precis som riktiga Postgres gör.
  const findFirst = jest.fn((args: { where: { sourceId: string } }) =>
    Promise.resolve(
      opts.originalFinns !== false && args.where.sourceId === `deposit-invoice:${DEPOSIT_ID}`
        ? original
        : null,
    ),
  )

  const prisma = { journalEntry: { findFirst } }
  const service = new AccountingService(prisma as never, {} as never)

  // createReversalEntry är privat och testad via sina fem befintliga anropare —
  // här bevakar vi ARGUMENTEN #301 skickar in, inte radbytet.
  const createReversalEntry = jest.fn().mockResolvedValue({ id: 'je-reversal' })
  ;(service as unknown as Record<string, unknown>)['createReversalEntry'] = createReversalEntry

  return { service, findFirst, createReversalEntry, original }
}

describe('#301 — reverseJournalEntryForDepositAccrual', () => {
  it('slår upp DEPOSITIONENS namnrymd, inte fakturans', async () => {
    const { service, findFirst, createReversalEntry } = makeService()

    await service.reverseJournalEntryForDepositAccrual(
      DEPOSIT_ID,
      'org-1',
      'Makulerad faktura',
      'user-1',
    )

    expect(findFirst).toHaveBeenCalledTimes(1)
    const where = (findFirst.mock.calls[0] as unknown[])[0] as { where: Record<string, unknown> }
    // DET HÄR är assertionen som fäller en "leta på fler ställen"-fix.
    expect(where.where['sourceId']).toBe(`deposit-invoice:${DEPOSIT_ID}`)
    expect(where.where['sourceId']).not.toBe(INVOICE_ID)
    expect(where.where['source']).toBe('INVOICE')
    expect(where.where['organizationId']).toBe('org-1')
    expect(createReversalEntry).toHaveBeenCalledTimes(1)
  })

  it('nycklar motverifikatet på depositionen och speglar originalets form', async () => {
    const { service, createReversalEntry } = makeService()

    await service.reverseJournalEntryForDepositAccrual(
      DEPOSIT_ID,
      'org-1',
      'Makulerad faktura',
      'user-1',
    )

    const args = (createReversalEntry.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    // Speglar misc-charge-reversal:<id> / rent-notice-reversal:<id>.
    expect(args['reversalSourceId']).toBe(`deposit-invoice-reversal:${DEPOSIT_ID}`)
    expect(args['source']).toBe('INVOICE')
    expect(args['organizationId']).toBe('org-1')
    expect(args['createdById']).toBe('user-1')
    // Systemtriggad reversering → INGET reversalOfEntryId (bara den
    // operatörsstyrda reverseJournalEntry sätter det, för sin engångsspärr).
    expect(args['reversalOfEntryId']).toBeUndefined()
    // Raderna kommer från originalet — createReversalEntry byter debet/kredit.
    expect((args['original'] as { description: string }).description).toBe('Deposition F-2026-0001')
  })

  it('beskrivningen bär anroparens skäl — samma två prefix som syskonen', async () => {
    const makulerad = makeService()
    await makulerad.service.reverseJournalEntryForDepositAccrual(
      DEPOSIT_ID,
      'org-1',
      'Makulerad faktura',
      null,
    )
    expect(
      ((makulerad.createReversalEntry.mock.calls[0] as unknown[])[0] as { description: string })
        .description,
    ).toBe('Makulerad faktura: Deposition F-2026-0001')

    const annullerad = makeService()
    await annullerad.service.reverseJournalEntryForDepositAccrual(
      DEPOSIT_ID,
      'org-1',
      'Annullerad hyresavi',
      null,
    )
    expect(
      ((annullerad.createReversalEntry.mock.calls[0] as unknown[])[0] as { description: string })
        .description,
    ).toBe('Annullerad hyresavi: Deposition F-2026-0001')
  })

  it('no-op när ingen accrual finns — kastar inte', async () => {
    const { service, createReversalEntry } = makeService({ originalFinns: false })

    await expect(
      service.reverseJournalEntryForDepositAccrual(DEPOSIT_ID, 'org-1', 'Makulerad faktura', null),
    ).resolves.toBeUndefined()

    expect(createReversalEntry).not.toHaveBeenCalled()
  })

  it('går via transaktionsklienten när en sådan ges (atomiskt med statusflippen)', async () => {
    const { service, findFirst, createReversalEntry } = makeService()
    const txFindFirst = jest.fn().mockResolvedValue({
      id: 'je-accrual',
      description: 'Deposition F-2026-0001',
      lines: [],
    })
    const tx = { journalEntry: { findFirst: txFindFirst } }

    await service.reverseJournalEntryForDepositAccrual(
      DEPOSIT_ID,
      'org-1',
      'Makulerad faktura',
      null,
      tx as never,
    )

    // Uppslaget skedde på tx:n, INTE på prisma bredvid den (läxan från #288).
    expect(txFindFirst).toHaveBeenCalledTimes(1)
    expect(findFirst).not.toHaveBeenCalled()
    expect(((createReversalEntry.mock.calls[0] as unknown[])[0] as { tx: unknown }).tx).toBe(tx)
  })
})
