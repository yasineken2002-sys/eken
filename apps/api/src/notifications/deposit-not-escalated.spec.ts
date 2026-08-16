/**
 * #352 PR 1a — DEPOSITIONER PÅMINNS INTE VIA DE MANUELLA/AI-TRIGGADE VÄGARNA.
 *
 * En depositionsfaktura är en riktig fordran (1510 D / 2890 K, fastställt i
 * #348) men en ENGÅNGSBETALNING vid kontraktsstart, inte en löpande skuld.
 * Kravtrappan är byggd för det senare.
 *
 * OMFATTNING — MEDVETET SMAL. Den här ändringen rör bara de två avgiftsFRIA
 * påminnelsevägarna:
 *   • steg 6, `NotificationsService.sendOverdueRemindersForOrg` (manuell org-trigger)
 *   • steg 7, AI-verktyget `send_overdue_reminders`
 *
 * ORÖRDA, och det är inte en förbiseelse:
 *   • steg 1 `markOverdueInvoices` — penganeutral statusflipp som bär
 *     depositionens SYNLIGHET (#348). Synlighet ≠ eskalering.
 *   • steg 2 påminnelsecronen — dess `where` grindar OCKSÅ den formella
 *     påminnelsen (avgift, konto 3593) och inkasso-markeringen. Att filtrera
 *     där hade avgjort en JURIDISK fråga som väntar på människa: bär
 *     avgiftstexten "enligt lag" på en depositionsfordran? Se #352.
 *
 * TESTERNA ASSERTAR PÅ `where`-ARGUMENTET, inte på utfallet. Prisma-attrapper
 * returnerar en fast array oavsett filter och är därför BLINDA för en
 * filterändring — läxan från #348, där nio tester förblev gröna när ett filter
 * lades till.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { NotificationsService } from './notifications.service'
import { ToolExecutorService } from '../ai/tools/tool-executor.service'

const ORG = 'org-1'

describe('#352 · steg 6 — manuell org-trigger exkluderar DEPOSIT', () => {
  function makeService() {
    const findMany = jest.fn().mockResolvedValue([])
    const prisma = { invoice: { findMany } }
    const service = new NotificationsService(
      prisma as never,
      { sendOverdueReminder: jest.fn() } as never,
      {} as never, // moduleRef
      {} as never, // monthlyReport
      {} as never, // locks — cron-låset, används inte av de testade metoderna
    )
    return { service, findMany }
  }

  it('`where` bär type: { not: DEPOSIT } — och övriga grindar är oförändrade', async () => {
    const { service, findMany } = makeService()
    await service.sendOverdueRemindersForOrg(ORG)

    const where = findMany.mock.calls[0]?.[0]?.where
    expect(where).toEqual({
      organizationId: ORG,
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })

    // `toEqual` är exakt: den faller både när typfiltret tas BORT och när något
    // oväntat läggs TILL i `where`. Den andra halvan är skälet att välja den
    // framför `toMatchObject`.
    //
    // HÄR STOD ETT FELAKTIGT SKÄL: "ett `toMatchObject` hade INTE fallit — det
    // ignorerar saknade nycklar". Fel, och mätt fel (code-reviewer-granskning
    // av #352). `toMatchObject` KRÄVER varje nyckel man ber om; den ignorerar
    // bara EXTRA nycklar i det faktiska objektet. Med `type` i förväntan faller
    // den lika bra som `toEqual`.
    //
    // Den verkliga fällan är alltså inte matcharen utan att UTELÄMNA fältet man
    // testar ur förväntan. Se `deposit-in-tenant-debt.spec.ts`, där
    // `not.toHaveProperty('type')` är det som gör en `toMatchObject`-baserad
    // grind säker.
  })
})

describe('#352 · steg 7 — AI-verktyget exkluderar DEPOSIT', () => {
  function makeExecutor(findMany: jest.Mock) {
    const noop = {} as never
    return new ToolExecutorService(
      { invoice: { findMany } } as never,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      { logToolExecution: jest.fn().mockResolvedValue(undefined) } as never,
      noop,
      noop,
      noop,
    )
  }

  async function run(findMany: jest.Mock, input: Record<string, unknown> = {}) {
    return (
      makeExecutor(findMany) as unknown as {
        executeToolUnsafe: (
          n: string,
          i: Record<string, unknown>,
          o: string,
          u: string,
          r: string,
        ) => Promise<{ message: string }>
      }
    ).executeToolUnsafe('send_overdue_reminders', input, ORG, 'user-1', 'OWNER')
  }

  it('`where` bär type: { not: DEPOSIT }', async () => {
    const findMany = jest.fn().mockResolvedValue([])
    await run(findMany)

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      organizationId: ORG,
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
  })

  it('spärren gäller ÄVEN när modellen namnger fakturorna explicit', async () => {
    // Utan det här testet kunde filtret ha lagts efter id-spridningen och tyst
    // skrivits över. En uppmanad AI ska inte kunna kringgå spärren genom att
    // peka ut depositionsfakturan vid namn.
    const findMany = jest.fn().mockResolvedValue([])
    await run(findMany, { invoiceIds: ['inv-1', 'inv-2'] })

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      organizationId: ORG,
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
      id: { in: ['inv-1', 'inv-2'] },
    })
  })
})

describe('#352 · vad som medvetet INTE ändrades', () => {
  it('steg 1: markOverdueInvoices flippar fortfarande DEPOSIT → OVERDUE', async () => {
    // SYNLIGHETEN ÄR INTAKT. #348 fastställde att en obetald deposition ska
    // synas som förfallen fordran. Statusflippen är penganeutral och ska därför
    // INTE bära något typfilter — faller det här testet har någon förväxlat
    // "sluta eskalera" med "sluta visa".
    const updateMany = jest.fn().mockResolvedValue({ count: 3 })
    const service = new NotificationsService(
      { invoice: { updateMany }, rentNotice: { updateMany: jest.fn() } } as never,
      {} as never, // mail
      {} as never, // moduleRef
      {} as never, // monthlyReport
      {} as never, // locks — cron-låset, används inte av de testade metoderna
    )

    await service.markOverdueInvoices()

    const where = updateMany.mock.calls[0]?.[0]?.where
    expect(where).toEqual({ status: 'SENT', dueDate: { lt: expect.any(Date) } })
    expect(where).not.toHaveProperty('type')
  })
})
