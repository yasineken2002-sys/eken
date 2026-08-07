/**
 * #307 PR 2b — SENT_TO_COLLECTION ÄR INGET MANUELLT MÅLVÄRDE.
 *
 * BAKGRUND. PR 2b vidgar INVOICE_TRANSITIONS med PARTIAL → SENT_TO_COLLECTION,
 * så att `COLLECTION_SOURCE_STATUSES` kan HÄRLEDAS ur statusmaskinen i stället
 * för att handskrivas. Tabellen har två konsumenter: inkassoexporten (som har
 * skuldgrind + assertMayActOnCollections) och `InvoicesService.transitionStatus`
 * (som inte har någon av dem). Breddningen når därför båda.
 *
 * VAD SVITEN FAKTISKT VISAR — läs den här ordningen, den är inte den man gissar:
 *
 *   A) HTTP-vägen var ALDRIG öppen för SENT_TO_COLLECTION. TransitionStatusDto:s
 *      `@IsEnum` räknar inte upp statusen, så ValidationPipe avvisar den före
 *      servicen — även från OVERDUE, alltså också FÖRE PR 2b. Testet nedan mäter
 *      det i stället för att anta det.
 *
 *   B) Spärren i transitionStatus stänger alltså inget öppet hål — den LÅSER
 *      FAST att hålet förblir stängt. DTO-enumet är en handskriven statuslista
 *      vid sidan av statusmaskinen, precis den sortens andra lista som PR 2b
 *      finns för att bli av med; utökas den (eller läggs en ny anropare på den
 *      publika metoden) öppnas inkassovägen utan skuldgrind och utan rollgrind.
 *
 * SPÄRREN ÄR MINIMAL MED FLIT. Ingen skuldgrind, ingen rollgrind — det vore en
 * tredje kopia av inkassovägen, och "ska inkasso kunna nås manuellt alls?" är
 * ett produktbeslut. Öppet ärende: #323.
 */

// InvoicesService → PdfService → StorageService drar in @aws-sdk/client-s3 (ESM
// som jest inte transformerar). Mocka modulerna så importen blir lätt.
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { BadRequestException } from '@nestjs/common'
import { INVOICE_TRANSITIONS } from '@eken/shared'
import { InvoicesService } from './invoices.service'
import { TransitionStatusDto } from './dto/transition-status.dto'
import type { InvoiceStatus } from '@eken/shared'

function makeService(invoiceStatus: string, allocations: Array<{ id: string }> = []) {
  const prisma = {
    invoice: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'inv-1', status: invoiceStatus, invoiceNumber: 'F-2026-0001' }),
      update: jest
        .fn()
        .mockImplementation((arg: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv-1', invoiceNumber: 'F-2026-0001', ...arg.data }),
        ),
    },
    invoicePayment: { findMany: jest.fn().mockResolvedValue(allocations) },
    // A: VOID plockar bort avgiftsraden och drar av den från totalen.
    invoiceLine: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: undefined as unknown,
  }
  ;(prisma as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) => cb(prisma)

  const eventsService = { record: jest.fn().mockResolvedValue({ id: 'evt-1' }) }
  const notificationsService = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const accountingService = {
    reverseJournalEntryForInvoice: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
  }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never, // pdfService
    {} as never, // mailService
    accountingService as never,
    notificationsService as never,
    {} as never, // ocrService
    {} as never, // pdfQueue
  )
  return { service, prisma }
}

