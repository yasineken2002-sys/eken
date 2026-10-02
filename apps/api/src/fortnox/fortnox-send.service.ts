import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type FortnoxVoucherExport } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import {
  FORTNOX_VOUCHER_DRAFT_BUILDER,
  type FortnoxVoucherDraftBuilder,
} from './fortnox-export.service'
import { toOre } from './fortnox-ledger'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import {
  FORTNOX_VOUCHER_WRITER,
  FortnoxWriteError,
  type FortnoxVoucherWriter,
} from './fortnox-voucher-writer'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

/**
 * Säker sändning och avstämning av Evenos verifikat mot Fortnox (FORTNOX-SANDNING).
 * Kontrakt: FORTNOX-SANDNING-20261001/CLAUDE1/KONTRAKT.md.
 *
 *  - EN sändare: beständigt anspråk (DRY_RUN_READY → SENDING) villkorat i databasen
 *    FÖRE nätanropet. Inga processlokala lås.
 *  - Fryst underlag: payload/hash, anslutning, generation, företag, år och serie
 *    binds vid anspråket; färsk förhandskontroll måste ge exakt samma hash.
 *  - Okänt utfall stoppar: endast lokalt bevisat not_sent återför till READY.
 *    Utgången lease → UNKNOWN (aldrig återköning). Ingen POST-retry.
 *  - Bekräftelse kräver exakt identitet (företag, år, serie, nummer) OCH återläst
 *    innehåll lika det frysta underlaget. Kvitto utan verifiering är eget tillstånd.
 */

const LEASE_MS = 120_000
const LOCKED_FOR_RECONCILE = ['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH'] as const

export const EXPORT_VIEW = {
  id: true,
  journalEntryId: true,
  state: true,
  blockReason: true,
  draftHash: true,
  lastOutcome: true,
  externalYear: true,
  externalSeries: true,
  externalNumber: true,
  sendConfirmedAt: true,
  receiptAt: true,
  confirmedAt: true,
  reconciledAt: true,
  updatedAt: true,
} satisfies Prisma.FortnoxVoucherExportSelect

interface FrozenDraft {
  payload: {
    Voucher: { TransactionDate?: unknown; VoucherSeries?: unknown; VoucherRows?: unknown }
  }
  query: { financialyear: number }
}

export type CompareResult = 'MATCH' | 'MISMATCH' | 'NOT_FOUND' | 'READ_FAILED' | 'WRONG_COMPANY'

/** Rader som multimängd (konto, debet öre, kredit öre); saknad sida = 0, ogiltigt = null. */
function rowKeys(rows: unknown): string[] | null {
  if (!Array.isArray(rows)) return null
  const out: string[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') return null
    const x = r as Record<string, unknown>
    if (x.Removed === true) return null
    const d = x.Debit === undefined || x.Debit === null ? 0 : toOre(x.Debit)
    const c = x.Credit === undefined || x.Credit === null ? 0 : toOre(x.Credit)
    if (typeof x.Account !== 'number' || d === null || c === null) return null
    out.push(`${x.Account}|${d}|${c}`)
  }
  return out.sort()
}

/** Exakt jämförelse mellan återläst post och fryst underlag (datum, serie, år, rader). */
export function compareVoucher(
  frozen: FrozenDraft,
  read: Record<string, unknown>,
  identity: { year: number; series: string; number: number },
): boolean {
  const f = frozen.payload.Voucher
  if (
    read.Year !== identity.year ||
    read.VoucherSeries !== identity.series ||
    read.VoucherNumber !== identity.number
  )
    return false
  if (identity.year !== frozen.query.financialyear || identity.series !== f.VoucherSeries)
    return false
  if (read.TransactionDate !== f.TransactionDate) return false
  const a = rowKeys(f.VoucherRows)
  const b = rowKeys(read.VoucherRows)
  return (
    a !== null &&
    b !== null &&
    a.length > 0 &&
    a.length === b.length &&
    a.every((k, i) => k === b[i])
  )
}

