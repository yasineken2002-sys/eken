import { isExactEmptyFirstPage } from './fortnox-pagination'
import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import {
  buildFortnoxVoucherDraft,
  type FortnoxVoucherDraftConfig,
  type LocalJournalEntrySnapshot,
} from './export/fortnox-voucher-draft'
import type {
  FortnoxVoucherDraftBuilder,
  FortnoxVoucherDraftOutcome,
} from './fortnox-export.service'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

/**
 * Förhandskontroll av ett Eveno-verifikat mot Fortnox huvudbok — DRY RUN.
 *
 * Laddar verifikatet org-bundet (belopp som Decimal.toString(), aldrig Number),
 * hämtar varje referens som transformern kräver ur det ANSLUTNA Fortnox-företaget
 * i samma stund och anropar den frysta, rena transformern:
 *
 *  - företag:      GET /3/companyinformation — DatabaseNumber och orgnr måste stämma
 *                  med anslutningen.
 *  - räkenskapsår: GET /3/financialyears (alla sidor); exakt ett år ska innehålla
 *                  bokföringsdatumet. Både query-id och payloadens Year sätts till
 *                  års-id:t (SEMANTIK-TILLÄGG-01: Year är års-id i Fortnox exempel).
 *  - serie:        kundens uttryckliga val (FortnoxConnection.exportVoucherSeries),
 *                  verifierad med GET /3/voucherseries/{kod}. Inget val → BLOCKED.
 *  - konton:       GET /3/accounts/{n}?financialyear=id för varje rad; samma nummer
 *                  och aktivt. Ingen kontomappning gissas — bara identiskt nummer.
 *  - dimensioner:  OMIT, eftersom JournalEntryLine saknar dimension (inget härleds).
 *  - rättelse:     E-F1 — ett rättelseverifikat förhandskontrolleras bara om originalet
 *                  har en BEKRÄFTAD export till samma Fortnox-företag.
 *
 * `liveExportAllowed` är alltid false; detta bygger inget sändflöde.
 */
