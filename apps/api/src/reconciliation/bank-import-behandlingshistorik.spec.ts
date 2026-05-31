/**
 * BFL 5 kap 11 § (behandlingshistorik) + 7 kap 2 § (räkenskapsinformation) — issue #34.
 *
 * confirmImport skrev tidigare ÖVER parsedData med den slutgiltiga (ev. redigerade)
 * listan → AI:ns ursprungstolkning förstördes och det gick inte att i efterhand se
 * vad Claude returnerade kontra vad operatören ändrade innan bokföring.
 *
 * Fix: tre distinkta fält bevaras:
 *   originalParsedData — AI:ns råtolkning, sätts EN gång vid PARSED, immutabel
 *   parsedData         — redigerbart preview-tillstånd (granskningsvyn)
 *   confirmedData      — listan som faktiskt commitades, sätts EN gång vid CONFIRMED
 *
 * Dessa tester verifierar att hela kedjan AI → granskning → commit kan rekonstrueras.
 */

jest.mock('./pdf-statement-parser.service', () => ({
  PdfStatementParserService: class {},
  MAX_TX_AMOUNT: 50_000_000,
  DEFAULT_MAX_BANK_TX_AMOUNT: 5_000_000,
}))
jest.mock('./reconciliation.service', () => ({ ReconciliationService: class {} }))
jest.mock('../common/utils/file-validation', () => ({
  validateUploadedFile: jest.fn(),
  DETECTED_PDF_TYPES: ['application/pdf'],
  MAX_PDF_BYTES: 10_000_000,
}))

import { BankStatementImportService } from './bank-statement-import.service'

type AnyFn = jest.Mock

interface PrismaMock {
  bankStatementImport: { create: AnyFn; update: AnyFn; findFirst: AnyFn }
  bankTransaction: { findFirst: AnyFn; create: AnyFn }
  organization: { findUnique: AnyFn }
}

function makePrismaMock(): PrismaMock {
  return {
    bankStatementImport: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    bankTransaction: { findFirst: jest.fn(), create: jest.fn() },
    // #36: resolveMaxTxAmount slår upp org-gränsen (default 5 MSEK).
    organization: { findUnique: jest.fn().mockResolvedValue({ maxBankTxAmount: 5_000_000 }) },
  }
}

const AI_TX = [
  {
    date: '2026-05-01',
    description: 'Hyra Lgh 1',
    ocr: '00123459',
    amount: 8500,
    isIncoming: true,
  },
  { date: '2026-05-02', description: 'Hyra Lgh 2', ocr: null, amount: 7200, isIncoming: true },
]

