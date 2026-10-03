/**
 * KUNDSTART-001 §6/§11/§12: kundaktivering (godkänn, återkalla, status). Bara OWNER
 * beslutar; ADMIN och ACCOUNTANT får läsa. Godkännandet sker i en transaktion med
 * FOR UPDATE på organisationen och prövar avstämningen mot AKTUELLA data (§11 punkt 4).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { brytdatumIso } from '../kundstart/cutover'
import { kronorTillOre } from '../kundstart/opening-csv'
import { saldoUrLasning, senasteSaldolasning } from '../kundstart/opening-fortnox-balance'
import type { Avstamning } from '../kundstart/opening-reconciliation'
import { ogiltigforklaraAktiveringar } from '../kundstart/activation-invalidation'
import { evenoPosterForeBrytdatum } from '../kundstart/pre-cutover-records'
import {
  fortnoxRiskkontroll,
  registerHinder,
  type ForstaPeriodRegister,
} from '../kundstart/first-period'
import {
  fortnoxCustomerWritesOptIn,
  konsekvenstext,
  mappningsSha,
  sammaOrgnr,
  provaAktivering,
} from './fortnox-customer-activation'

const oreAv = (d: Prisma.Decimal) => kronorTillOre(d.toFixed(2))!

interface Forslag {
  ok: boolean
  hinder: string[]
  text: string | null
  textSha256: string | null
  bindning: {
    connectionId: string
    connectionGeneration: number
    fortnoxDatabaseNumber: number
    fortnoxOrgNumber: string
    financialYearId: number
    financialYearFrom: Date
    financialYearTo: Date
    voucherSeries: string
    mappingSha256: string
    openingPackageId: string
    fortnoxReadRunId: string
    financialYearAccountingMethod: string
  } | null
}

@Injectable()
export class FortnoxCustomerActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get flaggaPa(): boolean {
    return fortnoxCustomerWritesOptIn(this.config)
  }

  /** Förslag + hinder, beräknat mot aktuellt läge. Används av status och godkännande. */
  private async forslag(
    db: Prisma.TransactionClient,
    organizationId: string,
    financialYearId: number | null,
  ): Promise<Forslag> {
    const hinder: string[] = []
    if (!this.flaggaPa)
      hinder.push(
        'Driftflaggan FORTNOX_CUSTOMER_WRITES är av i denna miljö — kundskrivning är avstängd.',
      )
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, orgNumber: true, billingCutoverDate: true },
    })
    const conn = await db.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!org)
      return {
        ok: false,
        hinder: ['Organisationen saknas.'],
        text: null,
        textSha256: null,
        bindning: null,
      }
    if (!org.billingCutoverDate) hinder.push('Brytdatum saknas.')
    else {
      const fore = await evenoPosterForeBrytdatum(db, organizationId, org.billingCutoverDate)
      if (fore) hinder.push(fore)
    }
    if (!conn || conn.status !== 'ACTIVE') hinder.push('Fortnox är inte anslutet.')
    else {
      if (!sammaOrgnr(conn.fortnoxOrgNumber, org.orgNumber))
        hinder.push('Fortnox-företagets organisationsnummer är inte lika med Evenos.')
      if (!conn.exportVoucherSeries) hinder.push('Verifikatserie för export är inte vald.')
      const mapp = await db.fortnoxDimensionMapping.count({ where: { organizationId } })
      if (!conn.exportOmitDimensionsAt && mapp === 0)
        hinder.push(
          'Dimensionsbeslut saknas (mappningar eller uttryckligt beslut att exportera utan).',
        )
    }
    if (financialYearId === null) hinder.push('Räkenskapsår är inte valt.')

    // Öppningen: senaste EXECUTED-paket, avstämt mot den senaste läsningen.
    const paket = await db.openingPackage.findFirst({
      where: { organizationId, status: 'EXECUTED' },
      orderBy: { executedAt: 'desc' },
    })
    let avstamning: Avstamning | null = null
    if (!paket) hinder.push('Inget verkställt öppningspaket (en nollöppning är också ett paket).')
    else {
      avstamning = paket.reconciliation as unknown as Avstamning
      if (org.billingCutoverDate?.getTime() !== paket.cutoverDate.getTime())
        hinder.push('Öppningspaketets brytdatum är inte organisationens.')
      if (paket.reconciliationStatus !== 'AVSTAMD' && paket.reconciliationStatus !== 'AVGRANSAD')
        hinder.push(
          paket.reconciliationStatus === 'DIFFERENS'
            ? 'Startavstämningen har en oförklarad DIFFERENS — aktivering och fullständigt övertagande är blockerade.'
            : 'Startavstämningen är inte gjord (Fortnox-saldo per brytdatum saknas).',
        )
      // Omprövning mot aktuella data (§11): läsningen är fortfarande den senaste och
      // giltig, och saldot är detsamma som avstämningen byggde på.
      const senaste = await senasteSaldolasning(db, organizationId)
      if (!paket.fortnoxReadRunId || senaste?.id !== paket.fortnoxReadRunId)
        hinder.push(
          'En nyare Fortnox-läsning finns än den paketet stämdes av mot — pröva avstämningen igen.',
        )
      else {
        const s = saldoUrLasning(senaste, conn, paket.cutoverDate)
        if (!s.ok) hinder.push(s.skal)
        else if (
          paket.fortnoxBalance1510 === null ||
          paket.fortnoxBalance2890 === null ||
          s.saldo.saldo1510Ore !== oreAv(paket.fortnoxBalance1510) ||
          s.saldo.saldo2890Ore !== oreAv(paket.fortnoxBalance2890)
        )
          hinder.push('Fortnox-saldot per brytdatum har ändrats sedan avstämningen.')
      }
      // KUNDSTART-009: första perioden — registret är underlaget, läsningen en riskkontroll.
      const forsta = registerHinder(paket.firstPeriodRegister, paket.cutoverDate)
      if (forsta) hinder.push(forsta)
      else if (conn) {
        const risk = await fortnoxRiskkontroll(
          db,
          organizationId,
          conn.id,
          paket.cutoverDate,
          paket.firstPeriodRegister as unknown as ForstaPeriodRegister,
        )
        if (risk) hinder.push(risk)
      }
      // Öppningsavierna och de historiska depositionerna ska summera till paketen.
      const rader = await db.openingPackageRow.findMany({
        where: { package: { organizationId, status: 'EXECUTED' } },
        select: { id: true, kind: true, openAmount: true },
      })
      const fordranRader = rader.filter((r) => r.kind === 'RECEIVABLE')
      const depRader = rader.filter((r) => r.kind === 'DEPOSIT')
      const avier = await db.rentNotice.findMany({
        where: { organizationId, origin: 'OPENING_PACKAGE' },
        select: { openingRowId: true, totalAmount: true },
      })
      const dep = await db.deposit.findMany({
        where: { organizationId, origin: 'OPENING_PACKAGE' },
        select: { openingRowId: true, amount: true },
      })
      const sum = (xs: { v: Prisma.Decimal }[]) => xs.reduce((a, x) => a + oreAv(x.v), 0)
      if (
        avier.length !== fordranRader.length ||
        sum(avier.map((a) => ({ v: a.totalAmount }))) !==
          sum(fordranRader.map((r) => ({ v: r.openAmount })))
      )
        hinder.push('Öppningsavierna summerar inte till paketens fordringar.')
      if (
        dep.length !== depRader.length ||
        sum(dep.map((d) => ({ v: d.amount }))) !== sum(depRader.map((r) => ({ v: r.openAmount })))
      )
        hinder.push('De historiska depositionerna summerar inte till paketens depositioner.')
    }

    // Räkenskapsåret ur en COMPLETE läsning (Fortnox anger årets gränser).
    let ar: { id: number; fran: Date; till: Date } | null = null
    if (financialYearId !== null) {
      const run = await db.fortnoxReadRun.findFirst({
        where: {
          organizationId,
          financialYearId,
          status: 'COMPLETE',
          financialYearStart: { not: null },
          financialYearEnd: { not: null },
          ...(conn ? { connectionId: conn.id } : {}),
        },
        orderBy: { startedAt: 'desc' },
      })
      if (!run)
        hinder.push(
          `Räkenskapsår ${financialYearId} är inte verifierat i Fortnox (gör en läsning för året).`,
        )
      else {
        // K-B8: årets bokföringsmetod ur samma läsning — bara ACCRUAL stöds; saknat är inte ACCRUAL.
        const metod = (run.summary as { financialYearAccountingMethod?: string | null } | null)
          ?.financialYearAccountingMethod
        if (metod !== 'ACCRUAL')
          hinder.push(
            `Eveno stödjer bara faktureringsmetoden (ACCRUAL) i denna version; räkenskapsår ` +
              `${financialYearId} i Fortnox har metod ${metod ?? 'okänd'}. Kundens metod ändras inte.`,
          )
        else
          ar = { id: financialYearId, fran: run.financialYearStart!, till: run.financialYearEnd! }
      }
    }

    if (hinder.length > 0 || !conn || !paket || !ar || !org.billingCutoverDate || !avstamning)
      return { ok: false, hinder, text: null, textSha256: null, bindning: null }
    const mappingSha256 = (await mappningsSha(db, organizationId, ar.id))!
    const text = konsekvenstext({
      foretag: org.name,
      orgnr: conn.fortnoxOrgNumber!,
      databasnummer: conn.fortnoxDatabaseNumber,
      ar: { id: ar.id, fran: brytdatumIso(ar.fran), till: brytdatumIso(ar.till) },
      serie: conn.exportVoucherSeries!,
      mappingSha: mappingSha256,
      brytdatum: org.billingCutoverDate,
      paketId: paket.id,
      nollOppning: paket.zeroOpening,
      avstamning: {
        status: paket.reconciliationStatus!,
        texter: avstamning.konton.map((k) => k.text),
      },
    })
    return {
      ok: true,
      hinder,
      text,
      textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bindning: {
        connectionId: conn.id,
        connectionGeneration: conn.generation,
        fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
        fortnoxOrgNumber: conn.fortnoxOrgNumber!,
        financialYearId: ar.id,
        financialYearFrom: ar.fran,
        financialYearTo: ar.till,
        voucherSeries: conn.exportVoucherSeries!,
        mappingSha256,
        openingPackageId: paket.id,
        fortnoxReadRunId: paket.fortnoxReadRunId!,
        financialYearAccountingMethod: 'ACCRUAL',
      },
    }
  }

  async status(organizationId: string, financialYearId: number | null) {
    const aktiv = await provaAktivering(this.prisma, organizationId, null)
    const historik = await this.prisma.fortnoxCustomerActivation.findMany({
      where: { organizationId },
      orderBy: { approvedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        fortnoxDatabaseNumber: true,
        financialYearId: true,
        voucherSeries: true,
        openingPackageId: true,
        approvedById: true,
        approvedAt: true,
        revokedAt: true,
        supersededAt: true,
        invalidatedReason: true,
        consequencesText: true,
      },
    })
    const f = await this.forslag(this.prisma, organizationId, financialYearId)
    return {
      flaggaPa: this.flaggaPa,
      aktiv: aktiv.ok ? { id: aktiv.binding.activationId, giltig: true } : null,
      aktivHinder: aktiv.ok ? null : aktiv.skal,
      forslag: { ok: f.ok, hinder: f.hinder, text: f.text, textSha256: f.textSha256 },
      historik,
    }
  }

  async approve(
    organizationId: string,
    user: { sub: string; role: string },
    input: { financialYearId: number; consequencesSha256: string },
  ) {
    if (user.role !== 'OWNER')
      throw new ForbiddenException('Bara OWNER får aktivera kundskrivning.')
    if (!this.flaggaPa)
      throw new ConflictException(
        'Driftflaggan FORTNOX_CUSTOMER_WRITES är av — kundskrivning kan inte aktiveras.',
      )
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
        const f = await this.forslag(tx, organizationId, input.financialYearId)
        if (!f.ok || !f.bindning || !f.text || !f.textSha256)
          throw new ConflictException(`Kundaktivering är blockerad: ${f.hinder.join(' ')}`)
        if (f.textSha256 !== input.consequencesSha256)
          throw new ConflictException(
            'Konsekvenstexten har ändrats sedan du läste den — läs den igen och godkänn på nytt.',
          )
        await ogiltigforklaraAktiveringar(tx, organizationId, 'Ersatt av ett nytt kundgodkännande.')
        return tx.fortnoxCustomerActivation.create({
          data: {
            organizationId,
            status: 'ACTIVE',
            ...f.bindning,
            consequencesText: f.text,
            consequencesSha256: f.textSha256,
            approvedById: user.sub,
          },
          select: { id: true, status: true, approvedAt: true, consequencesSha256: true },
        })
      },
      { timeout: 30_000, maxWait: 5_000 },
    )
  }

  async revoke(organizationId: string, user: { sub: string; role: string }) {
    if (user.role !== 'OWNER')
      throw new ForbiddenException('Bara OWNER får återkalla kundskrivning.')
    const r = await this.prisma.fortnoxCustomerActivation.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: {
        status: 'REVOKED',
        revokedById: user.sub,
        revokedAt: new Date(),
        invalidatedReason: 'Återkallad av OWNER.',
      },
    })
    if (r.count === 0) throw new BadRequestException('Ingen aktiv kundaktivering att återkalla.')
    return { revoked: r.count }
  }
}