@Injectable()
export class VerifiedVoucherDraftBuilder implements FortnoxVoucherDraftBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
  ) {}

  async build(organizationId: string, journalEntryId: string): Promise<FortnoxVoucherDraftOutcome> {
    const block = (code: string, message: string): FortnoxVoucherDraftOutcome => ({
      ok: false,
      reasons: [`${code}: ${message}`],
    })

    const entry = await this.prisma.journalEntry.findFirst({
      where: { id: journalEntryId, organizationId },
      include: {
        lines: {
          include: { account: { select: { id: true, organizationId: true, number: true } } },
        },
      },
    })
    if (!entry) return block('NOT_FOUND', 'Verifikatet finns inte i organisationen')

    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn || conn.status !== 'ACTIVE') return block('NOT_CONNECTED', 'Fortnox är inte anslutet')
    if (!conn.fortnoxOrgNumber)
      return block('COMPANY_UNVERIFIED', 'Fortnox-företagets organisationsnummer saknas')
    if (!conn.exportOmitDimensionsAt || !conn.exportOmitDimensionsBy) {
      return block(
        'DIMENSION_DECISION_MISSING',
        'Ta ställning till dimensioner: Evenos verifikat saknar kostnadsställe/projekt; export utan dimension måste väljas uttryckligen',
      )
    }
    if (!conn.exportVoucherSeries)
      return block(
        'VOUCHER_SERIES_NOT_CHOSEN',
        'Välj verifikatserie för export i Fortnox-inställningarna',
      )

    if (entry.reversalOfEntryId) {
      const original = await this.prisma.fortnoxVoucherExport.findFirst({
        where: {
          organizationId,
          journalEntryId: entry.reversalOfEntryId,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
        },
        select: { id: true },
      })
      if (!original) {
        return block(
          'ORIGINAL_NOT_CONFIRMED',
          'Rättelsen kan inte exporteras förrän originalverifikatet är bekräftat exporterat till samma Fortnox-företag',
        )
      }
    }

    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        return block('NOT_CONNECTED', 'Fortnox-anslutningen kan inte användas just nu')
      throw err
    }
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    const at = new Date().toISOString()
    const date = entry.date.toISOString().slice(0, 10)

    try {
      const ci = await reader.get<{
        CompanyInformation?: { DatabaseNumber?: unknown; OrganizationNumber?: unknown }
      }>(auth.token, '/3/companyinformation')
      if (ci?.CompanyInformation?.DatabaseNumber !== conn.fortnoxDatabaseNumber) {
        return block('WRONG_COMPANY', 'Fortnox svarade för ett annat företag än det anslutna')
      }
      const orgNumber =
        typeof ci.CompanyInformation.OrganizationNumber === 'string'
          ? ci.CompanyInformation.OrganizationNumber
          : null
      if (orgNumber !== conn.fortnoxOrgNumber)
        return block(
          'WRONG_COMPANY',
          'Organisationsnumret i Fortnox har ändrats sedan anslutningen',
        )

      const years = await allPages<{ Id?: unknown; FromDate?: unknown; ToDate?: unknown }>(
        reader,
        auth.token,
        '/3/financialyears',
        'FinancialYears',
      )
      const matching = years.filter(
        (y) =>
          typeof y.FromDate === 'string' &&
          typeof y.ToDate === 'string' &&
          y.FromDate <= date &&
          date <= y.ToDate,
      )
      if (matching.length !== 1 || !Number.isSafeInteger(matching[0]?.Id)) {
        return block(
          'FINANCIAL_YEAR_UNVERIFIED',
          `Exakt ett räkenskapsår i Fortnox måste omfatta ${date}`,
        )
      }
      const fy = matching[0] as { Id: number; FromDate: string; ToDate: string }

      const series = await getRef<{ VoucherSeries?: { Code?: unknown; Year?: unknown } }>(
        reader,
        auth.token,
        `/3/voucherseries/${conn.exportVoucherSeries}`,
        'VOUCHER_SERIES_UNVERIFIED',
        `Verifikatserien ${conn.exportVoucherSeries} finns inte i Fortnox`,
        { financialyear: fy.Id },
      )
      // E3: serien måste uttryckligen gälla det valda året (Year ingår i svarsschemat).
      if (
        series?.VoucherSeries?.Code === conn.exportVoucherSeries &&
        series.VoucherSeries.Year !== fy.Id
      ) {
        return block(
          'VOUCHER_SERIES_YEAR_UNVERIFIED',
          `Verifikatserien ${conn.exportVoucherSeries} är inte verifierad för räkenskapsår ${fy.Id}`,
        )
      }
      if (series?.VoucherSeries?.Code !== conn.exportVoucherSeries) {
        return block(
          'VOUCHER_SERIES_UNVERIFIED',
          `Verifikatserien ${conn.exportVoucherSeries} finns inte i Fortnox`,
        )
      }

      const binding = (ref: string) => ({
        organizationId,
        externalDatabaseNumber: conn.fortnoxDatabaseNumber,
        evidenceRef: `${ref}@${at}`,
      })
      const accounts: Array<FortnoxVoucherDraftConfig['accounts'][number]> = []
      for (const acc of new Map(entry.lines.map((l) => [l.account.id, l.account])).values()) {
        const a = await getRef<{
          Account?: { Number?: unknown; Active?: unknown; Year?: unknown }
        }>(
          reader,
          auth.token,
          `/3/accounts/${acc.number}`,
          'ACCOUNT_UNVERIFIED',
          `Konto ${acc.number} finns inte i Fortnox för året`,
          { financialyear: fy.Id },
        )
        if (
          a?.Account?.Number !== acc.number ||
          a.Account.Active !== true ||
          (a.Account.Year !== undefined && a.Account.Year !== fy.Id)
        ) {
          return block(
            'ACCOUNT_UNVERIFIED',
            `Konto ${acc.number} finns inte som aktivt konto i Fortnox för året`,
          )
        }
        accounts.push({
          ...binding(`GET /3/accounts/${acc.number}?financialyear=${fy.Id}`),
          localAccountId: acc.id,
          localAccountNumber: acc.number,
          externalAccountNumber: acc.number,
        })
      }

      const snapshot: LocalJournalEntrySnapshot = {
        inputOrigin: 'PERSISTED_JOURNAL_ENTRY',
        id: entry.id,
        organizationId: entry.organizationId,
        date: entry.date,
        eventDate: entry.eventDate,
        description: entry.description,
        reference: entry.reference,
        source: entry.source,
        sourceId: entry.sourceId,
        aiToolExecutionId: entry.aiToolExecutionId,
        fiscalYear: entry.fiscalYear,
        series: entry.series,
        verNumber: entry.verNumber,
        reversalOfEntryId: entry.reversalOfEntryId,
        lines: entry.lines.map((l) => ({
          id: l.id,
          journalEntryId: l.journalEntryId,
          accountId: l.accountId,
          debit: l.debit === null ? null : l.debit.toString(),
          credit: l.credit === null ? null : l.credit.toString(),
          description: l.description,
          account: l.account,
        })),
      }
      const config: FortnoxVoucherDraftConfig = {
        organizationId,
        externalCompany: {
          organizationNumber: orgNumber,
          databaseNumber: conn.fortnoxDatabaseNumber,
          evidenceRef: `GET /3/companyinformation@${at}`,
        },
        financialYear: {
          ...binding(`GET /3/financialyears@${date}`),
          localFiscalYear: entry.fiscalYear,
          id: fy.Id,
          voucherYear: fy.Id,
          fromDate: fy.FromDate,
          toDate: fy.ToDate,
        },
        voucherSeries: {
          ...binding(`GET /3/voucherseries/${conn.exportVoucherSeries}`),
          code: conn.exportVoucherSeries,
          financialYearId: fy.Id,
        },
        accounts,
        dimensions: {
          ...binding(
            `kundbeslut:utan-dimension:${conn.exportOmitDimensionsBy}@${conn.exportOmitDimensionsAt.toISOString()}`,
          ),
          mode: 'OMIT',
          reason: 'Evenos verifikatrader bär ingen dimension; ingen härleds.',
        },
      }
      const res = buildFortnoxVoucherDraft(snapshot, config)
      if (res.status !== 'READY_DRY_RUN') return block(res.reason.code, res.reason.message)
      const draft = {
        payload: res.payload,
        query: res.query,
        provenance: res.provenance,
        liveExportAllowed: false as const,
      }
      return {
        ok: true,
        draft,
        binding: { generation: conn.generation, databaseNumber: conn.fortnoxDatabaseNumber },
        // Stabil hash över INNEHÅLL och BINDNING — inte över evidensens tidsstämplar.
        // Samma verifikat, företag, anslutningsgeneration, år, serie och kundbeslut ger
        // samma hash; en förändring av något av dem ger ny hash (sändning kräver då ny
        // förhandskontroll).
        draftHash: createHash('sha256')
          .update(
            JSON.stringify({
              payload: res.payload,
              query: res.query,
              binding: {
                journalEntryId: entry.id,
                databaseNumber: conn.fortnoxDatabaseNumber,
                orgNumber,
                generation: conn.generation,
                financialYearId: fy.Id,
                series: conn.exportVoucherSeries,
                omitDimensionsAt: conn.exportOmitDimensionsAt.toISOString(),
                omitDimensionsBy: conn.exportOmitDimensionsBy,
                lines: res.provenance.lines.map((l) => [
                  l.journalEntryLineId,
                  l.localAccountNumber,
                  l.debit,
                  l.credit,
                ]),
              },
            }),
          )
          .digest('hex'),
      }
    } catch (err) {
      if (err instanceof UnverifiedRef) return block(err.code, err.message)
      if (err instanceof FortnoxReadError) {
        if (err.kind === 'auth')
          await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED', reader.binding)
        return block(
          'FORTNOX_READ_FAILED',
          'Fortnox kunde inte läsas för förhandskontrollen; försök igen',
        )
      }
      throw err
    }
  }
}