// ── A. DTO-lagret: statusen når aldrig servicen via HTTP ──────────────────────
describe('#307 PR 2b · A: PATCH /invoices/:id/status avvisar SENT_TO_COLLECTION redan i ValidationPipe', () => {
  function validate(status: string) {
    // Samma inställningar som den globala pipen i main.ts (whitelist +
    // forbidNonWhitelisted + transform).
    return validateSync(plainToInstance(TransitionStatusDto, { status }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  }

  it('SENT_TO_COLLECTION avvisas av DTO-enumet', () => {
    const errors = validate('SENT_TO_COLLECTION')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.constraints).toHaveProperty('isEnum')
  })

  it('de manuellt använda målvärdena passerar DTO:n oförändrat', () => {
    for (const status of ['DRAFT', 'SENT', 'PARTIAL', 'OVERDUE', 'VOID']) {
      expect(validate(status)).toHaveLength(0)
    }
  })
})

// ── B. Servicespärren: målvärdet nekas oavsett utgångsstatus ─────────────────
describe('#307 PR 2b · B: transitionStatus nekar SENT_TO_COLLECTION som målvärde', () => {
  // BÅDA vägarna: OVERDUE fanns i tabellen före PR 2b, PARTIAL är breddningen.
  it.each(['PARTIAL', 'OVERDUE'])(
    '%s → SENT_TO_COLLECTION avvisas med hänvisning till exportflödet',
    async (from) => {
      const { service, prisma } = makeService(from)

      await expect(
        service.transitionStatus('inv-1', 'org-1', 'SENT_TO_COLLECTION', 'user-1', 'USER'),
      ).rejects.toBeInstanceOf(BadRequestException)

      await expect(
        service.transitionStatus('inv-1', 'org-1', 'SENT_TO_COLLECTION', 'user-1', 'USER'),
      ).rejects.toThrow(/inkassoexporten/i)

      // Ingen skrivning, och ingen transaktion ens påbörjad.
      expect(prisma.invoice.update).not.toHaveBeenCalled()
      expect(prisma.$queryRaw).not.toHaveBeenCalled()
    },
  )

  it('felet pekar ut den väg som faktiskt ska användas', async () => {
    const { service } = makeService('OVERDUE')
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'SENT_TO_COLLECTION', 'user-1', 'USER'),
    ).rejects.toThrow(/POST \/collections\/export\/:invoiceId/)
  })

  it('spärren gäller MÅLVÄRDET, inte utgångsstatusen — SENT_TO_COLLECTION → VOID går igenom', async () => {
    // En faktura som lämnats till inkasso måste fortfarande kunna makuleras
    // (t.ex. återtaget krav). Den kanten finns i tabellen och rörs inte.
    const { service, prisma } = makeService('SENT_TO_COLLECTION')
    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VOID' }) }),
    )
  })
})

// ── C. Inventering: allt annat i statusmaskinen är oförändrat ────────────────
describe('#307 PR 2b · C: övriga manuella statusövergångar oförändrade', () => {
  // HÄRLEDD ur tabellen, inte handskriven — samma princip som
  // COLLECTION_SOURCE_STATUSES. Undantagen är de två målvärden som har en EGEN
  // väg, och båda är spärrade utanför den här filen:
  //   PAID               → controllern hänvisar till POST /invoices/:id/pay
  //                        (betalning utan verifikat, BFL 5 kap 6 §)
  //   SENT_TO_COLLECTION → DTO-enumet + spärren ovan
  const MANUAL_TARGETS: InvoiceStatus[] = ['DRAFT', 'SENT', 'PARTIAL', 'OVERDUE', 'VOID']

  const legalManualPairs = (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).flatMap((from) =>
    INVOICE_TRANSITIONS[from]
      .filter((to) => MANUAL_TARGETS.includes(to))
      .map((to) => [from, to] as const),
  )

  it('inventeringen fångar de kanter serien faktiskt använder', () => {
    // Faller om någon lägger till/tar bort en kant utan att läsa den här filen.
    expect(legalManualPairs).toEqual([
      ['DRAFT', 'SENT'],
      ['DRAFT', 'VOID'],
      ['SENT', 'PARTIAL'],
      ['SENT', 'OVERDUE'],
      ['SENT', 'VOID'],
      ['PARTIAL', 'OVERDUE'],
      ['PARTIAL', 'VOID'],
      ['OVERDUE', 'PARTIAL'],
      ['OVERDUE', 'VOID'],
      ['SENT_TO_COLLECTION', 'VOID'],
    ])
  })

  it.each(legalManualPairs)('%s → %s går igenom', async (from, to) => {
    // Utan allokeringar: VOID-grinden (C4/C5) är en annan spärr och har egna
    // tester i invoices.softdelete.spec.ts — den ska inte skymma den här mätningen.
    const { service, prisma } = makeService(from)
    await service.transitionStatus('inv-1', 'org-1', to, 'user-1', 'USER')
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: to }) }),
    )
  })
})