@Injectable()
export class FortnoxSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_VOUCHER_DRAFT_BUILDER) private readonly builder: FortnoxVoucherDraftBuilder,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
    @Inject(FORTNOX_VOUCHER_WRITER) private readonly writer: FortnoxVoucherWriter,
  ) {}

  get sendingEnabled(): boolean {
    return this.writer.capable
  }

  /** Utgångna anspråk blir UNKNOWN (lazy). Aldrig återköning. */
  async expireLeases(organizationId: string): Promise<number> {
    const res = await this.prisma.fortnoxVoucherExport.updateMany({
      where: { organizationId, state: 'SENDING', sendLeaseUntil: { lt: new Date() } },
      data: { state: 'UNKNOWN', lastOutcome: 'LEASE_EXPIRED', lastOutcomeAt: new Date() },
    })
    return res.count
  }

  private view(organizationId: string, id: string) {
    return this.prisma.fortnoxVoucherExport.findFirstOrThrow({
      where: { id, organizationId },
      select: EXPORT_VIEW,
    })
  }

  async send(organizationId: string, userId: string, exportId: string, draftHash: string) {
    if (!this.writer.capable) {
      throw new ConflictException('SENDING_DISABLED: Sändning till Fortnox är inte aktiverad')
    }
    await this.expireLeases(organizationId)
    const row = await this.prisma.fortnoxVoucherExport.findFirst({
      where: { id: exportId, organizationId },
    })
    if (!row) throw new NotFoundException('Exportraden hittades inte')
    const stale = 'Underlaget är inte längre aktuellt; gör en ny förhandskontroll'
    if (row.state !== 'DRY_RUN_READY' || !row.draftHash || row.draftHash !== draftHash) {
      throw new ConflictException(
        row.state === 'DRY_RUN_READY'
          ? stale
          : 'Verifikatet kan inte skickas i sitt nuvarande läge',
      )
    }
    // Färsk förhandskontroll: samma underlag, konfiguration, år, serie och företag.
    const fresh = await this.builder.build(organizationId, row.journalEntryId)
    if (!fresh.ok || fresh.draftHash !== draftHash) throw new ConflictException(stale)
    const draft = fresh.draft as unknown as FrozenDraft
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn || conn.status !== 'ACTIVE') throw new ConflictException('Fortnox är inte anslutet')

    const attemptId = randomUUID()
    const now = new Date()
    const claim = await this.prisma.fortnoxVoucherExport.updateMany({
      where: { id: row.id, organizationId, state: 'DRY_RUN_READY', draftHash },
      data: {
        state: 'SENDING',
        sendAttemptId: attemptId,
        sendClaimedAt: now,
        sendLeaseUntil: new Date(now.getTime() + LEASE_MS),
        sendConnectionId: conn.id,
        sendGeneration: conn.generation,
        fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
        sendFinancialYear: draft.query.financialyear,
        sendSeries: String(draft.payload.Voucher.VoucherSeries),
        sentPayloadHash: draftHash,
        draft: fresh.draft as Prisma.InputJsonValue,
        sendConfirmedBy: userId,
        sendConfirmedAt: now,
        lastOutcome: 'CLAIMED',
        lastOutcomeAt: now,
      },
    })
    if (claim.count !== 1)
      throw new ConflictException('Verifikatet skickas redan eller har ändrats')

    const bind = { id: row.id, organizationId, sendAttemptId: attemptId }
    const backToReady = async (outcome: string) => {
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: { id: row.id, organizationId, sendAttemptId: attemptId, state: 'SENDING' },
        data: {
          state: 'DRY_RUN_READY',
          sendAttemptId: null,
          sendLeaseUntil: null,
          lastOutcome: outcome,
          lastOutcomeAt: new Date(),
        },
      })
    }
    const lock = async (state: 'UNKNOWN' | 'REJECTED', outcome: string) => {
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: { id: row.id, organizationId, sendAttemptId: attemptId, state: 'SENDING' },
        data: { state, lastOutcome: outcome, lastOutcomeAt: new Date() },
      })
    }

    // Token + omläsning av anslutningen: byte/frånkoppling efter anspråket är lokalt
    // bevisat not_sent (inget har lämnat processen).
    let token: string
    try {
      const auth = await this.connections.accessToken(organizationId)
      token = auth.token
      const again = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
      if (
        auth.connectionId !== conn.id ||
        !again ||
        again.status !== 'ACTIVE' ||
        again.generation !== conn.generation ||
        again.fortnoxDatabaseNumber !== conn.fortnoxDatabaseNumber
      ) {
        await backToReady('NOT_SENT_CONNECTION_CHANGED')
        throw new ConflictException('Fortnox-anslutningen ändrades; gör en ny förhandskontroll')
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err
      await backToReady('NOT_SENT_NO_TOKEN')
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException('Fortnox-anslutningen kan inte användas just nu')
      throw err
    }

    let body: unknown
    try {
      body = await this.writer.createVoucher(token, draft.query, draft.payload)
    } catch (err) {
      if (err instanceof FortnoxWriteError && err.outcome === 'not_sent') {
        await backToReady('NOT_SENT')
      } else if (err instanceof FortnoxWriteError && err.outcome === 'rejected') {
        await lock('REJECTED', 'REJECTED')
      } else {
        await lock(
          'UNKNOWN',
          err instanceof FortnoxWriteError ? 'OUTCOME_UNKNOWN' : 'OUTCOME_UNKNOWN_ERROR',
        )
      }
      return this.view(organizationId, row.id)
    }

    const v = (body as { Voucher?: Record<string, unknown> } | null)?.Voucher
    const identity =
      v &&
      v.Year === draft.query.financialyear &&
      v.VoucherSeries === draft.payload.Voucher.VoucherSeries &&
      typeof v.VoucherNumber === 'number' &&
      Number.isSafeInteger(v.VoucherNumber) &&
      v.VoucherNumber > 0
        ? { year: v.Year as number, series: v.VoucherSeries as string, number: v.VoucherNumber }
        : null
    if (!identity) {
      // Ogiltigt "lyckat" svar: kan ha skrivits → låst.
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: {
          id: row.id,
          organizationId,
          sendAttemptId: attemptId,
          state: { in: ['SENDING', 'UNKNOWN'] },
          reconciledAt: null,
        },
        data: { state: 'UNKNOWN', lastOutcome: 'INVALID_SUCCESS', lastOutcomeAt: new Date() },
      })
      return this.view(organizationId, row.id)
    }
    await this.recordReceipt(organizationId, bind, identity)
    await this.verify(organizationId, row.id).catch(() => undefined)
    return this.view(organizationId, row.id)
  }

  /**
   * Kvitto (identitet). Bunden till försöket; ett sent svar får landa från SENDING
   * eller UNKNOWN för SAMMA försök, aldrig efter avstämning och aldrig över CONFIRMED.
   */
  async recordReceipt(
    organizationId: string,
    bind: { id: string; organizationId: string; sendAttemptId: string },
    identity: { year: number; series: string; number: number },
  ): Promise<boolean> {
    try {
      const res = await this.prisma.fortnoxVoucherExport.updateMany({
        where: {
          ...bind,
          organizationId,
          state: { in: ['SENDING', 'UNKNOWN'] },
          reconciledAt: null,
        },
        data: {
          state: 'RECEIPT_IDENTIFIED',
          externalYear: identity.year,
          externalSeries: identity.series,
          externalNumber: identity.number,
          receiptAt: new Date(),
          lastOutcome: 'RECEIPT',
          lastOutcomeAt: new Date(),
        },
      })
      return res.count === 1
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        await this.prisma.fortnoxVoucherExport.updateMany({
          where: { ...bind, organizationId, state: 'SENDING' },
          data: {
            state: 'UNKNOWN',
            lastOutcome: 'RECEIPT_IDENTITY_CONFLICT',
            lastOutcomeAt: new Date(),
          },
        })
        return false
      }
      throw err
    }
  }

  /** Läser EXAKT identiteten i rätt företag och jämför med det frysta underlaget. */
  async readAndCompare(
    organizationId: string,
    row: FortnoxVoucherExport,
    identity: { year: number; series: string; number: number },
  ): Promise<CompareResult> {
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch {
      return 'READ_FAILED'
    }
    if (row.fortnoxDatabaseNumber === null || auth.databaseNumber !== row.fortnoxDatabaseNumber)
      return 'WRONG_COMPANY'
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    try {
      const ci = await reader.get<{ CompanyInformation?: { DatabaseNumber?: unknown } }>(
        auth.token,
        '/3/companyinformation',
      )
      if (ci?.CompanyInformation?.DatabaseNumber !== row.fortnoxDatabaseNumber)
        return 'WRONG_COMPANY'
      const body = await reader.get<{ Voucher?: Record<string, unknown> }>(
        auth.token,
        `/3/vouchers/${identity.series}/${identity.number}`,
        { financialyear: identity.year },
      )
      if (!body?.Voucher) return 'NOT_FOUND'
      // K-S2: anslutningen får inte ha bytt företag under läsningen.
      const after = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
      if (
        !after ||
        after.id !== auth.connectionId ||
        after.fortnoxDatabaseNumber !== row.fortnoxDatabaseNumber
      )
        return 'WRONG_COMPANY'
      return compareVoucher(row.draft as unknown as FrozenDraft, body.Voucher, identity)
        ? 'MATCH'
        : 'MISMATCH'
    } catch (err) {
      if (err instanceof FortnoxReadError && err.kind === 'invalid') return 'NOT_FOUND'
      return 'READ_FAILED'
    }
  }

  /** RECEIPT_IDENTIFIED → CONFIRMED / RECEIPT_MISMATCH; saknas eller läsfel → oförändrat. */
  async verify(organizationId: string, exportId: string) {
    await this.expireLeases(organizationId)
    const row = await this.prisma.fortnoxVoucherExport.findFirst({
      where: { id: exportId, organizationId },
    })
    if (!row) throw new NotFoundException('Exportraden hittades inte')
    if (
      row.state !== 'RECEIPT_IDENTIFIED' ||
      row.externalYear === null ||
      row.externalSeries === null ||
      row.externalNumber === null
    ) {
      throw new ConflictException('Det finns inget kvitto att verifiera')
    }
    const identity = {
      year: row.externalYear,
      series: row.externalSeries,
      number: row.externalNumber,
    }
    const result = await this.readAndCompare(organizationId, row, identity)
    if (result === 'MATCH' || result === 'MISMATCH' || result === 'WRONG_COMPANY') {
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: {
          id: row.id,
          organizationId,
          state: 'RECEIPT_IDENTIFIED',
          externalYear: identity.year,
          externalSeries: identity.series,
          externalNumber: identity.number,
        },
        data:
          result === 'MATCH'
            ? {
                state: 'CONFIRMED',
                confirmedAt: new Date(),
                lastOutcome: 'VERIFIED',
                lastOutcomeAt: new Date(),
              }
            : {
                state: 'RECEIPT_MISMATCH',
                lastOutcome: result === 'MISMATCH' ? 'READBACK_MISMATCH' : 'READBACK_WRONG_COMPANY',
                lastOutcomeAt: new Date(),
              },
      })
    } else {
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: { id: row.id, organizationId, state: 'RECEIPT_IDENTIFIED' },
        data: {
          lastOutcome: result === 'NOT_FOUND' ? 'READBACK_NOT_FOUND_YET' : 'READBACK_FAILED',
          lastOutcomeAt: new Date(),
        },
      })
    }
    return this.view(organizationId, row.id)
  }

  /**
   * Behörig avstämning med EXAKT extern identitet. Bekräftar endast om exakt den
   * posten i rätt företag har samma innehåll som det frysta underlaget. Det finns
   * ingen väg som gör UNKNOWN/REJECTED omsändbart.
   */
  async reconcile(
    organizationId: string,
    userId: string,
    exportId: string,
    input: { year?: unknown; series?: unknown; number?: unknown },
  ) {
    const { year, series, number } = input ?? {}
    if (
      typeof year !== 'number' ||
      !Number.isSafeInteger(year) ||
      year < 1 ||
      typeof series !== 'string' ||
      !/^[A-Za-z0-9]{1,10}$/.test(series) ||
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1
    ) {
      throw new BadRequestException('Ogiltig extern identitet')
    }
    await this.expireLeases(organizationId)
    const row = await this.prisma.fortnoxVoucherExport.findFirst({
      where: { id: exportId, organizationId },
    })
    if (!row) throw new NotFoundException('Exportraden hittades inte')
    if (!(LOCKED_FOR_RECONCILE as readonly string[]).includes(row.state) || !row.draft) {
      throw new ConflictException('Verifikatet behöver ingen avstämning i sitt nuvarande läge')
    }
    const identity = { year, series, number }
    const result = await this.readAndCompare(organizationId, row, identity)
    if (result !== 'MATCH') {
      const why: Record<Exclude<CompareResult, 'MATCH'>, string> = {
        MISMATCH: 'Posten i Fortnox stämmer inte med det skickade underlaget',
        NOT_FOUND: 'Posten finns inte i Fortnox',
        READ_FAILED: 'Fortnox kunde inte läsas just nu; försök igen',
        WRONG_COMPANY: 'Fortnox-företaget är inte det som underlaget skickades till',
      }
      throw new ConflictException(why[result])
    }
    const now = new Date()
    try {
      const res = await this.prisma.fortnoxVoucherExport.updateMany({
        where: {
          id: row.id,
          organizationId,
          state: { in: [...LOCKED_FOR_RECONCILE] },
          reconciledAt: null,
        },
        data: {
          state: 'CONFIRMED',
          externalYear: year,
          externalSeries: series,
          externalNumber: number,
          confirmedAt: now,
          reconciledAt: now,
          reconcileDecision: {
            by: userId,
            at: now.toISOString(),
            identity: { databaseNumber: row.fortnoxDatabaseNumber, year, series, number },
            basis: 'Exakt återläsning i rätt företag; innehållet lika det frysta underlaget',
          },
          lastOutcome: 'RECONCILED',
          lastOutcomeAt: now,
        },
      })
      if (res.count !== 1)
        throw new ConflictException('Verifikatet har redan stämts av eller ändrats')
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Den externa posten är redan kopplad till en annan export')
      }
      throw err
    }
    return this.view(organizationId, row.id)
  }
}