/** En enskild referens (konto/serie) som Fortnox inte har (404/ogiltigt svar). */
class UnverifiedRef extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Detaljläsning där 'invalid' (t.ex. 404) betyder att referensen inte finns. */
async function getRef<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  code: string,
  message: string,
  query?: Record<string, string | number>,
): Promise<T> {
  try {
    return await reader.get<T>(token, path, query)
  } catch (err) {
    if (err instanceof FortnoxReadError && err.kind === 'invalid')
      throw new UnverifiedRef(code, message)
    throw err
  }
}

async function allPages<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  key: string,
): Promise<T[]> {
  // E4: strikt sidkontroll — giltiga heltal, TotalPages ≥ 1, oförändrade totaler på
  // varje sida, exakt antal och objektelement. Inkonsistens → ingen READY.
  const out: T[] = []
  let first: { tp: number; tr: number } | null = null
  const int = (x: unknown): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  for (let page = 1; ; page++) {
    const body = await reader.get<Record<string, unknown>>(token, path, { page, limit: 100 })
    if (isExactEmptyFirstPage(page, body, key)) return []
    const mi = (body?.MetaInformation ?? {}) as Record<string, unknown>
    const [cp, tp, tr] = [mi['@CurrentPage'], mi['@TotalPages'], mi['@TotalResources']]
    if (!int(cp) || !int(tp) || !int(tr) || tp < 1 || cp !== page)
      throw new FortnoxReadError('invalid')
    if (!first) first = { tp, tr }
    else if (first.tp !== tp || first.tr !== tr) throw new FortnoxReadError('invalid')
    const list = body?.[key]
    if (!Array.isArray(list)) throw new FortnoxReadError('invalid')
    if (list.some((x) => !x || typeof x !== 'object' || Array.isArray(x)))
      throw new FortnoxReadError('invalid')
    out.push(...(list as T[]))
    if (page >= first.tp) break
  }
  if (out.length !== first.tr) throw new FortnoxReadError('invalid')
  return out
}
