import { Prisma } from '@prisma/client'
import { buildFortnoxVoucherDraft } from './export/fortnox-voucher-draft'
import {
  CustomerCreditExportEvidenceError,
  customerCreditJournalDigest,
  readCustomerCreditExportEvidence,
  type CustomerCreditVerifiedExportAnchor,
} from './fortnox-customer-credit-evidence'

type Journal = Parameters<typeof readCustomerCreditExportEvidence>[1]['journal']
const organizationId = 'synthetic-org'
const databaseNumber = 12345
const organizationNumber = '556677-8899'
const hash = 'a'.repeat(64)

function journal(id: string, amount: string, accountNumber = 1510): Journal {
  return {
    id,
    organizationId,
    date: new Date('2026-10-01T00:00:00.000Z'),
    eventDate: null,
    description: 'Syntetiskt bokföringsunderlag',
    reference: null,
    source: 'PAYMENT',
    sourceId: `rent-notice-bank-payment:${id}`,
    aiToolExecutionId: null,
    fiscalYear: 2026,
    series: 'A',
    verNumber: 1,
    reversalOfEntryId: null,
    lines: [
      {
        id: `${id}-bank`,
        journalEntryId: id,
        accountId: 'local-bank',
        debit: new Prisma.Decimal(amount),
        credit: null,
        description: null,
        account: { id: 'local-bank', organizationId, number: 1930, type: 'ASSET' },
      },
      {
        id: `${id}-counter`,
        journalEntryId: id,
        accountId: `local-${accountNumber}`,
        debit: null,
        credit: new Prisma.Decimal(amount),
        description: null,
        account: {
          id: `local-${accountNumber}`,
          organizationId,
          number: accountNumber,
          type: accountNumber === 1510 ? 'ASSET' : 'LIABILITY',
        },
      },
    ],
  }
}

function fixture(customerCreditOrigin = false) {
  const original = journal('source-payment', '1000', customerCreditOrigin ? 2998 : 1510)
  if (customerCreditOrigin) original.sourceId = 'customer-credit-receipt:original-credit'
  const receipt = journal('receipt', '100', 2998)
  receipt.sourceId = 'customer-credit-receipt:credit'
  const binding = {
    organizationId,
    externalDatabaseNumber: databaseNumber,
    evidenceRef: 'synthetic-confirmed',
  }
  const transformed = buildFortnoxVoucherDraft(
    {
      ...original,
      inputOrigin: 'PERSISTED_JOURNAL_ENTRY',
      lines: original.lines.map((l) => ({
        ...l,
        debit: l.debit?.toString() ?? null,
        credit: l.credit?.toString() ?? null,
      })),
    },
    {
      organizationId,
      externalCompany: { databaseNumber, organizationNumber, evidenceRef: 'synthetic-company' },
      financialYear: {
        ...binding,
        localFiscalYear: 2026,
        id: 1,
        voucherYear: 1,
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
      },
      voucherSeries: { ...binding, code: 'A', financialYearId: 1 },
      accounts: original.lines.map((l) => ({
        ...binding,
        localAccountId: l.accountId,
        localAccountNumber: l.account.number,
        externalAccountNumber:
          l.account.number === 1930 ? 1940 : l.account.number === 2998 ? 2997 : 1510,
      })),
      dimensions: { ...binding, mode: 'OMIT', reason: 'syntetiskt testunderlag' },
    },
  )
  if (transformed.status !== 'READY_DRY_RUN') throw new Error(transformed.reason.message)
  const draft = {
    payload: transformed.payload,
    query: transformed.query,
    provenance: transformed.provenance,
    kontomappning: {
      revisionId: 'revision',
      revision: 1,
      contentSha256: hash,
      rader: original.lines.map((l) => ({
        journalEntryLineId: l.id,
        roll:
          l.account.number === 1930
            ? 'LIKVID'
            : l.account.number === 2998
              ? 'KUNDTILLGODOSKULD'
              : 'KUNDFORDRAN',
        behandling: 'EJ_TILLAMPLIG',
        kallkonto: l.account.number,
        malkonto: l.account.number === 1930 ? 1940 : l.account.number === 2998 ? 2997 : 1510,
        mappningsradId: `mapping-${l.id}`,
        mappingRevision: undefined as
          | CustomerCreditVerifiedExportAnchor['mappingRevision']
          | undefined,
        ogonblick: { namn: 'Testkonto', aktiv: true, momskod: null, ar: 1 },
      })),
    },
  }
  const exported = {
    id: 'confirmed-export',
    confirmedAt: new Date(),
    state: 'CONFIRMED',
    organizationId,
    fortnoxDatabaseNumber: databaseNumber,
    journalEntryId: original.id,
    journalEntry: { ...original, reversedBy: null },
    draft,
    draftHash: hash,
    sentPayloadHash: hash,
    externalYear: 1,
    externalSeries: 'A',
    externalNumber: 7,
  }
  const findFirst = jest.fn().mockResolvedValue(exported)
  // Avgränsad Prisma-läsport. Övriga delegatmetoder används aldrig av denna läsare.
  const db = { fortnoxVoucherExport: { findFirst } } as unknown as Parameters<
    typeof readCustomerCreditExportEvidence
  >[0]
  const input: Parameters<typeof readCustomerCreditExportEvidence>[1] = {
    organizationId,
    databaseNumber,
    organizationNumber,
    journal: receipt,
    origins: {
      kind: 'RECEIPT',
      creditId: 'credit',
      eventId: 'credit',
      anchors: [
        {
          journalEntryLineId: receipt.lines[0]!.id,
          originJournalEntryId: original.id,
          originJournalEntryLineId: original.lines[0]!.id,
          role: 'LIKVID',
        },
      ],
    },
  }
  return { db, input, exported, draft, findFirst }
}

