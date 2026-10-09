/**
 * TESTKUND-20261004/008 — KONTOMAPPNINGENS REVISIONER (KONTRAKT-008 §1, §7, §8, §10).
 *
 *  - behov(): vilka (roll, källkonto, behandling) organisationen behöver, ur dess enheter,
 *    depositioner, leverantörsfakturor och betalningar — och vilka händelser som INTE stöds.
 *  - skapaUtkast(): ny oföränderlig DRAFT-revision. Fortnox läses i samma stund (företag, år,
 *    varje målkonto); servern bedömer tekniken. Kundens val av målkonto förifylls aldrig.
 *  - godkann(): OWNER/ADMIN (KONTRAKTSBESKED-008 svar 5). Läser målkontona FÄRSKT och jämför med
 *    utkastets ögonblicksbild (V2); KONFLIKT, EJ_BELAGD och V4 kan aldrig godkännas. Föregående
 *    APPROVED för samma år blir SUPERSEDED och kundaktiveringen ogiltigförklaras i SAMMA
 *    transaktion. Databasen tillåter högst en APPROVED per (organisation, år).
 *  - kontroll(): kundaktiveringens mappningshinder (färsk, ingen drift, täcker behovet).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  revenueAccountForUnitType,
  vatRateForRent,
  type FortnoxAccountMappingDraftInput,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS, PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { ogiltigforklaraAktiveringar } from '../kundstart/activation-invalidation'
import { brytdatumIso } from '../kundstart/cutover'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'
import {
  BEHANDLING_TEXT,
  ROLL_TEXT,
  SAKNAS,
  drift,
  godkannandeHinder,
  innehallsSha,
  malfaktaUrSvar,
  nyckel,
  teknik,
  tillatetPar,
  type Malfakta,
  type Momsbehandling,
  type Roll,
} from './fortnox-kontomappning'

export const REDIGERA_ROLLER = ['OWNER', 'ADMIN'] as const
export const GODKANN_ROLLER = ['OWNER', 'ADMIN'] as const

/** Kundaktiveringens mappningskontroll (injiceras som FORTNOX_MAPPNINGSKONTROLL). */
export const FORTNOX_MAPPNINGSKONTROLL = Symbol('FORTNOX_MAPPNINGSKONTROLL')
export type Mappningskontroll = (
  organizationId: string,
  financialYearId: number,
) => Promise<string[]>

export interface Behovsrad {
  role: Roll
  vatTreatment: Momsbehandling
  sourceAccountNumber: number
  sourceAccountName: string
  varfor: string
}

type Lasare = { reader: RefreshingLedgerReader; token: string }

