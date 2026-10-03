import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { readLedger, type LedgerReadResult } from './fortnox-ledger'
import { readCatalog } from './fortnox-catalog'
import type { FortnoxAiSnapshot } from './fortnox-ai-context'
import { FORTNOX_VOUCHER_WRITER, type FortnoxVoucherWriter } from './fortnox-voucher-writer'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

export interface StartReadInput {
  financialYearId: number
  periodFrom: string
  periodTo: string
  costAccounts: number[]
  /**
   * Årsgränser som klienten kopierat ur katalogen. ALDRIG bevis — servern läser året
   * från Fortnox; avviker de är klientens urval inaktuellt (409, hämta om katalogen).
   */
  financialYearStart?: string
  financialYearEnd?: string
}

/** En pågående läsning äldre än så här räknas som avbruten och blockerar inte nästa. */
const RUNNING_STALE_MS = 10 * 60 * 1000

const NOT_CONNECTED_TEXT: Record<FortnoxNotConnectedError['reason'], string> = {
  NO_CONNECTION: 'Ingen Fortnox-anslutning',
  AUTH_LOST: 'Fortnox-inloggningen har upphört; anslut igen',
  DISCONNECTED: 'Fortnox-anslutningen är frånkopplad',
  REFRESH_IN_PROGRESS: 'Inloggningen förnyas; försök igen om en stund',
  REFRESH_RATE_LIMITED: 'Fortnox begränsar anropen just nu; försök igen om en stund',
}

/** Fält som visas för kunden och AI. `rows` (proveniens) hämtas separat. */
export const FORTNOX_READ_VIEW_SELECT = {
  id: true,
  status: true,
  financialYearId: true,
  financialYearStart: true,
  financialYearEnd: true,
  costAccounts: true,
  periodFrom: true,
  periodTo: true,
  startedAt: true,
  completedAt: true,
  reason: true,
  uncertainties: true,
  coverage: true,
  summary: true,
  fortnoxDatabaseNumber: true,
} satisfies Prisma.FortnoxReadRunSelect

/**
 * Återläsning till ett SEPARAT, källmärkt underlag (shadow). Påverkar inte Evenos
 * huvudbok eller rapporter. Varje försök sparas — även ofullständiga — så att
 * senaste lyckade läsning och senaste fel kan visas var för sig.
 */
