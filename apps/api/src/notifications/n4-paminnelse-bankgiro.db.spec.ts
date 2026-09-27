/**
 * N4 (slutintegration #922+#923) — PÅMINNELSEBREVET SKA BÄRA DET BANKGIRO SOM
 * OMPRÖVADES VID ANSPRÅKET.
 *
 * ── LUCKAN ──────────────────────────────────────────────────────────────────
 *
 * Kravtrappans cron läser organisationen i sitt `findMany` FÖRE loopen. #922
 * lade en omprövning av betalningsmålet i anspråkets transaktion, men brevet
 * fick fortfarande `invoice.organization.bankgiro` — alltså värdet från före
 * loopen. Byts målet till ett ANNAT GILTIGT värde mitt i körningen godkänns
 * anspråket mot det nya målet medan brevet bär det gamla.
 *
 * ── SÅ STYRS ORDNINGEN (deterministiskt, utan sleeps) ───────────────────────
 *
 * Cronens sekvens är fast: `findMany` → `freshness.pausadeAvGranskning(...)` →
 * loopen. Riggen byter målet INNE i `pausadeAvGranskning`, alltså efter urvalet
 * och före varje omprövning. Vad omprövningen faktiskt ser registreras inne i
 * SAMMA transaktion: `assertIngenOlostIdentitetsgranskning(tx, …)` anropas
 * omedelbart före omprövningen med samma `tx`, och riggens version läser
 * organisationens bankgiro genom den. Ingen krok i produktkoden.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Ett brev som redan köats eller skickats byter inte innehåll om målet ändras
 * efter anspråkets commit — det lovas inte och prövas inte. `MailService` är
 * en lokal fångare; leverans ägs av kön och Resend.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { PaymentReminderService } from './payment-reminder.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

/** Två olika GILTIGA bankgiron (modulus-10 prövat med den delade valideraren). */
const A = '5050-1055'
const B = '5051-0015'