@Injectable()
export class FortnoxKontomappningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_LEDGER_READER) private readonly ledger: FortnoxLedgerReader,
  ) {}

  // ── Behov ────────────────────────────────────────────────────────────────────────────────

  async behov(
    organizationId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ rader: Behovsrad[]; ejStodda: string[] }> {
    const konton = await db.account.findMany({
      where: { organizationId },
      select: { number: true, name: true },
    })
    const namn = new Map(konton.map((k) => [k.number, k.name]))
    const rader = new Map<string, Behovsrad>()
    const ejStodda = new Set<string>()
    const lagg = (role: Roll, n: number, varfor: string, beh?: Momsbehandling) => {
      const vatTreatment =
        beh ??
        (role === 'HYRESINTAKT'
          ? 'MOMSFRI'
          : role === 'INGAENDE_MOMS'
            ? 'AVDRAGSGILL'
            : 'EJ_TILLAMPLIG')
      const k = nyckel(role, n, vatTreatment)
      if (!rader.has(k))
        rader.set(k, {
          role,
          vatTreatment,
          sourceAccountNumber: n,
          sourceAccountName: namn.get(n) ?? `Konto ${n}`,
          varfor,
        })
    }

    const enheter = await db.unit.findMany({
      where: { property: { organizationId } },
      select: { type: true, voluntaryTaxLiability: true },
    })
    const typer = new Map<string, number>()
    for (const u of enheter) {
      const sats = vatRateForRent(u.type, u.voluntaryTaxLiability)
      if (u.type === 'APARTMENT' && sats === 0) {
        lagg('HYRESINTAKT', revenueAccountForUnitType(u.type), 'hyresavier för bostäder')
        lagg('KUNDFORDRAN', 1510, 'hyresavier och betalningar')
        lagg('LIKVID', 1930, 'inbetalningar till bank')
      } else typer.set(u.type, (typer.get(u.type) ?? 0) + 1)
    }
    for (const [typ, antal] of typer)
      ejStodda.add(
        `Hyra för enhetstyp ${typ} (${antal} st) — bara momsfri bostadshyra stöds i denna version`,
      )

    if ((await db.deposit.count({ where: { organizationId } })) > 0) {
      lagg('KUNDFORDRAN', 1510, 'depositionsfakturor')
      lagg('DEPOSITIONSSKULD', 2890, 'mottagna depositioner')
      lagg('LIKVID', 1930, 'depositionsbetalningar och återbetalningar')
    }
    const fakturor = await db.supplierInvoice.findMany({
      where: { organizationId, cancelledAt: null },
      select: { expenseAccount: true, vatAmount: true },
    })
    for (const f of fakturor) {
      lagg('KOSTNAD', f.expenseAccount, 'leverantörsfakturor')
      if (Number(f.vatAmount) > 0)
        lagg('INGAENDE_MOMS', 2641, 'ingående moms på leverantörsfakturor')
      lagg('LEVERANTORSSKULD', 2440, 'leverantörsfakturor')
      lagg('LIKVID', 1930, 'leverantörsbetalningar')
    }
    // Faktiska likvidkonton i betalningsverifikat (t.ex. 1910/1934 vid manuell betalning).
    const likvid = await db.journalEntryLine.findMany({
      where: {
        journalEntry: { organizationId, source: { in: ['PAYMENT', 'SUPPLIER_INVOICE'] } },
        account: { number: { gte: 1900, lte: 1999 } },
      },
      select: { account: { select: { number: true } } },
      distinct: ['accountId'],
    })
    for (const l of likvid) lagg('LIKVID', l.account.number, 'konto i betalningsverifikat')

    // Ej stödda händelser som faktiskt finns efter brytdatum (exporteras aldrig i v1).
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { billingCutoverDate: true },
    })
    const efter = org?.billingCutoverDate ? { gte: org.billingCutoverDate } : undefined
    const verifikat = await db.journalEntry.findMany({
      where: { organizationId, ...(efter ? { date: efter } : {}) },
      select: { source: true, sourceId: true, reversalOfEntryId: true },
    })
    const stodda =
      /^(rent-notice|rent-notice-payment|rent-notice-bank-payment|deposit-invoice|deposit-manual-payment|deposit-refund|supplier-invoice|supplier-invoice-payment):/
    const grupper = new Map<string, number>()
    for (const v of verifikat) {
      if (v.reversalOfEntryId || stodda.test(v.sourceId ?? '')) continue
      const g =
        v.source === 'MANUAL'
          ? 'manuella verifikat'
          : v.source === 'AI'
            ? 'verifikat skapade av AI'
            : `${v.source}${v.sourceId?.includes(':') ? ` (${v.sourceId.split(':')[0]})` : ''}`
      grupper.set(g, (grupper.get(g) ?? 0) + 1)
    }
    for (const [g, n] of grupper)
      ejStodda.add(`${g}: ${n} verifikat efter brytdatum — exporteras inte i denna version`)

    return {
      rader: [...rader.values()].sort(
        (a, b) => a.sourceAccountNumber - b.sourceAccountNumber || a.role.localeCompare(b.role),
      ),
      ejStodda: [...ejStodda],
    }
  }

  // ── Läsning ──────────────────────────────────────────────────────────────────────────────

  async oversikt(organizationId: string) {
    const [b, revisioner] = await Promise.all([
      this.behov(organizationId),
      this.prisma.fortnoxAccountMappingRevision.findMany({
        where: { organizationId },
        orderBy: { revision: 'desc' },
        take: 20,
        include: { rows: { orderBy: [{ sourceAccountNumber: 'asc' }, { role: 'asc' }] } },
      }),
    ])
    return {
      behov: b.rader,
      ejStodda: b.ejStodda,
      revisioner: revisioner.map((r) => ({
        id: r.id,
        revision: r.revision,
        status: r.status,
        fortnoxDatabaseNumber: r.fortnoxDatabaseNumber,
        financialYearId: r.financialYearId,
        financialYearFrom: brytdatumIso(r.financialYearFrom),
        financialYearTo: brytdatumIso(r.financialYearTo),
        contentSha256: r.contentSha256,
        createdById: r.createdById,
        createdByRole: r.createdByRole,
        createdAt: r.createdAt,
        approvedById: r.approvedById,
        approvedByRole: r.approvedByRole,
        approvedAt: r.approvedAt,
        supersededAt: r.supersededAt,
        rows: r.rows.map((x) => ({
          id: x.id,
          role: x.role,
          vatTreatment: x.vatTreatment,
          sourceAccountNumber: x.sourceAccountNumber,
          sourceAccountName: x.sourceAccountName,
          targetAccountNumber: x.targetAccountNumber,
          targetName: x.targetName,
          targetActive: x.targetActive,
          targetVatCode: x.targetVatCode,
          targetVatCodePresent: x.targetVatCodePresent,
          targetExists: x.targetExists,
          technical: x.technical,
          technicalReason: x.technicalReason,
          approvable: godkannandeHinder(x) === null,
          hinder: godkannandeHinder(x),
        })),
      })),
    }
  }

  // ── Fortnox-läsning ─────────────────────────────────────────────────────────────────────

  private async lasare(organizationId: string): Promise<Lasare> {
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException('Fortnox är inte anslutet')
      throw err
    }
    return {
      reader: new RefreshingLedgerReader(this.ledger, this.connections, organizationId, auth),
      token: auth.token,
    }
  }

  private async fortnoxFel<T>(organizationId: string, l: Lasare, f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } catch (err) {
      if (err instanceof FortnoxReadError) {
        if (err.kind === 'auth') {
          await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED', l.reader.binding)
          throw new ConflictException('Fortnox-inloggningen har upphört; anslut igen')
        }
        throw new ConflictException('Fortnox kunde inte läsas just nu; försök igen')
      }
      throw err
    }
  }

  private async lasKonto(l: Lasare, n: number, financialYearId: number): Promise<Malfakta> {
    try {
      return malfaktaUrSvar(
        n,
        await l.reader.get<{ Account?: Record<string, unknown> }>(l.token, `/3/accounts/${n}`, {
          financialyear: financialYearId,
        }),
      )
    } catch (err) {
      if (err instanceof FortnoxReadError && err.kind === 'invalid') return SAKNAS
      throw err
    }
  }

  // ── Utkast ───────────────────────────────────────────────────────────────────────────────

  async skapaUtkast(
    organizationId: string,
    user: { sub: string; role: string },
    input: FortnoxAccountMappingDraftInput,
  ) {
    if (!(REDIGERA_ROLLER as readonly string[]).includes(user.role))
      throw new ForbiddenException('Bara OWNER eller ADMIN får skapa en kontomappning.')
    const nycklar = new Set<string>()
    for (const r of input.rows) {
      if (!tillatetPar(r.role, r.vatTreatment))
        throw new BadRequestException('Behandlingen gäller inte för rollen')
      const k = nyckel(r.role, r.sourceAccountNumber, r.vatTreatment)
      if (nycklar.has(k)) throw new BadRequestException('Samma rad förekommer två gånger')
      nycklar.add(k)
    }
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn || conn.status !== 'ACTIVE') throw new ConflictException('Fortnox är inte anslutet')
    if (!conn.fortnoxOrgNumber)
      throw new ConflictException('Fortnox-företagets organisationsnummer saknas')
    const egna = await this.prisma.account.findMany({
      where: { organizationId, number: { in: input.rows.map((r) => r.sourceAccountNumber) } },
      select: { number: true, name: true },
    })
    const egetNamn = new Map(egna.map((a) => [a.number, a.name]))
    for (const r of input.rows)
      if (!egetNamn.has(r.sourceAccountNumber))
        throw new BadRequestException(
          `Konto ${r.sourceAccountNumber} finns inte i Evenos kontoplan`,
        )

    const l = await this.lasare(organizationId)
    const { ar, rader } = await this.fortnoxFel(organizationId, l, async () => {
      const ci = await l.reader.get<{
        CompanyInformation?: { DatabaseNumber?: unknown; OrganizationNumber?: unknown }
      }>(l.token, '/3/companyinformation')
      if (
        ci?.CompanyInformation?.DatabaseNumber !== conn.fortnoxDatabaseNumber ||
        ci.CompanyInformation.OrganizationNumber !== conn.fortnoxOrgNumber
      )
        throw new ConflictException('Fortnox svarade för ett annat företag än det anslutna')
      const fy = await l.reader.get<{
        FinancialYear?: { Id?: unknown; FromDate?: unknown; ToDate?: unknown }
      }>(l.token, `/3/financialyears/${input.financialYearId}`)
      const y = fy?.FinancialYear
      if (
        y?.Id !== input.financialYearId ||
        typeof y.FromDate !== 'string' ||
        typeof y.ToDate !== 'string'
      )
        throw new BadRequestException('Räkenskapsåret finns inte i Fortnox')
      const nu = new Date()
      const rader = []
      for (const r of input.rows) {
        const f = await this.lasKonto(l, r.targetAccountNumber, input.financialYearId)
        const t = teknik(r.role, r.vatTreatment, f, input.financialYearId)
        rader.push({
          role: r.role,
          vatTreatment: r.vatTreatment,
          sourceAccountNumber: r.sourceAccountNumber,
          sourceAccountName: egetNamn.get(r.sourceAccountNumber)!,
          targetAccountNumber: r.targetAccountNumber,
          targetExists: f.exists,
          targetName: f.name,
          targetActive: f.active,
          targetVatCode: f.vatCode,
          targetVatCodePresent: f.vatCodePresent,
          targetYear: f.year,
          technical: t.teknik,
          technicalReason: t.skal,
          readAt: nu,
        })
      }
      return { ar: { id: input.financialYearId, fran: y.FromDate, till: y.ToDate }, rader }
    })

    for (let forsok = 0; ; forsok++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const senast = await tx.fortnoxAccountMappingRevision.aggregate({
            where: { organizationId },
            _max: { revision: true },
          })
          const revision = (senast._max.revision ?? 0) + 1
          const contentSha256 = innehallsSha({
            organizationId,
            revision,
            connectionId: conn.id,
            connectionGeneration: conn.generation,
            fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
            fortnoxOrgNumber: conn.fortnoxOrgNumber!,
            financialYearId: ar.id,
            financialYearFrom: ar.fran,
            financialYearTo: ar.till,
            rows: rader,
          })
          const rev = await tx.fortnoxAccountMappingRevision.create({
            data: {
              organizationId,
              revision,
              status: 'DRAFT',
              connectionId: conn.id,
              connectionGeneration: conn.generation,
              fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
              fortnoxOrgNumber: conn.fortnoxOrgNumber!,
              financialYearId: ar.id,
              financialYearFrom: new Date(`${ar.fran}T00:00:00Z`),
              financialYearTo: new Date(`${ar.till}T00:00:00Z`),
              contentSha256,
              createdById: user.sub,
              createdByRole: user.role,
              rows: { create: rader },
            },
            select: { id: true, revision: true, contentSha256: true, status: true },
          })
          return rev
          // Inget pengaflöde: en ren insert av revisionen med sina rader.
        }, PRISMA_DEFAULT_TX_LIMITS)
      } catch (err) {
        // Två samtidiga utkast: samma revisionsnummer kolliderar — försök med nästa.
        if (
          forsok < 3 &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        )
          continue
        throw err
      }
    }
  }

  // ── Godkännande ─────────────────────────────────────────────────────────────────────────

  async godkann(
    organizationId: string,
    user: { sub: string; role: string },
    revisionId: string,
    contentSha256: string,
  ) {
    if (!(GODKANN_ROLLER as readonly string[]).includes(user.role))
      throw new ForbiddenException('Bara OWNER eller ADMIN får godkänna en kontomappning.')
    const rev = await this.prisma.fortnoxAccountMappingRevision.findFirst({
      where: { id: revisionId, organizationId },
      include: { rows: true },
    })
    if (!rev) throw new NotFoundException('Revisionen hittades inte')
    if (rev.status !== 'DRAFT') throw new ConflictException('Revisionen är inte ett utkast')
    if (rev.contentSha256 !== contentSha256)
      throw new ConflictException('Underlaget har ändrats sedan du läste det — läs det igen')
    const hinder = rev.rows
      .map((r) => {
        const h = godkannandeHinder(r)
        return h ? `${r.sourceAccountNumber} → ${r.targetAccountNumber}: ${h}` : null
      })
      .filter((x): x is string => x !== null)
    if (hinder.length)
      throw new ConflictException(`Revisionen kan inte godkännas: ${hinder.join(' | ')}`)

    // V2: målkontona läses FÄRSKT och jämförs med utkastets ögonblicksbild.
    const l = await this.lasare(organizationId)
    const drifter = await this.fortnoxFel(organizationId, l, async () => {
      const ut: string[] = []
      for (const r of rev.rows) {
        const d = drift(r, await this.lasKonto(l, r.targetAccountNumber, rev.financialYearId))
        if (d) ut.push(`${r.targetAccountNumber} (${d})`)
      }
      return ut
    })
    if (drifter.length)
      throw new ConflictException(
        `Fortnox-kontona har ändrats sedan utkastet skapades: ${drifter.join(', ')} — skapa ett nytt utkast`,
      )

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
        const nu = await tx.fortnoxAccountMappingRevision.findFirst({
          where: { id: revisionId, organizationId },
          select: { status: true, contentSha256: true },
        })
        if (nu?.status !== 'DRAFT' || nu.contentSha256 !== contentSha256)
          throw new ConflictException('Revisionen har ändrats — läs den igen')
        const nyare = await tx.fortnoxAccountMappingRevision.count({
          where: {
            organizationId,
            financialYearId: rev.financialYearId,
            revision: { gt: rev.revision },
          },
        })
        if (nyare > 0)
          throw new ConflictException(
            'Det finns en nyare revision för året — granska den i stället',
          )
        const conn = await tx.fortnoxConnection.findUnique({ where: { organizationId } })
        if (
          !conn ||
          conn.status !== 'ACTIVE' ||
          conn.id !== rev.connectionId ||
          conn.generation !== rev.connectionGeneration ||
          conn.fortnoxDatabaseNumber !== rev.fortnoxDatabaseNumber ||
          conn.fortnoxOrgNumber !== rev.fortnoxOrgNumber
        )
          throw new ConflictException(
            'Fortnox-anslutningen är en annan än när utkastet skapades — skapa ett nytt utkast',
          )
        const tid = new Date()
        await tx.fortnoxAccountMappingRevision.updateMany({
          where: { organizationId, financialYearId: rev.financialYearId, status: 'APPROVED' },
          data: { status: 'SUPERSEDED', supersededAt: tid },
        })
        const ut = await tx.fortnoxAccountMappingRevision.update({
          where: { id: revisionId },
          data: {
            status: 'APPROVED',
            approvedById: user.sub,
            approvedByRole: user.role,
            approvedAt: tid,
          },
          select: { id: true, revision: true, status: true, approvedAt: true, contentSha256: true },
        })
        await ogiltigforklaraAktiveringar(
          tx,
          organizationId,
          `Kontomappningen ändrades (revision ${rev.revision} godkänd).`,
        )
        return ut
      }, PAYMENT_TX_LIMITS)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException('En annan revision godkändes samtidigt — läs om')
      throw err
    }
  }

  // ── Kundaktiveringens kontroll ──────────────────────────────────────────────────────────

  async kontroll(organizationId: string, financialYearId: number): Promise<string[]> {
    const hinder: string[] = []
    const b = await this.behov(organizationId)
    for (const e of b.ejStodda) hinder.push(`Ej stödd i kontomappningen: ${e}.`)
    const rev = await this.prisma.fortnoxAccountMappingRevision.findFirst({
      where: { organizationId, status: 'APPROVED', financialYearId },
      include: { rows: true },
    })
    if (!rev) {
      hinder.push(
        `Ingen godkänd kontomappning för räkenskapsår ${financialYearId} — ingenting skickas ` +
          'till Fortnox via kundvägen förrän kontomappningen är godkänd.',
      )
      return hinder
    }
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (
      !conn ||
      conn.id !== rev.connectionId ||
      conn.generation !== rev.connectionGeneration ||
      conn.fortnoxDatabaseNumber !== rev.fortnoxDatabaseNumber ||
      conn.fortnoxOrgNumber !== rev.fortnoxOrgNumber
    )
      hinder.push(
        `Kontomappningen (revision ${rev.revision}) godkändes för en annan Fortnox-anslutning — godkänn en ny revision.`,
      )
    const finns = new Set(
      rev.rows.map((r) => nyckel(r.role, r.sourceAccountNumber, r.vatTreatment)),
    )
    for (const x of b.rader)
      if (!finns.has(nyckel(x.role, x.sourceAccountNumber, x.vatTreatment)))
        hinder.push(
          `Kontomappningen saknar Eveno ${x.sourceAccountNumber} «${x.sourceAccountName}» som ` +
            `${ROLL_TEXT[x.role]} (${BEHANDLING_TEXT[x.vatTreatment]}; ${x.varfor}).`,
        )
    for (const r of rev.rows) {
      const h = godkannandeHinder(r)
      if (h)
        hinder.push(`Kontomappningen ${r.sourceAccountNumber} → ${r.targetAccountNumber}: ${h}.`)
    }
    const l = await this.lasare(organizationId)
    const drifter = await this.fortnoxFel(organizationId, l, async () => {
      const ut: string[] = []
      for (const r of rev.rows) {
        const d = drift(r, await this.lasKonto(l, r.targetAccountNumber, financialYearId))
        if (d) ut.push(`${r.targetAccountNumber} (${d})`)
      }
      return ut
    })
    if (drifter.length)
      hinder.push(
        `Fortnox-konton har ändrats sedan kontomappningen godkändes: ${drifter.join(', ')} — godkänn en ny revision.`,
      )
    return hinder
  }
}