@Injectable()
export class FortnoxReadbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
    /** Endast för AI-textens ärliga sändningsläge; läsning skriver aldrig. */
    @Optional()
    @Inject(FORTNOX_VOUCHER_WRITER)
    private readonly writer?: FortnoxVoucherWriter,
  ) {}

  async read(organizationId: string, userId: string | null, input: StartReadInput) {
    validate(input)
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException(NOT_CONNECTED_TEXT[err.reason])
      throw err
    }

    // En läsning åt gången per organisation. Kontrollen är inte ett lås; två
    // samtidiga starter kan båda passera, men de skriver var sin körning och
    // påverkar inget annat än vilken som blir "senaste".
    const running = await this.prisma.fortnoxReadRun.findFirst({
      where: {
        organizationId,
        status: 'RUNNING',
        startedAt: { gt: new Date(Date.now() - RUNNING_STALE_MS) },
      },
      select: { id: true },
    })
    if (running) throw new ConflictException('En Fortnox-läsning pågår redan')

    const run = await this.prisma.fortnoxReadRun.create({
      data: {
        organizationId,
        connectionId: auth.connectionId,
        fortnoxDatabaseNumber: auth.databaseNumber,
        financialYearId: input.financialYearId,
        periodFrom: new Date(`${input.periodFrom}T00:00:00Z`),
        periodTo: new Date(`${input.periodTo}T00:00:00Z`),
        costAccounts: input.costAccounts,
        triggeredByUserId: userId,
      },
      select: { id: true },
    })

    let result: LedgerReadResult
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    try {
      const [mappings, exported] = await Promise.all([
        this.prisma.fortnoxDimensionMapping.findMany({
          where: { organizationId },
          select: {
            dimensionType: true,
            code: true,
            propertyId: true,
            property: { select: { name: true } },
          },
        }),
        this.prisma.fortnoxVoucherExport.findMany({
          // EXAKT tuple (företag, år, serie, nummer) — aldrig serie- eller textlikhet.
          where: {
            organizationId,
            state: 'CONFIRMED',
            fortnoxDatabaseNumber: auth.databaseNumber,
            externalYear: { not: null },
            externalSeries: { not: null },
            externalNumber: { not: null },
          },
          select: { externalYear: true, externalSeries: true, externalNumber: true },
        }),
      ])
      result = await readLedger(reader, auth.token, {
        expectedDatabaseNumber: auth.databaseNumber,
        ...input,
        mappings: new Map(
          mappings.map((m) => [
            `${m.dimensionType}:${m.code}`,
            { propertyId: m.propertyId, propertyName: m.property.name },
          ]),
        ),
        evenoExported: new Set(
          exported.map((e) => `${e.externalYear}|${e.externalSeries}|${e.externalNumber}`),
        ),
      })
    } catch {
      // Oväntat fel: körningen får ett slutläge, aldrig en kvarlämnad RUNNING och aldrig en summa.
      result = {
        status: 'FAILED',
        financialYear: null,
        reason: 'Oväntat fel vid läsning',
        summary: null,
        rows: null,
        coverage: {},
        uncertainties: [],
        references: [],
      }
    }
    if (result.status === 'AUTH_LOST')
      await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED', reader.binding)

    // Inaktuellt kundurval: årsgränser som inte stämmer med Fortnox, eller valt konto
    // som Fortnox anger som inaktivt. Körningen sparas som FAILED (utan summa) och
    // svaret blir 409 så att kunden hämtar om katalogen.
    let stale: string | null = null
    const fy = result.financialYear
    if (
      fy &&
      ((input.financialYearStart !== undefined && input.financialYearStart !== fy.fromDate) ||
        (input.financialYearEnd !== undefined && input.financialYearEnd !== fy.toDate))
    ) {
      stale = `Urvalet är inaktuellt: räkenskapsåret i Fortnox är ${fy.fromDate}–${fy.toDate}. Hämta om valen.`
    }
    const inactive = result.uncertainties
      .map((u) => /^Konto (\d+) är inaktivt i Fortnox\.$/.exec(u)?.[1])
      .filter((x): x is string => Boolean(x))
    if (!stale && inactive.length) {
      stale = `Urvalet är inaktuellt: konto ${inactive.join(', ')} är inaktivt i Fortnox. Hämta om valen.`
    }
    if (stale) result = { ...result, status: 'FAILED', reason: stale, summary: null, rows: null }

    const saved = await this.prisma.fortnoxReadRun.update({
      where: { id: run.id },
      data: {
        status: result.status,
        completedAt: new Date(),
        financialYearStart: result.financialYear
          ? new Date(`${result.financialYear.fromDate}T00:00:00Z`)
          : null,
        financialYearEnd: result.financialYear
          ? new Date(`${result.financialYear.toDate}T00:00:00Z`)
          : null,
        reason: result.reason,
        summary:
          result.summary === null
            ? Prisma.DbNull
            : (result.summary as unknown as Prisma.InputJsonValue),
        rows:
          result.rows === null
            ? Prisma.DbNull
            : ({
                rows: result.rows,
                references: result.references,
              } as unknown as Prisma.InputJsonValue),
        coverage: result.coverage as unknown as Prisma.InputJsonValue,
        uncertainties: result.uncertainties,
      },
      select: FORTNOX_READ_VIEW_SELECT,
    })
    if (stale) throw new ConflictException(stale)
    return saved
  }

  /** GET /catalog — verifierade val (år, konton för valt år, dimensioner). Läser inget annat. */
  async catalog(organizationId: string, financialYearId: number | null) {
    if (financialYearId !== null && (!Number.isInteger(financialYearId) || financialYearId < 1)) {
      throw new BadRequestException('Ogiltigt räkenskapsår')
    }
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException(NOT_CONNECTED_TEXT[err.reason])
      throw err
    }
    const conn = await this.connections.status(organizationId)
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    const cat = await readCatalog(reader, auth.token, {
      expectedDatabaseNumber: auth.databaseNumber,
      financialYearId,
    })
    if (cat.authLost)
      await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED', reader.binding)
    return {
      ready: cat.ready,
      reason: cat.reason,
      financialYears: cat.financialYears,
      selectedFinancialYearId: cat.selectedFinancialYearId,
      costAccounts: cat.costAccounts,
      dimensions: cat.dimensions,
      voucherSeries: cat.voucherSeries,
      complete: cat.complete,
      observedAt: new Date().toISOString(),
      company: {
        name: conn?.fortnoxCompanyName ?? null,
        orgNumber: conn?.fortnoxOrgNumber ?? null,
        databaseNumber: auth.databaseNumber,
      },
    }
  }

  async latest(organizationId: string) {
    const [latestRead, latestCompleteRead] = await Promise.all([
      this.prisma.fortnoxReadRun.findFirst({
        where: { organizationId },
        orderBy: { startedAt: 'desc' },
        select: FORTNOX_READ_VIEW_SELECT,
      }),
      this.prisma.fortnoxReadRun.findFirst({
        where: { organizationId, status: { in: ['COMPLETE', 'COMPLETE_WITH_UNCERTAINTY'] } },
        orderBy: { startedAt: 'desc' },
        select: FORTNOX_READ_VIEW_SELECT,
      }),
    ])
    return { latestRead, latestCompleteRead }
  }

  /**
   * Underlag till AI-kontexten (se fortnox-ai-context.ts). Säkert urval: inga
   * tokens, inga rader/fritext — endast färdiga summor, period, tid och osäkerhet.
   */
  async aiSnapshot(organizationId: string): Promise<FortnoxAiSnapshot> {
    const connection = await this.prisma.fortnoxConnection.findUnique({
      where: { organizationId },
      select: { status: true, fortnoxDatabaseNumber: true, fortnoxCompanyName: true },
    })
    if (!connection) {
      return { connection: null, latestRead: null, latestCompleteRead: null, exports: null }
    }
    const select = { ...FORTNOX_READ_VIEW_SELECT, costAccounts: true }
    const [latestRead, latestCompleteRead] = await Promise.all([
      this.prisma.fortnoxReadRun.findFirst({
        where: { organizationId },
        orderBy: { startedAt: 'desc' },
        select,
      }),
      this.prisma.fortnoxReadRun.findFirst({
        where: { organizationId, status: { in: ['COMPLETE', 'COMPLETE_WITH_UNCERTAINTY'] } },
        orderBy: { startedAt: 'desc' },
        select,
      }),
    ])
    // Exportköns läge (antal per status) — ingen hemlighet, ingen automatisk åtgärd.
    const grouped = await this.prisma.fortnoxVoucherExport.groupBy({
      by: ['state'],
      where: { organizationId },
      _count: { _all: true },
    })
    // Inte `exports` som variabelnamn: krockar med CommonJS-modulens exports.
    const exportCounts: Record<string, number> & FortnoxAiSnapshot['exports'] = {
      DRY_RUN_READY: 0,
      BLOCKED: 0,
      UNKNOWN: 0,
      CONFIRMED: 0,
    }
    for (const g of grouped) exportCounts[g.state] = g._count._all
    const sendingEnabled =
      this.writer?.capable === true &&
      connection.status === 'ACTIVE' &&
      this.writer.allowsCompany(connection.fortnoxDatabaseNumber)
    return { connection, latestRead, latestCompleteRead, exports: exportCounts, sendingEnabled }
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validate(i: StartReadInput): void {
  const ok =
    Number.isInteger(i.financialYearId) &&
    i.financialYearId > 0 &&
    [i.periodFrom, i.periodTo].every((d) => typeof d === 'string' && DATE.test(d)) &&
    Array.isArray(i.costAccounts) &&
    i.costAccounts.length > 0 &&
    i.costAccounts.length <= 200 &&
    i.costAccounts.every((a) => Number.isInteger(a) && a >= 1000 && a <= 9999) &&
    [i.financialYearStart, i.financialYearEnd].every(
      (d) => d === undefined || (typeof d === 'string' && DATE.test(d)),
    )
  if (!ok) throw new BadRequestException('Ogiltig läsbegäran (år, datum eller konton)')
}

/**
 * P-F1: läsport som klarar att access-token går ut mitt i en läsning.
 * Vid 401: EN förnyelse via anslutningens CAS-lås och EXAKT ETT omförsök av samma
 * GET. Ett andra 401 (eller avvisad/okänd förnyelse) ger auth-fel → AUTH_LOST.
 * Token som ledgern skickar ignoreras; den aktuella hålls här, aldrig i loggar.
 */
export class RefreshingLedgerReader implements FortnoxLedgerReader {
  constructor(
    private readonly inner: FortnoxLedgerReader,
    private readonly connections: FortnoxConnectionService,
    private readonly organizationId: string,
    private current: { token: string; tokenVersion: number; connectionId: string },
  ) {}

  /** Anslutning + version för den token som senast användes (C-F02-bindning). */
  get binding(): { connectionId: string; tokenVersion: number } {
    return { connectionId: this.current.connectionId, tokenVersion: this.current.tokenVersion }
  }

  async get<T>(
    _token: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    try {
      return await this.inner.get<T>(this.current.token, path, query)
    } catch (err) {
      if (!(err instanceof FortnoxReadError) || err.kind !== 'auth') throw err
      let next: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
      try {
        next = await this.connections.accessToken(this.organizationId, {
          afterUnauthorizedVersion: this.current.tokenVersion,
        })
      } catch (e) {
        if (
          e instanceof FortnoxNotConnectedError &&
          (e.reason === 'REFRESH_IN_PROGRESS' || e.reason === 'REFRESH_RATE_LIMITED')
        ) {
          // Förnyelsen kunde inte göras nu: ofullständig läsning, INTE förlorad anslutning.
          throw new FortnoxReadError('transient')
        }
        throw err
      }
      this.current = {
        token: next.token,
        tokenVersion: next.tokenVersion,
        connectionId: next.connectionId,
      }
      return this.inner.get<T>(this.current.token, path, query) // andra 401 propagerar → AUTH_LOST
    }
  }
}
