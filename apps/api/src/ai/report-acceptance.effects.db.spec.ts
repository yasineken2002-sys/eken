jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID, createHash } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { SupplierInvoiceService } from '../accounting/supplier-invoice.service'
import { InvoicesService } from '../invoices/invoices.service'
import { AiAuditService } from './audit/ai-audit.service'
import type { ChatResponse } from './ai-assistant.service'
import { TenantAiService } from './tenant-ai.service'
import { TenantToolExecutorService } from './tools/tenant-tool-executor.service'
import { FortnoxConnectionService } from '../fortnox/fortnox-connection.service'
import { FortnoxExportService } from '../fortnox/fortnox-export.service'
import { FortnoxTokenCryptoService } from '../fortnox/fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from '../fortnox/fortnox-providers'
import { VerifiedVoucherDraftBuilder } from '../fortnox/fortnox-export-builder'
import { FortnoxSendService } from '../fortnox/fortnox-send.service'
import { MockVoucherWriter } from '../fortnox/fortnox-voucher-writer'
import { godkannMappning, leverantorsfaktura } from '../fortnox/fortnox-kontomappning.testing'
import {
  createEvidenceFixture,
  IMPORT_HEADER_207,
  prepareEvidencePackage,
} from '../kundstart/opening-evidence.fixtures'
import { SOURCE_HEADER, MAPPING_HEADER } from '../kundstart/opening-evidence-format'
import {
  assistantRig,
  date,
  done,
  guard,
  INJECTION,
  json,
  QUESTION,
  resultBlocks,
  ROLES,
  sdkScript,
  SEPTEMBER,
  tool,
} from './report-acceptance.fixtures.testing'

jest.setTimeout(120000)
const log = new Logger('AF216-D')