describe('BankStatementImport — behandlingshistorik (BFL 5 kap 11 §, issue #34)', () => {
  describe('uploadAndParsePdf', () => {
    it('sätter originalParsedData OCH parsedData (identiska) vid PARSED', async () => {
      const prisma = makePrismaMock()
      prisma.bankStatementImport.create.mockResolvedValue({ id: 'imp-1' })
      prisma.bankStatementImport.update.mockResolvedValue({ id: 'imp-1', status: 'PARSED' })
      const parser = {
        parse: jest.fn().mockResolvedValue({
          bank: 'Swedbank',
          accountNumber: '1234',
          periodStart: null,
          periodEnd: null,
          transactions: AI_TX,
        }),
      }
      const service = new BankStatementImportService(prisma as never, parser as never, {} as never)

      await service.uploadAndParsePdf(Buffer.from('%PDF-1.4'), 'utdrag.pdf', 'org-1', 'user-1')

      // Sista update = övergången till PARSED (create-anropet sätter PARSING).
      const parsedUpdate = prisma.bankStatementImport.update.mock.calls.at(-1)![0]
      expect(parsedUpdate.data.status).toBe('PARSED')
      expect(parsedUpdate.data.originalParsedData).toEqual({ transactions: AI_TX })
      expect(parsedUpdate.data.parsedData).toEqual({ transactions: AI_TX })
      // Råtolkningen och preview börjar identiska.
      expect(parsedUpdate.data.originalParsedData).toEqual(parsedUpdate.data.parsedData)
    })
  })

  describe('confirmImport', () => {
    function setupConfirm(prisma: PrismaMock) {
      prisma.bankStatementImport.findFirst.mockResolvedValue({
        id: 'imp-1',
        status: 'PARSED',
        parsedData: { transactions: AI_TX },
        originalParsedData: { transactions: AI_TX },
      })
      prisma.bankTransaction.findFirst.mockResolvedValue(null)
      prisma.bankTransaction.create.mockImplementation((args: { data: unknown }) =>
        Promise.resolve({ id: 'tx-x', ...(args.data as object) }),
      )
      prisma.bankStatementImport.update.mockResolvedValue({})
    }

    it('skriver confirmedData och lämnar parsedData/originalParsedData ORÖRDA', async () => {
      const prisma = makePrismaMock()
      setupConfirm(prisma)
      const reconciliation = { matchTransaction: jest.fn().mockResolvedValue(true) }
      const service = new BankStatementImportService(
        prisma as never,
        {} as never,
        reconciliation as never,
      )

      // Operatören redigerar belopp på rad 1 (8500 → 8400) innan confirm.
      const edited = [
        {
          date: '2026-05-01',
          description: 'Hyra Lgh 1',
          ocr: '00123459',
          amount: 8400,
          isIncoming: true,
        },
        {
          date: '2026-05-02',
          description: 'Hyra Lgh 2',
          ocr: null,
          amount: 7200,
          isIncoming: true,
        },
      ]

      await service.confirmImport('imp-1', 'org-1', 'user-1', edited)

      const update = prisma.bankStatementImport.update.mock.calls.at(-1)![0]
      expect(update.data.status).toBe('CONFIRMED')
      // Den bekräftade (redigerade) listan hamnar i confirmedData.
      expect(update.data.confirmedData.transactions[0].amount).toBe(8400)
      // parsedData OCH originalParsedData får ALDRIG skrivas över vid confirm.
      expect(update.data).not.toHaveProperty('parsedData')
      expect(update.data).not.toHaveProperty('originalParsedData')
    })

    it('confirmedData skiljer sig från originalParsedData när operatören redigerat (diff rekonstruerbar)', async () => {
      const prisma = makePrismaMock()
      setupConfirm(prisma)
      const reconciliation = { matchTransaction: jest.fn().mockResolvedValue(false) }
      const service = new BankStatementImportService(
        prisma as never,
        {} as never,
        reconciliation as never,
      )

      const edited = [
        {
          date: '2026-05-01',
          description: 'Hyra Lgh 1',
          ocr: '00123459',
          amount: 8400,
          isIncoming: true,
        },
      ]
      await service.confirmImport('imp-1', 'org-1', 'user-1', edited)

      const update = prisma.bankStatementImport.update.mock.calls.at(-1)![0]
      const draft = await prisma.bankStatementImport.findFirst.mock.results[0]!.value
      // En granskare kan ta diffen original ↔ confirmed och se ändringen utan svårighet.
      expect(update.data.confirmedData).not.toEqual(draft.originalParsedData)
      expect(draft.originalParsedData.transactions[0].amount).toBe(8500)
      expect(update.data.confirmedData.transactions[0].amount).toBe(8400)
    })

    it('utan redigering speglar confirmedData draftens parsedData', async () => {
      const prisma = makePrismaMock()
      setupConfirm(prisma)
      const reconciliation = { matchTransaction: jest.fn().mockResolvedValue(true) }
      const service = new BankStatementImportService(
        prisma as never,
        {} as never,
        reconciliation as never,
      )

      // Ingen edited-lista → extractFromDraft används.
      await service.confirmImport('imp-1', 'org-1', 'user-1')

      const update = prisma.bankStatementImport.update.mock.calls.at(-1)![0]
      expect(update.data.confirmedData.transactions).toHaveLength(AI_TX.length)
      expect(update.data.confirmedData.transactions[0].amount).toBe(8500)
    })
  })
})
