import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type FortnoxVoucherExport } from '@prisma/client'
import { arBelagdInnehallsavvisning } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  CustomerCreditExportEvidenceError,
  recheckCustomerCreditExportInTransaction,
} from './fortnox-customer-credit-evidence'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import {
  FORTNOX_VOUCHER_DRAFT_BUILDER,
  type FortnoxVoucherDraftBuilder,
} from './fortnox-export.service'
import { exportView } from './fortnox-export-view'
import { Incomplete, paged, toOre } from './fortnox-ledger'
import {
  provaOchOgiltigforklara,
  sendingEnabledFor,
  type FortnoxCustomerBinding,
} from './fortnox-customer-activation'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import {
  FORTNOX_VOUCHER_WRITER,
  FortnoxWriteError,
  type FortnoxVoucherWriter,
  payloadDatum,
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
  draft: true,
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
    Voucher: {
      Description?: unknown
      TransactionDate?: unknown
      VoucherSeries?: unknown
      VoucherRows?: unknown
    }
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
    // FINAL-003 EX-2b: radtexten (TransactionInformation) ska vara exakt lika; saknad = tom.
    // Radens Description är kontots benämning i Fortnox och jämförs inte.
    const ti = x.TransactionInformation
    if (ti !== undefined && ti !== null && typeof ti !== 'string') return null
    out.push(`${x.Account}|${d}|${c}|${JSON.stringify(ti ?? '')}`)
  }
  return out.sort()
}