medDb('N4 · påminnelsebrevet bär det omprövade bankgirot', () => {
  let prisma: PrismaClient
  let orgId: string
  let tenantId: string
  let tenantEpost: string

  const brev: Array<{ kind: 'friendly' | 'formal'; invoiceNumber: string; bankgiro: unknown }> = []
  /** Bankgiro som omprövningens transaktion såg, per anrop. */
  const settITx: Array<string | null> = []

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })

  /**
   * Bygger tjänsten med en färskhetstjänst vars två krokar är riggens:
   *  - `pausadeAvGranskning` (efter urvalet, före loopen) kör `efterUrval`
   *  - `assertIngenOlostIdentitetsgranskning(tx, …)` (i anspråkets tx, direkt
   *    före omprövningen) läser bankgirot genom SAMMA tx och registrerar det.
   */
  const bygg = (efterUrval: () => Promise<unknown> = async () => undefined) => {
    const riktig = new PaymentFreshnessService(
      prisma as never,
      { send: async () => undefined } as never,
    )
    const freshness = Object.create(riktig) as PaymentFreshnessService
    freshness.pausadeAvGranskning = async (ids: string[]) => {
      await efterUrval()
      return riktig.pausadeAvGranskning(ids)
    }
    freshness.assertIngenOlostIdentitetsgranskning = async (tx: never, org: string) => {
      const sett = await (tx as Prisma.TransactionClient).organization.findUnique({
        where: { id: org },
        select: { bankgiro: true },
      })
      if (org === orgId) settITx.push(sett?.bankgiro ?? null)
      return riktig.assertIngenOlostIdentitetsgranskning(tx, org)
    }
    const s = Object.create(PaymentReminderService.prototype) as PaymentReminderService
    Object.assign(s, {
      prisma,
      mail: {
        sendReminderFriendly: async (o: { invoiceNumber: string; bankgiro: unknown }) => {
          brev.push({ kind: 'friendly', invoiceNumber: o.invoiceNumber, bankgiro: o.bankgiro })
          return 'lokalt-friendly'
        },
        sendReminderFormal: async (o: { invoiceNumber: string; bankgiro: unknown }) => {
          brev.push({ kind: 'formal', invoiceNumber: o.invoiceNumber, bankgiro: o.bankgiro })
          return 'lokalt-formal'
        },
      },
      notifications: { createForAllOrgUsers: async () => undefined, create: async () => undefined },
      accounting: new AccountingService(
        prisma as never,
        new VerifikationsnummerService(prisma as never),
      ),
      cronErrors: { record: async () => undefined },
      freshness,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  let nr = 0
  /** Förfallen faktura: 3 dagar → vänlig, 20 dagar → formell (org-default 14). */
  const faktura = async (dagarForsenad: number) => {
    nr++
    const due = new Date(Date.now() - dagarForsenad * 86_400_000).toISOString().slice(0, 10)
    const f = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        invoiceNumber: `N4-${randomUUID().slice(0, 8)}-${nr}`,
        type: 'OTHER',
        status: 'OVERDUE',
        subtotal: 1000,
        vatTotal: 0,
        total: 1000,
        dueDate: new Date(`${due}T00:00:00Z`),
        issueDate: new Date('2026-01-01T00:00:00Z'),
      },
      select: { id: true, invoiceNumber: true },
    })
    return f
  }
  const paminnelser = (id: string) =>
    prisma.paymentReminder.findMany({ where: { invoiceId: id }, select: { type: true } })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `n4-${sfx}`,
        email: `n4-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        bankgiro: A,
        remindersEnabled: true,
      },
      select: { id: true },
    })
    orgId = org.id
    tenantEpost = `n4-hg-${sfx}@example.invalid`
    const t = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'N',
        lastName: 'Fyra',
        email: tenantEpost,
      },
      select: { id: true },
    })
    tenantId = t.id
  }, 60_000)

  beforeEach(async () => {
    brev.length = 0
    settITx.length = 0
    // Varje fall börjar med egna fakturor: tidigare fall i filen lämnar inga
    // OVERDUE-fakturor utan påminnelse kvar som cronen annars hade tagit med.
    await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await satMal(A)
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('N4.1 vänlig: mål A→B efter urvalet — omprövningen ser B OCH brevet bär B', async () => {
    const f = await faktura(3)
    await bygg(() => satMal(B)).processOverdueReminders()
    expect(settITx).toEqual([B])
    expect(await paminnelser(f.id)).toEqual([{ type: 'REMINDER_FRIENDLY' }])
    expect(brev).toEqual([{ kind: 'friendly', invoiceNumber: f.invoiceNumber, bankgiro: B }])
  }, 60_000)

  it('N4.2 formell: mål A→B efter urvalet — omprövningen ser B OCH brevet bär B', async () => {
    const f = await faktura(20)
    await bygg(() => satMal(B)).processOverdueReminders()
    expect(settITx).toEqual([B])
    expect(await paminnelser(f.id)).toEqual([{ type: 'REMINDER_FORMAL' }])
    expect(brev).toEqual([{ kind: 'formal', invoiceNumber: f.invoiceNumber, bankgiro: B }])
  }, 60_000)

  it('N4.3 POSITIV utan byte: vänlig och formell bär A', async () => {
    const v = await faktura(3)
    const fo = await faktura(20)
    await bygg().processOverdueReminders()
    expect(settITx.sort()).toEqual([A, A])
    expect(brev.map((b) => [b.kind, b.invoiceNumber, b.bankgiro]).sort()).toEqual(
      [
        ['formal', fo.invoiceNumber, A],
        ['friendly', v.invoiceNumber, A],
      ].sort(),
    )
  }, 60_000)

  it.each([
    ['rensat', null],
    ['ogiltigt (historisk rad)', '1234-5678'],
  ])(
    'N4.4 mål %s efter urvalet: ingen påminnelse, ingen avgift, inget verifikat, inget brev',
    async (_n, varde) => {
      const v = await faktura(3)
      const fo = await faktura(20)
      const totalFore = (await prisma.invoice.findUniqueOrThrow({ where: { id: fo.id } })).total
      const jeFore = await prisma.journalEntry.count({ where: { organizationId: orgId } })
      await bygg(() => satMal(varde)).processOverdueReminders()
      expect(await paminnelser(v.id)).toEqual([])
      expect(await paminnelser(fo.id)).toEqual([])
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: fo.id } })).total).toEqual(
        totalFore,
      )
      expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(jeFore)
      expect(brev).toEqual([])
    },
    60_000,
  )

  it('N4.5 idempotens: en andra körning ger inget nytt brev och ingen ny påminnelse', async () => {
    const v = await faktura(3)
    await bygg(() => satMal(B)).processOverdueReminders()
    expect(brev).toHaveLength(1)
    await bygg().processOverdueReminders()
    expect(brev).toHaveLength(1)
    expect(await paminnelser(v.id)).toEqual([{ type: 'REMINDER_FRIENDLY' }])
  }, 60_000)
})
