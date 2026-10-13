/**
 * KUNDSTART-001 §6/§11/§12: kundaktivering (godkänn, återkalla, status). Bara OWNER
 * beslutar; ADMIN och ACCOUNTANT får läsa. Godkännandet sker i en transaktion med
 * FOR UPDATE på organisationen och prövar avstämningen mot AKTUELLA data (§11 punkt 4).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { brytdatumIso } from '../kundstart/cutover'
import { kronorTillOre } from '../kundstart/opening-csv'
import { saldoUrLasning, senasteSaldolasning } from '../kundstart/opening-fortnox-balance'
import type { Avstamning } from '../kundstart/opening-reconciliation'
import { ogiltigforklaraAktiveringar } from '../kundstart/activation-invalidation'
import { evenoPosterForeBrytdatum } from '../kundstart/pre-cutover-records'
import { isOpen as leverantorsfakturaArOppen } from '../accounting/supplier-invoice-status'
import { FORTNOX_MAPPNINGSKONTROLL, type Mappningskontroll } from './fortnox-kontomappning.service'
import {
  fortnoxRiskkontroll,
  registerHinder,
  type ForstaPeriodRegister,
} from '../kundstart/first-period'
import {
  fortnoxCustomerWritesOptIn,
  huvudbokForetagsfel,
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
  private readonly logger = new Logger(FortnoxCustomerActivationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // TESTKUND-008 K8.1: färsk kontroll av den godkända kontomappningen (ersätter #946:s
    // kontoförkontroll). Injiceras i FortnoxModule; saknas den (enhetsprov som bygger tjänsten
    // direkt) görs ingen kontroll.
    @Optional()
    @Inject(FORTNOX_MAPPNINGSKONTROLL)
    private readonly mappningsKontroll: Mappningskontroll | null = null,
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
      // HUVUDBOK-STEG1 T1-3: en ny aktivering får inte gälla ett annat företag än huvudboksvalet.
      const huvudbok = await huvudbokForetagsfel(db, organizationId, [
        { databaseNumber: conn.fortnoxDatabaseNumber, orgNumber: conn.fortnoxOrgNumber },
      ])
      if (huvudbok) hinder.push(huvudbok)
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

    // TESTKUND-008 (ersätter TESTKUND-006 F-1/F-2): kundaktiveringen kräver en godkänd, färsk
    // kontomappning för året som täcker allt organisationen behöver. Saknas den skickas ingenting
    // via kundvägen. Ej stödda händelser är hinder — ingen tyst delaktivering. En betalning skickas
    // ändå bara när fordran finns i Fortnox (ORIGIN_NOT_CONFIRMED i exportbygget).
    if (this.mappningsKontroll && financialYearId !== null && conn?.status === 'ACTIVE') {
      try {
        hinder.push(...(await this.mappningsKontroll(organizationId, financialYearId)))
      } catch {
        hinder.push('Kontomappningen kunde inte kontrolleras mot Fortnox just nu — försök igen.')
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
    const hb = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ledgerOwner: true, ledgerOwnerSetAt: true, ledgerOwnerFortnoxDatabaseNumber: true },
    })
    return {
      flaggaPa: this.flaggaPa,
      huvudbok: {
        agare: hb?.ledgerOwner ?? 'EVENO',
        valdAt: hb?.ledgerOwnerSetAt ?? null,
        fortnoxDatabasnummer: hb?.ledgerOwnerFortnoxDatabaseNumber ?? null,
      },
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
    return this.prisma.$transaction(async (tx) => {
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
    }, PAYMENT_TX_LIMITS)
  }

  /**
   * HUVUDBOK-STEG1 (154): OWNER väljer Fortnox som huvudbok. Enda vägen till FORTNOX.
   *
   * Samma lås som `approve` (FOR UPDATE på organisationen); skrivvägarnas regel läser värdet med
   * FOR SHARE i sin egen transaktion, så beslut och skrivning kan inte passera med olika regler.
   * Bindningen tas ur den AKTIVA kundaktiveringen, prövad med `provaAktivering` mot aktuell
   * anslutning i samma transaktion. Ägarbeslutets spår är aktiveringsraden (approvedById,
   * konsekvenstext) plus vem/när här. Inget byte tillbaka eller till annat företag: ett andra
   * val nekas. Valet påverkas därefter inte av anslutningens eller aktiveringens status.
   */
  async valjFortnoxSomHuvudbok(
    organizationId: string,
    user: { sub: string; role: string },
    input: { activationId: string },
  ) {
    if (user.role !== 'OWNER')
      throw new ForbiddenException('Bara OWNER får välja Fortnox som huvudbok.')
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { ledgerOwner: true },
      })
      if (!org) throw new NotFoundException('Organisationen hittades inte')
      if (org.ledgerOwner !== 'EVENO')
        throw new ConflictException({
          code: 'HUVUDBOK_REDAN_VALD',
          message:
            'Fortnox är redan vald som huvudbok. Valet kan inte ändras eller flyttas till ett annat företag här.',
        })
      const v = await provaAktivering(tx, organizationId, null)
      if (!v.ok) throw new ConflictException(`Fortnox kan inte väljas som huvudbok: ${v.skal}`)
      if (v.binding.activationId !== input.activationId)
        throw new ConflictException(
          'Valet gäller inte organisationens aktiva kundaktivering — läs om sidan och försök igen.',
        )
      const a = await tx.fortnoxCustomerActivation.findUniqueOrThrow({
        where: { id: v.binding.activationId },
        select: { id: true, fortnoxDatabaseNumber: true, fortnoxOrgNumber: true },
      })
      // T1-2: en öppen lokal leverantörsfaktura hade blivit strandad (BP-2 fryser den efter valet).
      // Härlett tillstånd, inte en flagga: en ångrad betalning har paidAt = null och räknas.
      const fakturor = await tx.supplierInvoice.findMany({
        where: { organizationId },
        select: { paidAt: true, cancelledAt: true },
      })
      const oppna = fakturor.filter(leverantorsfakturaArOppen).length
      if (oppna > 0)
        throw new ConflictException({
          code: 'OPPNA_LEVERANTORSFAKTUROR',
          message:
            `Det finns ${oppna} öppna leverantörsfakturor i Eveno. Betala eller makulera dem i Eveno ` +
            'innan Fortnox väljs som huvudbok – efter valet kan de inte hanteras här.',
        })
      const valdAt = new Date()
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          ledgerOwner: 'FORTNOX',
          ledgerOwnerActivationId: a.id,
          ledgerOwnerFortnoxDatabaseNumber: a.fortnoxDatabaseNumber,
          ledgerOwnerFortnoxOrgNumber: a.fortnoxOrgNumber,
          ledgerOwnerSetAt: valdAt,
          ledgerOwnerSetById: user.sub,
        },
      })
      this.logger.log(
        `[huvudbok] org ${organizationId}: Fortnox vald som huvudbok av ${user.sub} ` +
          `(aktivering ${a.id}, databasnummer ${a.fortnoxDatabaseNumber})`,
      )
      return {
        agare: 'FORTNOX' as const,
        valdAt,
        activationId: a.id,
        fortnoxDatabasnummer: a.fortnoxDatabaseNumber,
      }
    }, PAYMENT_TX_LIMITS)
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