/**
 * Exakt jämförelse mellan återläst post och fryst underlag (beskrivning, datum,
 * serie, år, rader). Beskrivningen ingår (K-S5): två poster med identiska rader men
 * olika beskrivning kan inte förväxlas vid avstämning.
 */
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
  if (typeof f.Description !== 'string' || read.Description !== f.Description) return false
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

  /**
   * Kan organisationens anslutna företag skrivas till? Testföretaget via testvägen,
   * eller ett kundföretag med flaggan på OCH en giltig kundaktivering (KUNDSTART G-F5).
   */
  async sendingEnabledFor(organizationId: string): Promise<boolean> {
    return sendingEnabledFor(this.prisma, this.writer, organizationId)
  }

  /** Utgångna anspråk blir UNKNOWN (lazy). Aldrig återköning. */
  async expireLeases(organizationId: string): Promise<number> {
    const res = await this.prisma.fortnoxVoucherExport.updateMany({
      where: { organizationId, state: 'SENDING', sendLeaseUntil: { lt: new Date() } },
      data: { state: 'UNKNOWN', lastOutcome: 'LEASE_EXPIRED', lastOutcomeAt: new Date() },
    })
    return res.count
  }

  private async view(organizationId: string, id: string) {
    return exportView(
      await this.prisma.fortnoxVoucherExport.findFirstOrThrow({
        where: { id, organizationId },
        select: EXPORT_VIEW,
      }),
    )
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
    const provenance = fresh.draft.provenance
    if (
      provenance &&
      typeof provenance === 'object' &&
      !Array.isArray(provenance) &&
      'sourceId' in provenance &&
      typeof provenance.sourceId === 'string' &&
      provenance.sourceId.startsWith('customer-credit-') &&
      fresh.draft.kundtillgodo === undefined
    )
      throw new ConflictException(stale)
    const draft = fresh.draft as unknown as FrozenDraft
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn || conn.status !== 'ACTIVE') throw new ConflictException('Fortnox är inte anslutet')
    // KUNDSTART §6: ett kundföretag (utanför testvägen) kräver flaggan och en kundaktivering
    // vars bindning prövas mot aktuellt läge NU. Avvikelse ogiltigförklarar den beständigt.
    let kund: FortnoxCustomerBinding | null = null
    if (this.writer.requiresCustomerActivation(conn.fortnoxDatabaseNumber)) {
      if (!this.writer.customerWritesEnabled)
        throw new ConflictException('SENDING_DISABLED: Sändning till Fortnox är inte aktiverad')
      const v = await provaOchOgiltigforklara(this.prisma, organizationId, {
        financialYearId: draft.query.financialyear,
        voucherSeries: String(draft.payload.Voucher.VoucherSeries),
        // K-B7: exportgränsen prövas på utkastets eget datum vid varje sändning.
        transactionDate: payloadDatum(draft.payload),
        // K-B8: metoden ur den färska förkontrollens bindning (saknas → '' = inte ACCRUAL).
        accountingMethod: fresh.binding?.accountingMethod ?? '',
      })
      if (!v.ok) throw new ConflictException(`CUSTOMER_NOT_ACTIVATED: ${v.skal}`)
      kund = v.binding
    }
    // Företagslistan kontrolleras före anspråket: ett företag utanför listan tar aldrig anspråk.
    if (!this.writer.allowsCompany(conn.fortnoxDatabaseNumber, kund)) {
      throw new ConflictException('SENDING_DISABLED: Sändning till Fortnox är inte aktiverad')
    }
    // T-N1: hashen ska vara räknad mot exakt denna anslutningsgeneration och detta företag.
    if (
      !fresh.binding ||
      fresh.binding.generation !== conn.generation ||
      fresh.binding.databaseNumber !== conn.fortnoxDatabaseNumber
    ) {
      throw new ConflictException(stale)
    }

    const attemptId = randomUUID()
    const now = new Date()
    const claimWith = (db: Pick<Prisma.TransactionClient, 'fortnoxVoucherExport'>) =>
      db.fortnoxVoucherExport.updateMany({
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
    // Kundtillgodots bokförda källor och originalexporter kan ha ändrats medan
    // byggaren läste Fortnox. Lås/återläs dem och ta SAMMA CAS i en DB-only tx.
    // Ingen POST, tokenhämtning eller annan nät-I/O sker inom transaktionen.
    let claim: Prisma.BatchPayload
    if (fresh.draft.kundtillgodo !== undefined) {
      if (!conn.fortnoxOrgNumber) throw new ConflictException(stale)
      const organizationNumber = conn.fortnoxOrgNumber
      try {
        claim = await this.prisma.$transaction(
          async (tx) => {
            await recheckCustomerCreditExportInTransaction(tx, {
              organizationId,
              journalEntryId: row.journalEntryId,
              databaseNumber: conn.fortnoxDatabaseNumber,
              organizationNumber,
              expected: fresh.draft.kundtillgodo,
              draft: fresh.draft,
              connectionId: conn.id,
              generation: conn.generation,
            })
            return claimWith(tx)
          },
          { ...PAYMENT_TX_LIMITS, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        )
      } catch (error) {
        if (error instanceof CustomerCreditExportEvidenceError) throw new ConflictException(stale)
        throw error
      }
    } else {
      claim = await claimWith(this.prisma)
    }
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
    // TESTKUND-016 K3.1: låsningen och historikposten skrivs i SAMMA villkorade sats; historiken
    // läggs bara till (jsonb ||), skrivs aldrig över.
    const lock = async (
      state: 'UNKNOWN' | 'REJECTED',
      outcome: string,
      bevis: Record<string, unknown> = {},
    ) => {
      const at = new Date()
      const post = {
        typ: state === 'REJECTED' ? 'AVVISAD' : 'OKANT_UTFALL',
        at: at.toISOString(),
        sendAttemptId: attemptId,
        sentPayloadHash: draftHash,
        utfall: outcome,
        ...bevis,
      }
      await this.prisma.$executeRaw`
        UPDATE "FortnoxVoucherExport"
           SET "state" = ${state}::"FortnoxExportState",
               "lastOutcome" = ${outcome},
               "lastOutcomeAt" = ${at},
               "attemptHistory" = "attemptHistory" || jsonb_build_array(${JSON.stringify(post)}::jsonb),
               "updatedAt" = ${at}
         WHERE "id" = ${row.id} AND "organizationId" = ${organizationId}
           AND "sendAttemptId" = ${attemptId} AND "state" = 'SENDING'`
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
      body = await this.writer.createVoucher(token, draft.query, draft.payload, {
        databaseNumber: conn.fortnoxDatabaseNumber,
        kund,
      })
    } catch (err) {
      if (err instanceof FortnoxWriteError && err.outcome === 'not_sent') {
        await backToReady('NOT_SENT')
      } else if (
        err instanceof FortnoxWriteError &&
        err.outcome === 'unknown' &&
        err.status === 429
      ) {
        // TESTKUND-035 P3-B3: 429 på POST kan ha skapat posten. Okänt utfall med bevarat försök
        // (sendAttemptId, sentPayloadHash, fryst utkast); ingen omsändning, ingen frisläppning.
        await lock('UNKNOWN', 'UNKNOWN_429', {
          http: 429,
          retryAfterMs: err.retryAfterMs,
          sparrSparad: !err.deferFailed,
          kalla: 'LAGRAD_AV_PRODUKTEN',
        })
      } else if (err instanceof FortnoxWriteError && err.outcome === 'rejected') {
        // TESTKUND-016 K3.1: HTTP-status och Fortnox kod sparas (NA = okänd). Sedan TESTKUND-035
        // ger 429 aldrig rejected; äldre REJECTED_429_* behandlas som okänt utfall.
        const http = err.status ?? null
        const code = err.rejection?.code ?? null
        await lock('REJECTED', `REJECTED_${http ?? 'NA'}_${code ?? 'NA'}`, {
          http,
          code,
          meddelande: err.rejection?.message ?? null,
          kalla: 'LAGRAD_AV_PRODUKTEN',
        })
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
    return this.confirmReconciled(
      organizationId,
      row,
      userId,
      identity,
      'Exakt återläsning i rätt företag; innehållet lika det frysta underlaget',
    )
  }

  /**
   * TESTKUND-035 P3-C1/C2: avstämning genom FULLSTÄNDIG skanning av räkenskapsåret i rätt företag
   * (alla serier, strikt sidläsning). FOUND bekräftar bara exakt EN post vars Comments är lika med
   * den frysta proveniensen och vars rader och belopp är lika med det skickade underlaget. ABSENT
   * lämnar utfallet okänt: en historikpost (tid, räckvidd, antal lästa verifikat) läggs till och
   * inget annat ändras. ABSENT bevisar inte att posten aldrig skapades.
   */
  async reconcileScan(organizationId: string, userId: string, exportId: string) {
    await this.expireLeases(organizationId)
    const row = await this.prisma.fortnoxVoucherExport.findFirst({
      where: { id: exportId, organizationId },
    })
    if (!row) throw new NotFoundException('Exportraden hittades inte')
    if (
      !(LOCKED_FOR_RECONCILE as readonly string[]).includes(row.state) ||
      !row.draft ||
      row.fortnoxDatabaseNumber === null ||
      row.sendFinancialYear === null ||
      !row.sendAttemptId
    ) {
      throw new ConflictException('Verifikatet behöver ingen avstämning i sitt nuvarande läge')
    }
    const skanning = await this.scanForProvenance(organizationId, row)
    if (skanning.status === 'WRONG_COMPANY')
      throw new ConflictException('Fortnox-företaget är inte det som underlaget skickades till')
    if (skanning.status === 'INCOMPLETE')
      throw new ConflictException(
        `Fortnox kunde inte läsas fullständigt (${skanning.skal}); inget ändrades. Försök igen senare.`,
      )
    if (skanning.status === 'FOUND') {
      if (skanning.traffar.length !== 1)
        throw new ConflictException(
          `Flera poster i Fortnox bär verifikatets proveniens (${skanning.traffar.map((t) => `${t.series}${t.number}`).join(', ')}); inget ändrades. Stäm av manuellt med exakt identitet.`,
        )
      const t = skanning.traffar[0]!
      const frozenComments = (row.draft as { payload?: { Voucher?: { Comments?: unknown } } })
        .payload?.Voucher?.Comments
      if (typeof frozenComments !== 'string' || t.comments !== frozenComments)
        throw new ConflictException(
          `Posten ${t.series}${t.number} i Fortnox har inte exakt verifikatets proveniens; inget ändrades`,
        )
      const identity = { year: t.year, series: t.series, number: t.number }
      const result = await this.readAndCompare(organizationId, row, identity)
      if (result !== 'MATCH')
        throw new ConflictException(
          result === 'MISMATCH'
            ? `Posten ${t.series}${t.number} i Fortnox stämmer inte med det skickade underlaget; inget ändrades`
            : 'Fortnox kunde inte läsas fullständigt; inget ändrades. Försök igen senare.',
        )
      return {
        ...(await this.confirmReconciled(
          organizationId,
          row,
          userId,
          identity,
          'Fullständig skanning av räkenskapsåret i rätt företag: exakt en post med fryst proveniens; återläst innehåll lika det frysta underlaget',
        )),
        avstamning: { utfall: 'HITTAD' as const, identitet: identity },
      }
    }
    const at = new Date()
    const post = {
      typ: 'AVSTAMNING_EJ_HITTAD',
      at: at.toISOString(),
      av: userId,
      sendAttemptId: row.sendAttemptId,
      sentPayloadHash: row.sentPayloadHash,
      rackvidd: {
        databaseNumber: row.fortnoxDatabaseNumber,
        financialYear: row.sendFinancialYear,
        serier: 'alla',
        verifikatLasta: skanning.antal,
        sidor: skanning.sidor,
        markor: `Eveno JournalEntry ${row.journalEntryId}`,
      },
      tolkning: 'Ingen post hittades vid läsningen. Det bevisar inte att ingen post skapades.',
    }
    const count = await this.prisma.$executeRaw`
      UPDATE "FortnoxVoucherExport"
         SET "attemptHistory" = "attemptHistory" || jsonb_build_array(${JSON.stringify(post)}::jsonb),
             "updatedAt" = ${at}
       WHERE "id" = ${row.id} AND "organizationId" = ${organizationId}
         AND "state" = ${row.state}::"FortnoxExportState" AND "reconciledAt" IS NULL
         AND "sendAttemptId" = ${row.sendAttemptId}`
    if (count !== 1) throw new ConflictException('Exporten har ändrats under avstämningen')
    return {
      ...(await this.view(organizationId, row.id)),
      avstamning: {
        utfall: 'EJ_HITTAD' as const,
        at: at.toISOString(),
        financialYear: row.sendFinancialYear,
        verifikatLasta: skanning.antal,
        sidor: skanning.sidor,
      },
    }
  }

  private async confirmReconciled(
    organizationId: string,
    row: FortnoxVoucherExport,
    userId: string,
    identity: { year: number; series: string; number: number },
    basis: string,
  ) {
    const { year, series, number } = identity
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
            basis,
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

  /**
   * TESTKUND-016 (KRITERIER-H4-016 K3): frisläpp en BEVISAT avvisad export till BLOCKED så att
   * den vanliga förhandskontrollen och sändningen kan göras om. Gäller aldrig UNKNOWN, RECEIPT_*,
   * timeout eller 429. Före bytet: färsk, strikt sidläst kontroll i rätt företag och år att ingen
   * post bär verifikatets proveniens. Bytet är villkorat på exakt det lästa försöket.
   */
  async releaseRejected(
    organizationId: string,
    user: { sub: string; role: string },
    exportId: string,
    input: {
      reason?: unknown
      avvisningsbevis?: {
        http?: unknown
        code?: unknown
        rakvittoSha256?: unknown
        manifestSha256?: unknown
        sentPayloadHash?: unknown
      }
    },
  ) {
    if (user.role !== 'OWNER' && user.role !== 'ADMIN')
      throw new ForbiddenException('Bara OWNER eller ADMIN får frisläppa en avvisad export.')
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (reason.length < 5 || reason.length > 500)
      throw new BadRequestException('Ange ett skäl (5–500 tecken)')
    await this.expireLeases(organizationId)
    const row = await this.prisma.fortnoxVoucherExport.findFirst({
      where: { id: exportId, organizationId },
    })
    if (!row) throw new NotFoundException('Exportraden hittades inte')
    if (row.state !== 'REJECTED' || row.reconciledAt !== null)
      throw new ConflictException(
        'Bara en avvisad export kan frisläppas; ett okänt utfall stäms av med reconcile',
      )
    if (
      !row.sendAttemptId ||
      !row.sentPayloadHash ||
      row.fortnoxDatabaseNumber === null ||
      row.sendFinancialYear === null ||
      !row.lastOutcome
    )
      throw new ConflictException('Det avvisade försöket saknar sitt underlag')

    const at = new Date()
    const ejBelagd = (http: unknown, code: unknown) =>
      new ConflictException(
        `Avvisningen är inte en belagd innehållsavvisning (http ${String(http ?? 'okänd')}, kod ${String(code ?? 'okänd')}); stäm av med reconcile eller Fortnox support`,
      )
    let avvisning: Record<string, unknown>
    const lagrad = /^REJECTED_(\d{3}|NA)_(\d+|NA)$/.exec(row.lastOutcome)
    if (lagrad) {
      const http = lagrad[1] === 'NA' ? null : Number(lagrad[1])
      if (http === 429)
        throw new ConflictException(
          'En avvisning på grund av rate limit (429) är ingen innehållsavvisning och kan inte frisläppas här',
        )
      // K4.2 (F-022-2): ett medskickat kvitto när ett lagrat bevis finns är motsägande indata.
      if (input?.avvisningsbevis !== undefined && input?.avvisningsbevis !== null)
        throw new BadRequestException(
          'Avvisningsbevis kan bara anges för en äldre avvisning utan lagrad kod; den här exportens avvisning är redan lagrad',
        )
      const code = lagrad[2] === 'NA' ? null : Number(lagrad[2])
      // K-KP-1/2: bara ett belagt (status, kod)-par är en innehållsavvisning.
      if (!arBelagdInnehallsavvisning(http, code)) throw ejBelagd(http, code)
      avvisning = { kalla: 'LAGRAD_AV_PRODUKTEN', http, code }
    } else if (row.lastOutcome === 'REJECTED') {
      // K3.4: äldre avvisning utan lagrad kod. Kräver OWNER och ett uttryckligt externt kvitto.
      if (user.role !== 'OWNER')
        throw new ForbiddenException(
          'Bara OWNER får ange ett avvisningskvitto i efterhand för en äldre avvisning.',
        )
      const b = input?.avvisningsbevis
      const sha = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
      if (
        !b ||
        typeof b.http !== 'number' ||
        !Number.isInteger(b.http) ||
        b.http < 400 ||
        b.http > 499 ||
        b.http === 408 ||
        b.http === 429 ||
        typeof b.code !== 'number' ||
        !Number.isSafeInteger(b.code) ||
        b.code < 1 ||
        !sha(b.rakvittoSha256) ||
        !sha(b.manifestSha256) ||
        !sha(b.sentPayloadHash)
      )
        throw new ConflictException(
          'En äldre avvisning utan lagrad kod kräver ett externt 4xx-kvitto (http, code, rakvittoSha256, manifestSha256, sentPayloadHash)',
        )
      if (!arBelagdInnehallsavvisning(b.http, b.code)) throw ejBelagd(b.http, b.code)
      if (b.sentPayloadHash !== row.sentPayloadHash)
        throw new ConflictException('Kvittots sentPayloadHash avser inte detta avvisade försök')
      avvisning = {
        kalla: 'ANGIVET_I_EFTERHAND',
        beskrivning: 'Externt belagt, ej lagrat av produkten',
        http: b.http,
        code: b.code,
        rakvittoSha256: b.rakvittoSha256,
        manifestSha256: b.manifestSha256,
        sentPayloadHash: b.sentPayloadHash,
        angivetAv: user.sub,
        roll: user.role,
        at: at.toISOString(),
      }
    } else {
      throw new ConflictException('Avvisningens utfall är okänt; exporten kan inte frisläppas')
    }

    const skanning = await this.scanForProvenance(organizationId, row)
    if (skanning.status === 'FOUND')
      throw new ConflictException(
        `En post med verifikatets proveniens finns i Fortnox (${skanning.traffar.map((t) => `${t.year}|${t.series}|${t.number}`).join(', ')}); stäm av med reconcile`,
      )
    if (skanning.status !== 'ABSENT')
      throw new ConflictException(
        skanning.status === 'WRONG_COMPANY'
          ? 'Fortnox-företaget är inte det som underlaget skickades till'
          : `Fortnox kunde inte läsas fullständigt (${skanning.skal}); inget ändrades`,
      )

    const post = {
      typ: 'FRISLAPPT',
      at: at.toISOString(),
      av: user.sub,
      roll: user.role,
      skal: reason,
      avvisning,
      tidigareForsok: {
        sendAttemptId: row.sendAttemptId,
        sentPayloadHash: row.sentPayloadHash,
        draftHash: row.draftHash,
        lastOutcome: row.lastOutcome,
        utkast: row.draft,
      },
      skanning: {
        databaseNumber: row.fortnoxDatabaseNumber,
        financialYear: row.sendFinancialYear,
        verifikatLasta: skanning.antal,
        sidor: skanning.sidor,
        markor: `Eveno JournalEntry ${row.journalEntryId}`,
      },
    }
    const count = await this.prisma.$executeRaw`
      UPDATE "FortnoxVoucherExport"
         SET "state" = 'BLOCKED'::"FortnoxExportState",
             "blockReason" = 'Fortnox avvisade försöket; exporten är frisläppt. Gör en ny förhandskontroll.',
             "lastOutcome" = 'RELEASED_AFTER_REJECTION',
             "lastOutcomeAt" = ${at},
             "attemptHistory" = "attemptHistory" || jsonb_build_array(${JSON.stringify(post)}::jsonb),
             "updatedAt" = ${at}
       WHERE "id" = ${row.id} AND "organizationId" = ${organizationId}
         AND "state" = 'REJECTED' AND "reconciledAt" IS NULL
         AND "sendAttemptId" = ${row.sendAttemptId} AND "lastOutcome" = ${row.lastOutcome}`
    if (count !== 1) throw new ConflictException('Exporten har redan frisläppts eller ändrats')
    return this.view(organizationId, row.id)
  }

  /**
   * Strikt sidläsning av räkenskapsårets verifikat i rätt företag: finns någon post vars
   * Comments bär «Eveno JournalEntry <id>»? Varje läsfel eller ofullständighet → inte ABSENT.
   * TESTKUND-035: hela året läses och ALLA träffar redovisas (dubbletter syns).
   */
  private async scanForProvenance(
    organizationId: string,
    row: FortnoxVoucherExport,
  ): Promise<
    | { status: 'ABSENT'; antal: number; sidor: number }
    | {
        status: 'FOUND'
        traffar: { year: number; series: string; number: number; comments: string }[]
      }
    | { status: 'WRONG_COMPANY' }
    | { status: 'INCOMPLETE'; skal: string }
  > {
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch {
      return { status: 'INCOMPLETE', skal: 'ingen åtkomst' }
    }
    if (auth.databaseNumber !== row.fortnoxDatabaseNumber) return { status: 'WRONG_COMPANY' }
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    const year = row.sendFinancialYear!
    const markor = `Eveno JournalEntry ${row.journalEntryId}`
    try {
      const ci = await reader.get<{ CompanyInformation?: { DatabaseNumber?: unknown } }>(
        auth.token,
        '/3/companyinformation',
      )
      if (ci?.CompanyInformation?.DatabaseNumber !== row.fortnoxDatabaseNumber)
        return { status: 'WRONG_COMPANY' }
      const coverage: Parameters<typeof paged>[5] = {}
      const list = await paged<Record<string, unknown>>(
        reader,
        auth.token,
        '/3/vouchers/sublist',
        'Vouchers',
        { financialyear: year },
        coverage,
      )
      const seen = new Set<string>()
      const traffar: { year: number; series: string; number: number; comments: string }[] = []
      for (const v of list.items) {
        const series = v.VoucherSeries
        const number = v.VoucherNumber
        if (typeof series !== 'string' || !Number.isSafeInteger(number))
          return { status: 'INCOMPLETE', skal: 'verifikat utan identitet' }
        if (v.Year !== year) return { status: 'INCOMPLETE', skal: 'verifikat i fel räkenskapsår' }
        if (!('Comments' in v) || (v.Comments !== null && typeof v.Comments !== 'string'))
          return { status: 'INCOMPLETE', skal: 'listan saknar Comments' }
        seen.add(`${series}|${String(number)}`)
        if (typeof v.Comments === 'string' && v.Comments.includes(markor))
          traffar.push({ year, series, number: number as number, comments: v.Comments })
      }
      if (seen.size !== list.total) return { status: 'INCOMPLETE', skal: 'antalet stämmer inte' }
      // K-S2: anslutningen får inte ha bytt företag under läsningen.
      const after = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
      if (
        !after ||
        after.id !== auth.connectionId ||
        after.fortnoxDatabaseNumber !== row.fortnoxDatabaseNumber
      )
        return { status: 'WRONG_COMPANY' }
      if (traffar.length > 0) return { status: 'FOUND', traffar }
      return {
        status: 'ABSENT',
        antal: seen.size,
        sidor: coverage['/3/vouchers/sublist']?.pages ?? 0,
      }
    } catch (err) {
      if (err instanceof Incomplete) return { status: 'INCOMPLETE', skal: err.message }
      return { status: 'INCOMPLETE', skal: 'läsfel' }
    }
  }
}