describe('kundtillgodots bekräftade originalankare', () => {
  it('binder ursprunglig bankrad och mål även när nya händelsens belopp är ett annat', async () => {
    const f = fixture()
    const result = await readCustomerCreditExportEvidence(f.db, f.input)
    expect(result.anchors).toEqual([
      expect.objectContaining({
        originExportId: 'confirmed-export',
        originJournalEntryLineId: 'source-payment-bank',
        journalEntryLineId: 'receipt-bank',
        role: 'LIKVID',
        targetAccountNumber: 1940,
        amountOre: '100000',
        side: 'Debit',
      }),
    ])
    expect(result.journalDigest).toBe(customerCreditJournalDigest(f.input.journal))
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId,
          journalEntryId: 'source-payment',
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: databaseNumber,
        },
      }),
    )
  })

  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    [
      'annan organisation',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.organizationId = 'other'
      },
    ],
    [
      'annat företag',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.externalCompany.databaseNumber++
      },
    ],
    [
      'annat organisationsnummer',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.externalCompany.organizationNumber = 'other'
      },
    ],
    [
      'annan lokal radidentitet',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.lines[0]!.journalEntryLineId = 'other'
      },
    ],
    [
      'annan kontoproveniens',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.lines[0]!.localAccountId = 'other'
      },
    ],
    [
      'annan payloadmålrad',
      (f: ReturnType<typeof fixture>) => {
        f.draft.payload.Voucher.VoucherRows[0]!.Account = 1941
      },
    ],
    [
      'annat payloadbelopp',
      (f: ReturnType<typeof fixture>) => {
        f.draft.payload.Voucher.VoucherRows[0]!.Debit = 999
      },
    ],
    [
      'annat mappningsmål',
      (f: ReturnType<typeof fixture>) => {
        f.draft.kontomappning.rader[0]!.malkonto = 1941
      },
    ],
    [
      'annan mappningsroll',
      (f: ReturnType<typeof fixture>) => {
        f.draft.kontomappning.rader[0]!.roll = 'KUNDFORDRAN'
      },
    ],
    [
      'saknad mappningsrad',
      (f: ReturnType<typeof fixture>) => {
        f.draft.kontomappning.rader.pop()
      },
    ],
    [
      'dubblerad proveniensrad',
      (f: ReturnType<typeof fixture>) => {
        f.draft.provenance.lines[1] = f.draft.provenance.lines[0]!
      },
    ],
    [
      'annan skickad hash',
      (f: ReturnType<typeof fixture>) => {
        f.exported.sentPayloadHash = 'b'.repeat(64)
      },
    ],
    [
      'annat kvittoår',
      (f: ReturnType<typeof fixture>) => {
        f.exported.externalYear = 2
      },
    ],
    [
      'dimension i originalet',
      (f: ReturnType<typeof fixture>) => {
        f.draft.payload.Voucher.VoucherRows[0]!.CostCenter = 'X'
      },
    ],
  ])('avvisar %s även när originalexporten har CONFIRMED', async (_label, mutate) => {
    const f = fixture()
    mutate(f)
    await expect(readCustomerCreditExportEvidence(f.db, f.input)).rejects.toBeInstanceOf(
      CustomerCreditExportEvidenceError,
    )
  })

  it('kan inte ersätta saknad originalexport med dagens kontomappning', async () => {
    const f = fixture()
    f.findFirst.mockResolvedValue(null)
    await expect(readCustomerCreditExportEvidence(f.db, f.input)).rejects.toBeInstanceOf(
      CustomerCreditExportEvidenceError,
    )
  })

  it('bevarar radens äldre revision när originalmottagningen innehåller blandade revisioner', async () => {
    const f = fixture(true)
    const bankRevision = { id: 'old-bank-revision', revision: 2, contentSha256: 'b'.repeat(64) }
    const liabilityRevision = {
      id: 'new-liability-revision',
      revision: 7,
      contentSha256: 'c'.repeat(64),
    }
    f.draft.kontomappning.revisionId = liabilityRevision.id
    f.draft.kontomappning.revision = liabilityRevision.revision
    f.draft.kontomappning.contentSha256 = liabilityRevision.contentSha256
    f.draft.kontomappning.rader[0]!.mappingRevision = bankRevision
    f.draft.kontomappning.rader[1]!.mappingRevision = liabilityRevision
    const evidence = await readCustomerCreditExportEvidence(f.db, f.input)
    expect(evidence.anchors[0]!.mappingRevision).toEqual(bankRevision)
    expect(evidence.anchors[0]!.mappingRevision.id).not.toBe(f.draft.kontomappning.revisionId)
  })

  it.each(['saknad', 'ogiltig'] as const)(
    'avvisar %s radrevision i en kundtillgodoexport',
    async (kind) => {
      const f = fixture(true)
      for (const row of f.draft.kontomappning.rader) {
        row.mappingRevision = { id: 'revision', revision: 1, contentSha256: hash }
      }
      // Även en icke ankrad rad måste ha bevarad revisionsproveniens.
      f.draft.kontomappning.rader[1]!.mappingRevision =
        kind === 'saknad' ? undefined : { id: 'revision', revision: 0, contentSha256: hash }
      await expect(readCustomerCreditExportEvidence(f.db, f.input)).rejects.toBeInstanceOf(
        CustomerCreditExportEvidenceError,
      )
    },
  )

  it('ger stabil digest vid JSONB-nyckelordning, men binder originalets identitet', async () => {
    const f = fixture()
    const before = await readCustomerCreditExportEvidence(f.db, f.input)
    f.exported.draft = {
      kontomappning: f.draft.kontomappning,
      provenance: f.draft.provenance,
      query: f.draft.query,
      payload: f.draft.payload,
    }
    expect((await readCustomerCreditExportEvidence(f.db, f.input)).digest).toBe(before.digest)
    f.exported.externalNumber++
    expect((await readCustomerCreditExportEvidence(f.db, f.input)).digest).not.toBe(before.digest)
  })

  it('binder den egna verifikationens datum, konton och råtext även med oförändrade belopp', () => {
    const f = fixture()
    const before = customerCreditJournalDigest(f.input.journal)
    f.input.journal.lines[0]!.description = 'Ändrad lokal text'
    expect(customerCreditJournalDigest(f.input.journal)).not.toBe(before)
  })
})