describe('AF03/07/11/12/14/15/16/17/18 D: real pending→confirm and exact synthetic DB effects', () => {
  let connection: PrismaService
  let db: PrismaService
  let accounting: AccountingService
  let org: string
  let other: string
  let owner: string
  let colleague: string
  let otherUser: string
  let foreignInvoice: string
  let foreignTenant: string
  let foreignProperty: string
  let foreignJournal: string
  let foreignConversation: string
  let foreignAttachment: string
  const preserved: string[] = []
  const audits: Promise<unknown>[] = []
  let expectedDatabase: 'eveno_ai_215' | 'eken_dev'

  async function canary() {
    const rows = await connection.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    if (rows.length !== 1 || rows[0]?.db !== expectedDatabase)
      throw new Error('AF216 DB canary mismatch')
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error('AF216 requires C1 synthetic database; no conditional skip')
    const url = new URL(process.env.DATABASE_URL)
    const github = process.env.GITHUB_ACTIONS === 'true'
    if (
      github &&
      process.env.CI === 'true' &&
      url.hostname === 'localhost' &&
      url.port === '5432' &&
      url.pathname === '/eken_dev'
    )
      expectedDatabase = 'eken_dev'
    else if (
      !github &&
      url.hostname === '127.0.0.1' &&
      url.port === '55492' &&
      url.pathname === '/eveno_ai_215'
    )
      expectedDatabase = 'eveno_ai_215'
    else throw new Error('AF216 requires exactly the approved C1-local or GitHub-CI DB profile')
    connection = new PrismaService()
    await connection.$connect()
    await canary()
    // Every query (including mutation/raw SQL) through this client checks DB identity.
    // The canary uses the underlying client, so cannot recurse into this extension.
    db = connection.$extends({
      query: {
        $allOperations: async ({ args, query }) => {
          await canary()
          return query(args)
        },
      },
    }) as unknown as PrismaService
    accounting = new AccountingService(db, new VerifikationsnummerService(db))
    async function organization(tag: string) {
      const id = randomUUID()
      await db.organization.create({
        data: {
          id,
          name: `AF216-${tag}-${id}`,
          email: `${id}@example.invalid`,
          street: 'Syntetgatan',
          city: 'Provstad',
          postalCode: '11111',
          fiscalYearStartMonth: 7,
        },
      })
      preserved.push(id)
      await accounting.seedDefaultAccounts(id)
      return id
    }
    org = await organization('A')
    other = await organization('B_SECRET')
    async function user(organizationId: string) {
      return (
        await db.user.create({
          data: {
            organizationId,
            email: `${randomUUID()}@example.invalid`,
            passwordHash: 'synthetic-no-login',
            firstName: 'Syn',
            lastName: 'Tetisk',
            role: 'OWNER',
          },
        })
      ).id
    }
    owner = await user(org)
    colleague = await user(org)
    otherUser = await user(other)
    foreignProperty = (
      await db.property.create({
        data: {
          organizationId: other,
          name: 'O-B_SECRET_PROPERTY',
          propertyDesignation: randomUUID(),
          type: 'RESIDENTIAL',
          street: 'Syntetgatan',
          city: 'Provstad',
          postalCode: '11111',
          totalArea: 100,
        },
      })
    ).id
    foreignTenant = (
      await db.tenant.create({
        data: {
          organizationId: other,
          type: 'INDIVIDUAL',
          firstName: 'O-B_SECRET_TENANT',
          lastName: 'Syntetisk',
          email: `${randomUUID()}@example.invalid`,
        },
      })
    ).id
    foreignInvoice = (
      await db.invoice.create({
        data: {
          organizationId: other,
          tenantId: foreignTenant,
          invoiceNumber: 'AF216-B',
          type: 'OTHER',
          status: 'SENT',
          subtotal: 10000,
          vatTotal: 0,
          total: 10000,
          issueDate: date('2026-09-01'),
          dueDate: date('2026-09-30'),
        },
      })
    ).id
    const je = await leverantorsfaktura(db, other, {
      belopp: '10000',
      datum: '2026-09-15',
      beskrivning: 'O-B_SECRET_JOURNAL',
    })
    foreignJournal = je.id
    foreignConversation = (
      await db.aiConversation.create({
        data: { organizationId: other, userId: otherUser, title: 'O-B_SECRET_CONVERSATION' },
      })
    ).id
    foreignAttachment = (
      await db.aiAttachment.create({
        data: {
          organizationId: other,
          userId: otherUser,
          filename: 'O-B_SECRET.pdf',
          mimeType: 'application/pdf',
          storageKey: 'synthetic-never-read',
          sizeBytes: 40,
          expiresAt: new Date(Date.now() + 86400000),
        },
      })
    ).id
  })

  beforeEach(async () => {
    await canary()
    await db.organization.update({ where: { id: org }, data: { ledgerOwner: 'EVENO' } })
    await db.user.update({ where: { id: owner }, data: { role: 'OWNER' } })
  })

  afterAll(async () => {
    await Promise.all(audits)
    // Preserve inspectable synthetic evidence, including RED cases. No broad deletion.
    log.log(json({ kind: 'PRESERVED_AF216', organizations: preserved }))
    if (connection) await connection.$disconnect()
  })

  function rig() {
    const audit = new AiAuditService(db)
    const original = audit.logToolExecution.bind(audit)
    jest.spyOn(audit, 'logToolExecution').mockImplementation((...args) => {
      const p = original(...args)
      audits.push(p)
      return p
    })
    const complete = audit.completeToolExecution.bind(audit)
    jest.spyOn(audit, 'completeToolExecution').mockImplementation((...args) => {
      const p = complete(...args)
      audits.push(p)
      return p
    })
    const r = assistantRig(db, { accounting, audit })
    const invoices = Object.create(InvoicesService.prototype) as InvoicesService
    Object.assign(invoices, { prisma: db, accounting })
    const markPaid = jest.spyOn(invoices, 'markAsPaidManually')
    const sendEmail = jest.fn(async () => {
      throw new Error('Forbidden external mail adapter reached')
    })
    Object.assign(r.executor, {
      invoicesService: invoices,
      mailService: { sendHtmlEmail: sendEmail, sendEmail },
    })
    return { ...r, audit, markPaid, sendEmail }
  }

  async function snapshot() {
    await Promise.all(audits)
    const ids = { in: [org, other] }
    const [
      journals,
      lines,
      exports,
      invoices,
      payments,
      notices,
      noticePayments,
      sent,
      notifications,
      foreignConversations,
      foreignMessages,
      pending,
      conversations,
      messages,
    ] = await Promise.all([
      db.journalEntry.count({ where: { organizationId: ids } }),
      db.journalEntryLine.count({ where: { journalEntry: { organizationId: ids } } }),
      db.fortnoxVoucherExport.findMany({
        where: { organizationId: ids },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          state: true,
          sendAttemptId: true,
          sendClaimedAt: true,
          attemptHistory: true,
        },
      }),
      db.invoice.findMany({
        where: { organizationId: ids },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, paidAt: true },
      }),
      db.invoicePayment.count({ where: { invoice: { organizationId: ids } } }),
      db.rentNotice.count({ where: { organizationId: ids } }),
      db.rentNoticePayment.count({ where: { rentNotice: { organizationId: ids } } }),
      db.sentMessage.count({ where: { organizationId: ids } }),
      db.notification.count({ where: { organizationId: ids } }),
      db.aiConversation.count({ where: { organizationId: other } }),
      db.aiMessage.count({ where: { conversation: { organizationId: other } } }),
      db.aiPendingAction.findMany({
        where: { organizationId: ids },
        orderBy: { id: 'asc' },
        select: { id: true, consumedAt: true },
      }),
      db.aiConversation.count({ where: { organizationId: org } }),
      db.aiMessage.count({ where: { conversation: { organizationId: org } } }),
    ])
    return {
      domain: {
        journals,
        lines,
        exports,
        invoices,
        payments,
        notices,
        noticePayments,
        sent,
        notifications,
        foreignConversations,
        foreignMessages,
      },
      pending,
      conversations,
      messages,
    }
  }

  function unchanged(
    before: Awaited<ReturnType<typeof snapshot>>,
    after: Awaited<ReturnType<typeof snapshot>>,
  ) {
    log.log(json({ kind: 'BEFORE_AFTER', before, after }))
    expect(after.domain).toEqual(before.domain)
  }

  const journalInput = () => ({
    date: '2026-09-15',
    description: `AF216-${randomUUID()}`,
    lines: [
      { accountNumber: 5010, debit: 10000 },
      { accountNumber: 2440, credit: 10000 },
    ],
  })

  // Real synthetic binding rows, following report-contract.db.spec.ts. No activation API is exercised.
  async function selectFortnoxLedger(databaseNumber = 101) {
    const conn = await db.fortnoxConnection.upsert({
      where: { organizationId: org },
      create: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: databaseNumber,
        fortnoxOrgNumber: '5560000000',
        exportVoucherSeries: 'A',
        connectedAt: new Date(),
      },
      update: {
        status: 'ACTIVE',
        fortnoxDatabaseNumber: databaseNumber,
        fortnoxOrgNumber: '5560000000',
        exportVoucherSeries: 'A',
      },
    })
    const opening = await db.openingPackage.create({
      data: {
        organizationId: org,
        status: 'EXECUTED',
        cutoverDate: date('2026-07-01'),
        sourceName: 'AF225-synthetic-zero.csv',
        sourceSha256: createHash('sha256').update('AF225 synthetic zero opening').digest('hex'),
        createdById: owner,
        executedAt: new Date(),
        reconciliationStatus: 'AVSTAMD',
        zeroOpening: true,
      },
    })
    const read = await db.fortnoxReadRun.create({
      data: {
        organizationId: org,
        connectionId: conn.id,
        fortnoxDatabaseNumber: databaseNumber,
        status: 'COMPLETE',
        financialYearId: 2026,
        financialYearStart: date('2026-07-01'),
        financialYearEnd: date('2027-06-30'),
        periodFrom: date('2026-07-01'),
        periodTo: date('2026-09-30'),
        costAccounts: [1510, 2890],
        completedAt: new Date(),
        summary: { balanceBroughtForwardOre: { '1510': 0, '2890': 0 } },
      },
    })
    // Preserve prior binding history and respect the one-ACTIVE-per-organisation index.
    await db.fortnoxCustomerActivation.updateMany({
      where: { organizationId: org, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED', supersededAt: new Date() },
    })
    const activation = await db.fortnoxCustomerActivation.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        connectionId: conn.id,
        connectionGeneration: conn.generation,
        fortnoxDatabaseNumber: databaseNumber,
        fortnoxOrgNumber: '5560000000',
        financialYearId: 2026,
        financialYearFrom: date('2026-07-01'),
        financialYearTo: date('2027-06-30'),
        voucherSeries: 'A',
        financialYearAccountingMethod: 'ACCRUAL',
        mappingSha256: createHash('sha256').update('AF225 synthetic mapping').digest('hex'),
        openingPackageId: opening.id,
        fortnoxReadRunId: read.id,
        consequencesText: 'AF225 syntetiskt huvudboksval',
        consequencesSha256: createHash('sha256')
          .update('AF225 syntetiskt huvudboksval')
          .digest('hex'),
        approvedById: owner,
      },
    })
    await db.organization.update({
      where: { id: org },
      data: {
        ledgerOwner: 'FORTNOX',
        ledgerOwnerActivationId: activation.id,
        ledgerOwnerFortnoxDatabaseNumber: activation.fortnoxDatabaseNumber,
        ledgerOwnerFortnoxOrgNumber: activation.fortnoxOrgNumber,
        ledgerOwnerSetAt: activation.approvedAt,
        ledgerOwnerSetById: activation.approvedById,
      },
    })
    return activation
  }

  async function confirm(
    r: ReturnType<typeof rig>,
    proposed: ChatResponse,
    userId = owner,
    role = 'OWNER',
  ) {
    if (!proposed.pendingAction) throw new Error('Expected actual persisted pending action')
    let current = proposed
    for (let i = 0; i < 2 && current.pendingAction; i++) {
      const action = current.pendingAction
      guard(role, 'confirmAction')
      current = await r.controller.confirmAction(
        org,
        { sub: userId, organizationId: org, role } as never,
        {
          toolName: action.toolName,
          toolInput: action.toolInput,
          conversationId: current.conversationId,
          confirmed: true,
        },
      )
    }
    expect(current.pendingAction).toBeUndefined()
    return current
  }

  it('AF11 D read-only creates only own conversation/two messages; zero domain/pending changes', async () => {
    const sdk = sdkScript([tool('get_profit_loss_report', SEPTEMBER), done()])
    const before = await snapshot()
    await rig().ai.chat(org, owner, 'OWNER', QUESTION)
    const after = await snapshot()
    unchanged(before, after)
    expect(after.pending).toEqual(before.pending)
    expect(after.conversations - before.conversations).toBe(1)
    expect(after.messages - before.messages).toBe(2)
    expect(resultBlocks(sdk.requests)[0]?.['success']).toBe(true)
    expect(json(sdk.requests)).not.toContain('O-B_SECRET')
  })

  it('AF11 D control: real pending→confirm creates exactly one journal/two lines and replay no second effect', async () => {
    sdkScript([tool('create_journal_entry', journalInput())])
    const r = rig()
    const before = await snapshot()
    const proposal = await r.ai.chat(
      org,
      owner,
      'OWNER',
      'Bokför den uttryckligt syntetiska kostnaden.',
    )
    const pending = await snapshot()
    unchanged(before, pending)
    expect(pending.pending.length - before.pending.length).toBe(1)
    const response = await confirm(r, proposal)
    const after = await snapshot()
    expect(response.reply).toContain('Verifikat skapat')
    expect(after.domain.journals - before.domain.journals).toBe(1)
    expect(after.domain.lines - before.domain.lines).toBe(2)
    expect(after.domain.exports).toEqual(before.domain.exports)
    await expect(confirm(r, proposal)).rejects.toThrow(/redan utförd/)
    expect((await snapshot()).domain).toEqual(after.domain)
  })

  it.each(['owner-switch', 'binding-switch', 'AUTH_LOST'])(
    'AF11 AF07 AF12 D %s between proposal and confirmation causes zero journal/export/payment/mail effects',
    async (variant) => {
      sdkScript([tool('create_journal_entry', journalInput())])
      const r = rig()
      const bindingBefore = variant !== 'owner-switch' ? await selectFortnoxLedger() : null
      const proposal = await r.ai.chat(org, owner, 'OWNER', 'Förbered en syntetisk bokning.')
      if (variant !== 'AUTH_LOST') {
        const bindingAfter = await selectFortnoxLedger(variant === 'binding-switch' ? 202 : 101)
        if (variant === 'binding-switch') {
          expect(bindingAfter.id).not.toBe(bindingBefore!.id)
          expect(bindingAfter.fortnoxDatabaseNumber).toBe(202)
          expect(bindingBefore!.fortnoxDatabaseNumber).toBe(101)
        }
      }
      if (variant === 'AUTH_LOST')
        await db.fortnoxConnection.upsert({
          where: { organizationId: org },
          create: { organizationId: org, status: 'AUTH_LOST', fortnoxDatabaseNumber: 101 },
          update: { status: 'AUTH_LOST', fortnoxDatabaseNumber: 101 },
        })
      const before = await snapshot()
      const answer = await confirm(r, proposal)
      const after = await snapshot()
      unchanged(before, after)
      expect(answer.reply).toMatch(/misslyckades|Fortnox/)
      expect(after.pending.length).toBe(before.pending.length)
      expect(
        after.pending.filter((p) => p.consumedAt).length -
          before.pending.filter((p) => p.consumedAt).length,
      ).toBe(1)
      expect(after.conversations).toBe(before.conversations)
      expect(after.messages - before.messages).toBe(1)
    },
  )

  it.each(ROLES)(
    'AF16 D role change OWNER→%s: real controller/confirm cannot book under F',
    async (role) => {
      const sdk = sdkScript([tool('create_journal_entry', journalInput()), done()])
      const r = rig()
      const proposal = await r.ai.chat(org, owner, 'OWNER', 'Förbered en bokning.')
      if (role !== 'UNKNOWN') await db.user.update({ where: { id: owner }, data: { role } })
      await selectFortnoxLedger()
      const before = await snapshot()
      if (role === 'VIEWER' || role === 'UNKNOWN') {
        expect(() => guard(role, 'chat')).toThrow()
        await expect(confirm(r, proposal, owner, role)).rejects.toThrow()
        expect((await snapshot()).pending).toEqual(before.pending)
      } else {
        guard(role, 'chat')
        await r.controller.chat(org, { sub: owner, organizationId: org, role } as never, {
          message: QUESTION,
        })
        if (role === 'ACCOUNTANT') {
          expect(json(sdk.requests[1]?.system)).toContain(
            'Fortnox-belopp är inte tillgängliga för denna läsbehörighet',
          )
          expect(json(sdk.requests[1]?.system)).not.toMatch(/40\s?000|120\s?000/)
        }
        const answer = await confirm(r, proposal, owner, role)
        expect(answer.reply).toMatch(/misslyckades|behörighet|Fortnox/)
      }
      const after = await snapshot()
      unchanged(before, after)
      const allowed = role !== 'VIEWER' && role !== 'UNKNOWN'
      expect(after.conversations - before.conversations).toBe(allowed ? 1 : 0)
      expect(after.messages - before.messages).toBe(allowed ? 3 : 0)
      expect(after.pending.length).toBe(before.pending.length)
      expect(
        after.pending.filter((p) => p.consumedAt).length -
          before.pending.filter((p) => p.consumedAt).length,
      ).toBe(allowed ? 1 : 0)
    },
  )

  it('AF17 D other-org and same-org-other-user cannot chat/confirm a foreign conversation or read attachment', async () => {
    const sdk = sdkScript([tool('create_journal_entry', journalInput())])
    const r = rig()
    const proposal = await r.ai.chat(org, owner, 'OWNER', 'Förbered endast.')
    const before = await snapshot()
    await expect(confirm(r, proposal, colleague)).rejects.toThrow('Konversation hittades inte')
    await expect(r.ai.chat(org, owner, 'OWNER', QUESTION, foreignConversation)).rejects.toThrow(
      'Konversation hittades inte',
    )
    await expect(
      r.ai.chat(org, colleague, 'OWNER', QUESTION, proposal.conversationId),
    ).rejects.toThrow('Konversation hittades inte')
    await expect(
      r.ai.chat(org, owner, 'OWNER', QUESTION, proposal.conversationId, [foreignAttachment]),
    ).rejects.toThrow('Bilagan hittades inte')
    const after = await snapshot()
    unchanged(before, after)
    expect(after.pending).toEqual(before.pending)
    expect(after.conversations).toBe(before.conversations)
    expect(after.messages).toBe(before.messages)
    expect(r.storage.getFileBuffer).not.toHaveBeenCalled()
    expect(sdk.requests).toHaveLength(1)
    expect(json(sdk.requests)).not.toContain('O-B_SECRET')
  })

  it('AF17 D foreign journal/property are not disclosed through chat read tools', async () => {
    const sdk = sdkScript([
      tool('get_journal_entries', {
        ...SEPTEMBER,
        journalEntryId: foreignJournal,
        organizationId: other,
      }),
      tool(
        'get_profit_loss_report',
        { ...SEPTEMBER, propertyId: foreignProperty, organizationId: other },
        'property',
      ),
      done(),
    ])
    const before = await snapshot()
    await rig().ai.chat(org, owner, 'OWNER', 'Läs min organisations underlag.')
    const after = await snapshot()
    unchanged(before, after)
    expect(after.pending).toEqual(before.pending)
    expect(json(resultBlocks(sdk.requests))).not.toContain('O-B_SECRET')
    expect(json(resultBlocks(sdk.requests))).not.toContain(foreignJournal)
    expect(json(resultBlocks(sdk.requests))).toContain('PROPERTY_ALLOCATION_UNVERIFIED')
    expect(after.conversations - before.conversations).toBe(1)
    expect(after.messages - before.messages).toBe(2)
    // Also exercise actual single-entry scoping; chat list ignores unknown entryId.
    await expect(accounting.getJournalEntry(foreignJournal, org)).rejects.toThrow(
      'Verifikation hittades inte',
    )
  })

  it.each(['mark_invoice_paid', 'compose_and_send_email'])(
    'AF18 D adversarial %s for O-B has no effect before or after actual confirmation',
    async (name) => {
      const input =
        name === 'mark_invoice_paid'
          ? {
              organizationId: other,
              invoiceId: foreignInvoice,
              amount: 10000,
              paymentMethod: 'MANUAL',
            }
          : {
              organizationId: other,
              tenantIds: [foreignTenant],
              subject: 'Syntetiskt',
              body: INJECTION,
              to: 'external@example.invalid',
            }
      const sdk = sdkScript([tool(name, input)])
      const r = rig()
      const before = await snapshot()
      const proposal = await r.ai.chat(org, owner, 'OWNER', 'Sammanfatta endast underlaget.')
      const pending = await snapshot()
      unchanged(before, pending)
      expect(pending.pending.length - before.pending.length).toBe(1)
      const answer = await confirm(r, proposal)
      const after = await snapshot()
      unchanged(before, after)
      expect(answer.reply).toMatch(/misslyckades|hittades inte|Inga giltiga/)
      expect(r.markPaid).not.toHaveBeenCalled()
      expect(r.sendEmail).not.toHaveBeenCalled()
      expect(after.pending.length - before.pending.length).toBe(1)
      expect(
        after.pending.filter((p) => p.consumedAt).length -
          before.pending.filter((p) => p.consumedAt).length,
      ).toBe(1)
      expect(after.conversations - before.conversations).toBe(1)
      expect(after.messages - before.messages).toBe(2)
      expect(json(sdk.requests)).not.toContain('O-B_SECRET')
    },
  )

  it('AF14 D crash state consumed pending without execution trace yields honest unknown and no replay', async () => {
    sdkScript([tool('create_journal_entry', journalInput())])
    const r = rig()
    const proposal = await r.ai.chat(org, owner, 'OWNER', 'Förbered endast.')
    // Explicit fault fixture AFTER real proposal: crash between atomic claim and executor.
    // No actionProof is manufactured and no executor is invoked directly.
    await db.aiPendingAction.updateMany({
      where: { conversationId: proposal.conversationId },
      data: { consumedAt: new Date() },
    })
    const before = await snapshot()
    await expect(confirm(r, proposal)).rejects.toThrow('går INTE att bekräfta')
    const after = await snapshot()
    expect(after).toEqual(before)
    expect(
      await db.aiToolExecution.count({ where: { conversationId: proposal.conversationId } }),
    ).toBe(0)
  })

  async function exportRig() {
    const config = {
      get: (key: string) => (key === 'FORTNOX_TOKEN_KEY' ? 'cd'.repeat(32) : undefined),
    }
    const reader = new MockFortnoxLedgerReader()
    const connections = new FortnoxConnectionService(
      db,
      new FortnoxTokenCryptoService(config as never),
      config as never,
      new MockFortnoxAuthProvider(),
      reader,
    )
    const { authUrl } = await connections.begin(org, owner)
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org, 'A')
    await connections.setExportOmitDimensions(org, owner, true)
    await godkannMappning(db, connections, reader, org)
    const builder = new VerifiedVoucherDraftBuilder(db, connections, reader)
    const exports = new FortnoxExportService(db, builder)
    const writer = new MockVoucherWriter(reader)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const journal = await leverantorsfaktura(db, org, { belopp: '10000', datum: '2026-09-15' })
    const row = await exports.dryRun(org, journal.id)
    expect(row.state).toBe('DRY_RUN_READY')
    if (!row.draftHash) throw new Error('READY missing draftHash')
    return { writer, sender, exports, journal, row, hash: row.draftHash }
  }

  it('AF15-A D old READY is unusable after real local cancellation; actual send obtains zero claims', async () => {
    const r = await exportRig()
    const invoiceId = r.journal.sourceId!.slice('supplier-invoice:'.length)
    await new SupplierInvoiceService(db, accounting).cancel({
      organizationId: org,
      invoiceId,
      createdById: owner,
    })
    const before = await db.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: r.row.id } })
    expect(before.state).toBe('BLOCKED')
    expect(before.sendAttemptId).toBeNull()
    await expect(r.sender.send(org, owner, r.row.id, r.hash)).rejects.toThrow(
      'Verifikatet kan inte skickas i sitt nuvarande läge',
    )
    const after = await db.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: r.row.id } })
    expect(after.sendAttemptId).toBeNull()
    expect(after.sendClaimedAt).toBeNull()
    expect(after.attemptHistory).toEqual(before.attemptHistory)
    expect(r.writer.writes).toBe(0)
    log.log(
      json({
        case: 'AF15-A',
        exportId: after.id,
        before: before.state,
        after: after.state,
        claims: 0,
        providerWrites: r.writer.writes,
      }),
    )
  })

  it('AF15-B D UNKNOWN original cannot promise correction export', async () => {
    const r = await exportRig()
    r.writer.faults.push('unknown_after_write')
    const unknown = await r.sender.send(org, owner, r.row.id, r.hash)
    expect(unknown.state).toBe('UNKNOWN')
    const before = await snapshot()
    const invoiceId = r.journal.sourceId!.slice('supplier-invoice:'.length)
    // F217-1: one fixed oracle. UNKNOWN does not undo the local cancellation;
    // it blocks the correction's external export until the original is reconciled.
    const cancelled = await new SupplierInvoiceService(db, accounting).cancel({
      organizationId: org,
      invoiceId,
      createdById: owner,
    })
    expect(cancelled.cancelledAt).not.toBeNull()
    expect((await snapshot()).domain.journals - before.domain.journals).toBe(1)
    const correction = await db.journalEntry.findFirstOrThrow({
      where: { organizationId: org, sourceId: { contains: invoiceId }, id: { not: r.journal.id } },
    })
    const draft = await r.exports.dryRun(org, correction.id)
    expect(draft.state).toBe('BLOCKED')
    expect(draft.draftHash).toBeNull()
    expect(draft.blockReason).toContain('ORIGIN_NOT_CONFIRMED')
    expect(
      (await db.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: r.row.id } })).state,
    ).toBe('UNKNOWN')
    const sdk = sdkScript([tool('get_profit_loss_report', SEPTEMBER), done()])
    await selectFortnoxLedger()
    await rig().ai.chat(org, owner, 'OWNER', 'Kan rättelsen betraktas som exporterad?')
    expect(json(resultBlocks(sdk.requests))).toContain('EXTERNAL_REPORT_UNAVAILABLE')
    expect(r.writer.writes).toBe(1)
  })

  it('AF03 D historical2000 binds real OpeningPackage/OpeningEvidence; no invented independent15500 bridge', async () => {
    const csv =
      IMPORT_HEADER_207 + '\nDOC-1;FORDRAN;7771000011;K-1;;;2026;10;2026-10-31;2000;2000;;0;0'
    const f = await createEvidenceFixture(db, 'AF03-216', csv)
    preserved.push(f.id)
    await prepareEvidencePackage(db, f, 200000)
    const independent =
      SOURCE_HEADER +
      '\nSYNTHETIC_191;A;K-1;DOC-1;RECEIVABLE;2026-10;2026-10-31;200000;0;0;200000;;'
    f.input.sourceContent = independent
    // Only A/K-1 has a source document; the fixture's default B/K-2 mapping is extra.
    f.input.mappingContent =
      MAPPING_HEADER +
      `\nSYNTHETIC_191;A;K-1;${f.tenants[0]!.id};${f.leases[0]!.id};syntetisk kontraktskontroll`
    const evidence = await f.evidence.create(f.id, f.pkg.id, f.admin, f.input)
    if (evidence.comparisonStatus !== 'OK')
      log.error(
        json({
          case: 'AF03-evidence',
          comparisonStatus: evidence.comparisonStatus,
          stopp: evidence.stopp,
          avvikelser: evidence.avvikelser,
        }),
      )
    expect(evidence.comparisonStatus).toBe('OK')
    expect(evidence.stopp).toEqual([])
    expect(evidence.avvikelser).toEqual([])
    await f.evidence.review(f.id, f.pkg.id, evidence.id, f.accountant, {
      evidenceSha256: evidence.evidenceSha256,
    })
    const pkg = await db.openingPackage.findUniqueOrThrow({ where: { id: f.pkg.id } })
    await f.packages.approve(f.id, f.pkg.id, f.owner, {
      version: pkg.version,
      sourceSha256: pkg.sourceSha256,
      evidenceSha256: evidence.evidenceSha256,
    })
    await f.packages.execute(f.id, f.pkg.id, f.owner)
    const actual = await db.openingEvidence.findUniqueOrThrow({ where: { id: evidence.id } })
    const sdk = sdkScript([done()])
    await rig().ai.chat(
      f.id,
      f.owner.sub,
      'OWNER',
      'Förklara historisk skuld och en eventuell skillnad mot1510; gissa inte saldo15500.',
    )
    const system = json(sdk.requests[0]?.system)
    expect(system).toMatch(/2\s000/)
    expect(system).toMatch(/historisk/i)
    expect(system).not.toMatch(/15\s?500/)
    expect(system).not.toMatch(/11\s?500/)
    expect(system).toContain('inte en full balansräkning')
    log.log(
      json({
        case: 'AF03',
        packageId: pkg.id,
        packageSha256: pkg.sourceSha256,
        independentBytesSha256: createHash('sha256').update(independent).digest('hex'),
        evidenceId: actual.id,
        evidenceSha256: actual.evidenceSha256,
        historicalOre: 200000,
        independent15500Source: null,
        fullBridge: 'NOT_DETERMINABLE',
      }),
    )
  })

  it('AF17 D tenant chat refuses organisation accounting tool at real executor boundary', async () => {
    const sdk = sdkScript([
      tool('get_profit_loss_report', { ...SEPTEMBER, organizationId: org }),
      done(),
    ])
    const r = rig()
    const tenantExecutor = new TenantToolExecutorService(
      db,
      {} as never,
      {} as never,
      r.audit,
      {} as never,
    )
    const tenantAi = new TenantAiService(
      db,
      { get: () => 'SYNTHETIC_TRANSPORT_ONLY' } as never,
      tenantExecutor,
      r.usage as never,
    )
    const before = await snapshot()
    await tenantAi.chat(foreignTenant, other, 'Visa organisationens resultat.')
    const after = await snapshot()
    // Tenant conversation/message writes are separately permitted; all operator/domain counts identical.
    expect(after).toEqual(before)
    expect(json(sdk.requests[0]?.tools)).not.toContain('get_profit_loss_report')
    expect(resultBlocks(sdk.requests)[0]).toMatchObject({ success: false })
    expect(json(resultBlocks(sdk.requests))).not.toMatch(/140000|120000/)
  })
})
