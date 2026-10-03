/**
 * KUNDSTART-001: öppningspaket för historiska fordringar och depositioner.
 *
 * Utkast (CSV) → validering/avstämning → bindning till Fortnox-läsning → godkännande
 * (OWNER, bundet till sha, version, brytdatum, läsning och ekonomiskt vattenmärke) →
 * verkställning i EN serialiserbar transaktion med full omprövning under lås.
 *
 * Effekter av verkställningen (KONTRAKT §2, §11, §12):
 *  - FORDRAN  → RentNotice status OPENING, origin OPENING_PACKAGE, ingen intäkt, ingen
 *               betalning, inget verifikat (fordran är bokförd i Fortnox före brytdatum).
 *  - DEPOSITION → Deposit PAID ("hålls") med paidAt = mottaget datum ur underlaget,
 *               origin OPENING_PACKAGE. Ingen BankTransaction, RentNoticePayment, avi
 *               eller verifikat.
 *  - OpeningExecutedSource per källrad (unik per organisation och sourceId).
 *  - Alla ACTIVE Fortnox-kundaktiveringar blir SUPERSEDED.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { OpeningPackage, OpeningPackageRow } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { brytdatumIso } from './cutover'
import {
  kronorTillOre,
  oreTillKronorStr,
  sha256Hex,
  tolkaOpeningCsv,
  tolkaSpecifikation,
} from './opening-csv'
import { losRader } from './opening-resolve'
import {
  stamAv,
  KONTON,
  type Avstamning,
  type Konto,
  type SeparatSpec,
} from './opening-reconciliation'
import { saldoUrLasning, senasteSaldolasning } from './opening-fortnox-balance'
import { ekonomisktLage, VATTENMARKE_SKAL } from './watermark'
import { ogiltigforklaraAktiveringar } from './activation-invalidation'
import { evenoPosterForeBrytdatum } from './pre-cutover-records'
import { registerHinder, tackningOk, type ForstaPeriodRegister } from './first-period'
import { tolkaForstaPeriodRegister } from './opening-csv'

type Roll = 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER'
const SKRIV_ROLLER: Roll[] = ['OWNER', 'ADMIN']

export class OpeningAbort extends ConflictException {}

const oreAv = (d: Prisma.Decimal | number | string) =>
  kronorTillOre(new Prisma.Decimal(d).toFixed(2))!

const TX = {
  timeout: 60_000,
  maxWait: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
}

@Injectable()
export class OpeningPackageService {
  private readonly logger = new Logger(OpeningPackageService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ocr: OcrService,
  ) {}

  private kravRoll(roll: Roll, tillatna: Roll[], vad: string) {
    if (!tillatna.includes(roll))
      throw new ForbiddenException(`Bara ${tillatna.join(' eller ')} får ${vad}.`)
  }

  private async hamta(organizationId: string, id: string) {
    const p = await this.prisma.openingPackage.findFirst({
      where: { id, organizationId },
      include: { rows: { orderBy: { rowNo: 'asc' } } },
    })
    if (!p) throw new NotFoundException('Öppningspaketet hittades inte')
    return p
  }

  async list(organizationId: string) {
    return this.prisma.openingPackage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { rows: true } } },
    })
  }

  async get(organizationId: string, id: string) {
    return this.vy(await this.hamta(organizationId, id))
  }

  private vy(p: OpeningPackage & { rows: OpeningPackageRow[] }) {
    const fel = p.rows.filter((r) => Array.isArray(r.errors) && (r.errors as unknown[]).length > 0)
    const { fortnoxBalance1510, fortnoxBalance2890, ...resten } = p
    return {
      ...resten,
      // ACK-009: lagras som kronor Decimal(12,2); API:t visar öre som heltal.
      fortnoxBalance1510Ore: fortnoxBalance1510 === null ? null : oreAv(fortnoxBalance1510),
      fortnoxBalance2890Ore: fortnoxBalance2890 === null ? null : oreAv(fortnoxBalance2890),
      cutoverDate: brytdatumIso(p.cutoverDate),
      separateLedgerSpec: this.specUtan(p.separateLedgerSpec),
      rows: p.rows.map((r) => ({
        ...r,
        originalAmount: r.originalAmount.toFixed(2),
        openAmount: r.openAmount.toFixed(2),
        dueDate: r.dueDate ? brytdatumIso(r.dueDate) : null,
        receivedDate: r.receivedDate ? brytdatumIso(r.receivedDate) : null,
      })),
      felrader: fel.length,
    }
  }

  private specUtan(spec: Prisma.JsonValue | null) {
    if (!spec || typeof spec !== 'object') return null
    const ut: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(spec as unknown as Record<string, SeparatSpec>)) {
      // Posterna (identitet per post) står kvar i databasen; vyn visar sammanfattningen.
      ut[k] = {
        sha256: v.sha256,
        antal: v.antal,
        summaOre: v.summaOre,
        beskrivning: v.beskrivning,
        filnamn: v.filnamn,
        system: v.system,
        ansvarig: v.ansvarig,
      }
    }
    return ut
  }

  // ── 1. Utkast ────────────────────────────────────────────────────────────
  async create(
    organizationId: string,
    user: { sub: string; role: Roll },
    input: { sourceName: string; innehall: string; nollOppning?: boolean },
  ) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'ladda upp ett öppningspaket')
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { billingCutoverDate: true, orgNumber: true },
    })
    if (!org?.billingCutoverDate)
      throw new BadRequestException(
        'Sätt organisationens brytdatum innan ett öppningspaket laddas upp.',
      )
    const tolkat = this.tolka(input)
    return this.prisma.openingPackage.create({
      data: {
        organizationId,
        cutoverDate: org.billingCutoverDate,
        sourceName: input.sourceName,
        sourceSha256: tolkat.sha256,
        orgNumber: org.orgNumber,
        zeroOpening: input.nollOppning === true,
        createdById: user.sub,
        rows: { create: tolkat.rows },
      },
      include: { rows: true },
    })
  }

  /** Ny fil för ett ej verkställt paket → ny version, tillbaka till DRAFT, godkännandet upphör. */
  async replaceSource(
    organizationId: string,
    id: string,
    user: { sub: string; role: Roll },
    input: { sourceName: string; innehall: string; nollOppning?: boolean },
  ) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'ersätta öppningspaketets fil')
    const p = await this.hamta(organizationId, id)
    if (p.status === 'EXECUTED' || p.status === 'DISCARDED')
      throw new ConflictException(`Ett ${p.status}-paket kan inte få ny fil.`)
    const tolkat = this.tolka(input)
    return this.prisma.$transaction(async (tx) => {
      await tx.openingPackageRow.deleteMany({ where: { packageId: id } })
      return tx.openingPackage.update({
        where: { id },
        data: {
          version: { increment: 1 },
          status: 'DRAFT',
          sourceName: input.sourceName,
          sourceSha256: tolkat.sha256,
          zeroOpening: input.nollOppning === true,
          validatedAt: null,
          approvedById: null,
          approvedAt: null,
          approvedSha256: null,
          approvedVersion: null,
          approvedWatermark: null,
          approvedCutoverDate: null,
          approvedReadRunId: null,
          totals: Prisma.DbNull,
          reconciliation: Prisma.DbNull,
          reconciliationStatus: null,
          invalidatedReason: 'Ny fil (ny version) — kräver ny validering och nytt godkännande.',
          rows: { create: tolkat.rows },
        },
        include: { rows: true },
      })
    })
  }

  private tolka(input: { innehall: string; nollOppning?: boolean }) {
    const res = tolkaOpeningCsv(input.innehall)
    if (!res.ok) {
      // Nollöppning: en fil med bara rubrikraden är det uttryckliga underlaget.
      if (input.nollOppning && /inga rader/.test(res.error))
        return { sha256: sha256Hex(input.innehall), rows: [] }
      throw new BadRequestException(res.error)
    }
    if (input.nollOppning && res.rows.length > 0)
      throw new BadRequestException('En nollöppning får inte innehålla rader.')
    return {
      sha256: res.sha256,
      rows: res.rows.map((r) => ({
        rowNo: r.rowNo,
        sourceId: r.sourceId || `saknas-rad-${r.rowNo}`,
        kind: r.kind ?? 'RECEIVABLE',
        tenantRef: r.tenantRef,
        leaseRef: r.leaseRef,
        propertyRef: r.propertyRef,
        unitRef: r.unitRef,
        periodYear: r.periodYear,
        periodMonth: r.periodMonth,
        dueDate: r.dueDate,
        receivedDate: r.receivedDate,
        originalAmount: oreTillKronorStr(r.originalOre ?? 0),
        openAmount: oreTillKronorStr(r.openOre ?? 0),
        errors: r.errors.map((e) => `fil: ${e}`),
      })),
    }
  }

  // ── 2. Validering och avstämning ─────────────────────────────────────────
  async validate(organizationId: string, id: string, user: { sub: string; role: Roll }) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'validera ett öppningspaket')
    const p = await this.hamta(organizationId, id)
    if (p.status !== 'DRAFT' && p.status !== 'VALIDATED')
      throw new ConflictException(`Ett ${p.status}-paket valideras inte om.`)
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { billingCutoverDate: true, orgNumber: true },
    })
    if (!org?.billingCutoverDate) throw new BadRequestException('Brytdatum saknas.')
    const cutover = org.billingCutoverDate
    const fore = await evenoPosterForeBrytdatum(this.prisma, organizationId, cutover)
    if (fore) throw new ConflictException(fore)

    if (p.zeroOpening) {
      const tidigare = await this.prisma.openingPackage.count({
        where: { organizationId, status: 'EXECUTED' },
      })
      if (tidigare > 0)
        throw new ConflictException(
          'Organisationen har redan ett verkställt öppningspaket — en nollöppning är inte möjlig.',
        )
    }

    const losning = await losRader(this.prisma, organizationId, cutover, p.rows)
    // OCR tilldelas före godkännandet (verkställningen får inte ändra hyresgäster, K-B5).
    const utanOcr = new Set<string>()
    for (const l of losning) if (l.tenantId && l.errors.length === 0) utanOcr.add(l.tenantId)
    for (const t of await this.prisma.tenant.findMany({
      where: { id: { in: [...utanOcr] }, ocrNumber: null },
      select: { id: true },
    }))
      await this.ocr.assignOcrToTenant(t.id, organizationId)

    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    await this.prisma.$transaction(async (tx) => {
      for (const l of losning)
        await tx.openingPackageRow.update({
          where: { id: l.rowId },
          data: {
            tenantId: l.tenantId,
            leaseId: l.leaseId,
            propertyId: l.propertyId,
            errors: l.errors,
          },
        })
      const felfri = losning.every((l) => l.errors.length === 0)
      await tx.openingPackage.update({
        where: { id },
        data: {
          cutoverDate: cutover,
          orgNumber: org.orgNumber,
          fortnoxDatabaseNumber: conn?.fortnoxDatabaseNumber ?? null,
          fortnoxConnectionId: conn?.id ?? null,
          status: felfri ? 'VALIDATED' : 'DRAFT',
          validatedAt: felfri ? new Date() : null,
          totals: this.totaler(p.rows, losning) as unknown as Prisma.InputJsonValue,
        },
      })
    })
    await this.raknaOmAvstamning(organizationId, id)
    return this.get(organizationId, id)
  }

  private totaler(
    rows: Pick<OpeningPackageRow, 'id' | 'kind' | 'openAmount'>[],
    losning: { rowId: string; tenantId: string | null }[],
  ) {
    const perHyresgast = new Map<
      string,
      { tenantId: string; fordranOre: number; depositionOre: number }
    >()
    let fordranOre = 0
    let depositionOre = 0
    for (const r of rows) {
      const ore = oreAv(r.openAmount)
      const t = losning.find((l) => l.rowId === r.id)?.tenantId ?? 'olöst'
      const cur = perHyresgast.get(t) ?? { tenantId: t, fordranOre: 0, depositionOre: 0 }
      if (r.kind === 'RECEIVABLE') {
        cur.fordranOre += ore
        fordranOre += ore
      } else {
        cur.depositionOre += ore
        depositionOre += ore
      }
      perHyresgast.set(t, cur)
    }
    return {
      fordranOre,
      depositionOre,
      rader: rows.length,
      perHyresgast: [...perHyresgast.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    }
  }

  /** Paketsumma för avstämningen: alla EXECUTED-paket + detta (om ej verkställt). §12.3 */
  private async paketsumma(db: Prisma.TransactionClient, organizationId: string, id: string) {
    const rader = await db.openingPackageRow.findMany({
      where: {
        package: {
          organizationId,
          OR: [{ status: 'EXECUTED' }, { id, status: { notIn: ['EXECUTED', 'DISCARDED'] } }],
        },
      },
      select: { kind: true, openAmount: true },
    })
    const s: Record<Konto, number> = { '1510': 0, '2890': 0 }
    for (const r of rader) s[r.kind === 'RECEIVABLE' ? '1510' : '2890'] += oreAv(r.openAmount)
    return s
  }

  private async raknaOmAvstamning(
    organizationId: string,
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Avstamning> {
    const p = await db.openingPackage.findFirstOrThrow({ where: { id, organizationId } })
    const paketOre = await this.paketsumma(db, organizationId, id)
    const spec = (p.separateLedgerSpec ?? {}) as Partial<Record<Konto, SeparatSpec>>
    const av = stamAv({
      cutover: p.cutoverDate,
      paketOre,
      fortnoxOre: {
        '1510': p.fortnoxBalance1510 === null ? null : oreAv(p.fortnoxBalance1510),
        '2890': p.fortnoxBalance2890 === null ? null : oreAv(p.fortnoxBalance2890),
      },
      spec,
    })
    await db.openingPackage.update({
      where: { id },
      data: {
        reconciliation: av as unknown as Prisma.InputJsonValue,
        reconciliationStatus: av.status,
      },
    })
    return av
  }

  // ── Fortnox-saldo per brytdatum ur läsning (§12.6) ───────────────────────
  async bindFortnoxRead(
    organizationId: string,
    id: string,
    user: { sub: string; role: Roll },
    readRunId: string,
  ) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'binda en Fortnox-läsning')
    const p = await this.hamta(organizationId, id)
    if (p.status === 'DISCARDED') throw new ConflictException('Paketet är kasserat.')
    const run = await this.prisma.fortnoxReadRun.findFirst({
      where: { id: readRunId, organizationId },
    })
    if (!run) throw new NotFoundException('Läsningen hittades inte')
    const senaste = await senasteSaldolasning(this.prisma, organizationId)
    if (senaste?.id !== run.id)
      throw new ConflictException('Det finns en nyare läsning av 1510/2890 — bind den senaste.')
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    const s = saldoUrLasning(run, conn, p.cutoverDate)
    if (!s.ok) throw new BadRequestException(s.skal)
    await this.prisma.openingPackage.update({
      where: { id },
      data: {
        fortnoxReadRunId: run.id,
        fortnoxBalance1510: oreTillKronorStr(s.saldo.saldo1510Ore),
        fortnoxBalance2890: oreTillKronorStr(s.saldo.saldo2890Ore),
        ...(p.status === 'APPROVED'
          ? {
              status: 'VALIDATED',
              approvedAt: null,
              approvedById: null,
              approvedSha256: null,
              approvedVersion: null,
              approvedWatermark: null,
              approvedCutoverDate: null,
              approvedReadRunId: null,
              invalidatedReason: 'Ny Fortnox-läsning bunden — kräver nytt godkännande.',
            }
          : {}),
      },
    })
    await this.raknaOmAvstamning(organizationId, id)
    return this.get(organizationId, id)
  }

  // ── Separat reskontra (AVGRÄNSAD, §11) ───────────────────────────────────
  async setSeparateLedger(
    organizationId: string,
    id: string,
    user: { sub: string; role: Roll },
    input: {
      konto: Konto
      beskrivning: string
      filnamn: string
      innehall: string | null
      system?: string
      ansvarig?: string
    },
  ) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'ange separat reskontra')
    if (!KONTON.includes(input.konto))
      throw new BadRequestException('Konto måste vara 1510 eller 2890.')
    const p = await this.hamta(organizationId, id)
    if (p.status === 'DISCARDED') throw new ConflictException('Paketet är kasserat.')
    if (p.zeroOpening)
      throw new ConflictException(
        'En nollöppning kan inte ha separat reskontra — ett avgränsat urval är inte ett nollsaldo.',
      )
    const spec = { ...((p.separateLedgerSpec ?? {}) as unknown as Record<string, SeparatSpec>) }
    if (input.innehall === null) delete spec[input.konto]
    else {
      if (input.beskrivning.trim().length < 20)
        throw new BadRequestException(
          'Beskriv den separata reskontran (minst 20 tecken): vad den är och var den förs.',
        )
      // S5-1: den separata reskontran ska vara namngiven — system och ansvarig.
      const system = (input.system ?? '').trim()
      const ansvarig = (input.ansvarig ?? '').trim()
      if (system.length < 2 || ansvarig.length < 2)
        throw new BadRequestException(
          'Ange den separata reskontrans system och ansvarig — en namnlös reskontra kan inte avgränsa.',
        )
      const t = tolkaSpecifikation(input.innehall)
      if (!t.ok) throw new BadRequestException(t.error)
      spec[input.konto] = {
        ...t.spec,
        beskrivning: input.beskrivning.trim(),
        filnamn: input.filnamn,
        system,
        ansvarig,
      }
    }
    await this.prisma.openingPackage.update({
      where: { id },
      data: { separateLedgerSpec: spec as unknown as Prisma.InputJsonValue },
    })
    await this.raknaOmAvstamning(organizationId, id)
    return this.get(organizationId, id)
  }

  // ── Första perioden: register ur tidigare system (KUNDSTART-009) ──────────
  async setFirstPeriodRegister(
    organizationId: string,
    id: string,
    user: { sub: string; role: Roll },
    input: {
      filnamn: string
      innehall: string
      system: string
      ansvarig: string
      tackningFran: string
      tackningTill: string
      intaktskonton: number[]
      forskottskonton: number[]
    },
  ) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'ladda upp registret för första perioden')
    const p = await this.hamta(organizationId, id)
    if (p.status === 'EXECUTED' || p.status === 'DISCARDED')
      throw new ConflictException(`Ett ${p.status}-paket får inget nytt register.`)
    if (input.system.trim().length < 2 || input.ansvarig.trim().length < 2)
      throw new BadRequestException('Ange registrets system och ansvarig.')
    if (input.intaktskonton.length === 0)
      throw new BadRequestException('Ange minst ett intäktskonto för hyra i tidigare system.')
    const tack = tackningOk(input.tackningFran, input.tackningTill, p.cutoverDate)
    if (tack) throw new BadRequestException(tack)
    const t = tolkaForstaPeriodRegister(input.innehall)
    if (!t.ok) throw new BadRequestException(t.error)
    const b = brytdatumIso(p.cutoverDate)
    for (const post of t.poster) {
      const period = `${post.periodAr}-${String(post.periodManad).padStart(2, '0')}-01`
      if (period < b || period > input.tackningTill)
        throw new BadRequestException(
          `Rad ${post.radId}: perioden ${period.slice(0, 7)} ligger utanför täckningen ${b}–${input.tackningTill}.`,
        )
    }
    const register: ForstaPeriodRegister = {
      sha256: t.sha256,
      filnamn: input.filnamn,
      system: input.system.trim(),
      ansvarig: input.ansvarig.trim(),
      tackningFran: input.tackningFran,
      tackningTill: input.tackningTill,
      intaktskonton: [...new Set(input.intaktskonton)].sort((x, y) => x - y),
      forskottskonton: [...new Set(input.forskottskonton)].sort((x, y) => x - y),
      antal: t.poster.length,
      poster: t.poster.slice(0, 500),
      registreradAv: user.sub,
      registreradTid: new Date().toISOString(),
    }
    await this.prisma.openingPackage.update({
      where: { id },
      data: {
        firstPeriodRegister: register as unknown as Prisma.InputJsonValue,
        // Ett nytt register upphäver ett tidigare godkännande.
        ...(p.status === 'APPROVED'
          ? {
              status: 'VALIDATED' as const,
              approvedAt: null,
              approvedById: null,
              approvedSha256: null,
              approvedVersion: null,
              approvedWatermark: null,
              approvedCutoverDate: null,
              approvedReadRunId: null,
              invalidatedReason: 'Nytt register för första perioden — kräver nytt godkännande.',
            }
          : {}),
      },
    })
    return this.get(organizationId, id)
  }

  // ── 3. Godkännande (OWNER) ───────────────────────────────────────────────
  async approve(
    organizationId: string,
    id: string,
    user: { sub: string; role: Roll },
    input: { version: number; sourceSha256: string },
  ) {
    this.kravRoll(user.role, ['OWNER'], 'godkänna ett öppningspaket')
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "OpeningPackage" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
      const p = await tx.openingPackage.findFirst({
        where: { id, organizationId },
        include: { rows: true },
      })
      if (!p) throw new NotFoundException('Öppningspaketet hittades inte')
      if (p.status !== 'VALIDATED')
        throw new ConflictException(`Bara ett VALIDATED paket kan godkännas (status ${p.status}).`)
      if (p.version !== input.version || p.sourceSha256 !== input.sourceSha256)
        throw new ConflictException(
          'Paketet har ändrats sedan du granskade det (version eller fil). Granska igen.',
        )
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { billingCutoverDate: true, orgNumber: true },
      })
      if (!org.billingCutoverDate || org.billingCutoverDate.getTime() !== p.cutoverDate.getTime())
        throw new ConflictException('Brytdatumet har ändrats sedan valideringen — validera igen.')
      if (org.orgNumber !== p.orgNumber)
        throw new ConflictException(
          'Organisationsnumret har ändrats sedan valideringen — validera igen.',
        )
      if (!p.fortnoxReadRunId)
        throw new ConflictException(
          'Bind en Fortnox-läsning (saldo per brytdatum) innan godkännandet.',
        )
      // KUNDSTART-009: utan kontrollerat register för första perioden (eller med poster i
      // det) kan övertagandet inte godkännas.
      const forsta = registerHinder(p.firstPeriodRegister, p.cutoverDate)
      if (forsta) throw new ConflictException(forsta)
      if (
        p.zeroOpening &&
        (await tx.openingPackage.count({ where: { organizationId, status: 'EXECUTED' } })) > 0
      )
        throw new ConflictException(
          'Organisationen har redan ett verkställt öppningspaket — ingen nollöppning.',
        )
      await this.kravAktuellLasning(tx, organizationId, p.fortnoxReadRunId, p.cutoverDate)
      const av = await this.raknaOmAvstamning(organizationId, id, tx)
      if (p.zeroOpening && !(av.status === 'AVSTAMD' && av.konton.every((k) => k.fortnoxOre === 0)))
        throw new ConflictException(
          'Nollöppning kräver att Fortnox-saldot för både 1510 och 2890 är 0 per brytdatum (AVSTÄMD 0 = 0).',
        )
      const wm = await ekonomisktLage(tx, organizationId, this.ref(p.rows))
      return tx.openingPackage.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: user.sub,
          approvedAt: new Date(),
          approvedSha256: p.sourceSha256,
          approvedVersion: p.version,
          approvedCutoverDate: p.cutoverDate,
          approvedReadRunId: p.fortnoxReadRunId,
          approvedWatermark: wm.sha256,
          invalidatedReason: null,
        },
      })
    }, TX)
  }

  private ref(rows: Pick<OpeningPackageRow, 'leaseId' | 'tenantId'>[]) {
    return {
      leaseIds: rows.map((r) => r.leaseId).filter((x): x is string => !!x),
      tenantIds: rows.map((r) => r.tenantId).filter((x): x is string => !!x),
    }
  }

  private async kravAktuellLasning(
    db: Prisma.TransactionClient,
    organizationId: string,
    readRunId: string,
    cutover: Date,
  ) {
    const senaste = await senasteSaldolasning(db, organizationId)
    if (senaste?.id !== readRunId)
      throw new OpeningAbort(
        'En nyare Fortnox-läsning finns — bind den och pröva avstämningen igen.',
      )
    const conn = await db.fortnoxConnection.findUnique({ where: { organizationId } })
    const s = saldoUrLasning(senaste, conn, cutover)
    if (!s.ok) throw new OpeningAbort(s.skal)
    return s.saldo
  }

  // ── 4. Verkställning ─────────────────────────────────────────────────────
  async execute(organizationId: string, id: string, user: { sub: string; role: Roll }) {
    this.kravRoll(user.role, ['OWNER'], 'verkställa ett öppningspaket')
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "OpeningPackage" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
        const p = await tx.openingPackage.findFirst({
          where: { id, organizationId },
          include: { rows: { orderBy: { rowNo: 'asc' } } },
        })
        if (!p) throw new NotFoundException('Öppningspaketet hittades inte')
        if (p.status === 'EXECUTED')
          return { status: 'EXECUTED' as const, redanVerkstallt: true, id }
        if (p.status !== 'APPROVED')
          throw new ConflictException(
            `Bara ett APPROVED paket kan verkställas (status ${p.status}).`,
          )
        if (p.approvedVersion !== p.version || p.approvedSha256 !== p.sourceSha256)
          throw new OpeningAbort('Godkännandet gäller en annan version eller fil.')
        const org = await tx.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: { billingCutoverDate: true, orgNumber: true },
        })
        if (
          !org.billingCutoverDate ||
          !p.approvedCutoverDate ||
          org.billingCutoverDate.getTime() !== p.approvedCutoverDate.getTime() ||
          p.cutoverDate.getTime() !== p.approvedCutoverDate.getTime()
        )
          throw new OpeningAbort('Brytdatumet har ändrats sedan godkännandet.')
        if (org.orgNumber !== p.orgNumber)
          throw new OpeningAbort('Organisationsnumret har ändrats.')
        if (!p.approvedReadRunId || p.approvedReadRunId !== p.fortnoxReadRunId)
          throw new OpeningAbort('Den bundna Fortnox-läsningen har ändrats sedan godkännandet.')
        await this.kravAktuellLasning(tx, organizationId, p.approvedReadRunId, p.cutoverDate)
        const wm = await ekonomisktLage(tx, organizationId, this.ref(p.rows))
        if (wm.sha256 !== p.approvedWatermark) throw new OpeningAbort(VATTENMARKE_SKAL)

        const fore = await evenoPosterForeBrytdatum(tx, organizationId, p.cutoverDate)
        if (fore) throw new OpeningAbort(fore)
        const losning = await losRader(tx, organizationId, p.cutoverDate, p.rows)
        const fel = losning.flatMap((l) => {
          const r = p.rows.find((x) => x.id === l.rowId)!
          return l.errors.map((e) => `rad ${r.rowNo} (${r.sourceId}): ${e}`)
        })
        for (const l of losning) {
          const r = p.rows.find((x) => x.id === l.rowId)!
          if (l.leaseId !== r.leaseId || l.tenantId !== r.tenantId)
            fel.push(`rad ${r.rowNo} (${r.sourceId}): kopplingen har ändrats sedan valideringen.`)
        }
        if (fel.length > 0)
          throw new OpeningAbort(`Omprövningen hittade fel: ${fel.slice(0, 20).join(' | ')}`)

        const tenants = new Map(
          (
            await tx.tenant.findMany({
              where: { id: { in: losning.map((l) => l.tenantId!).filter(Boolean) } },
              select: { id: true, ocrNumber: true },
            })
          ).map((t) => [t.id, t.ocrNumber]),
        )
        const kort = p.id.slice(0, 8)
        let fordringar = 0
        let depositioner = 0
        for (const r of p.rows) {
          const ocr = tenants.get(r.tenantId!)
          if (!ocr)
            throw new OpeningAbort(`rad ${r.rowNo}: hyresgästen saknar OCR — validera igen.`)
          if (r.kind === 'RECEIVABLE') {
            const y = r.periodYear!
            const m = r.periodMonth!
            await tx.rentNotice.create({
              data: {
                organizationId,
                tenantId: r.tenantId!,
                leaseId: r.leaseId!,
                noticeNumber: `IB-${kort}-${r.rowNo}`,
                ocrNumber: ocr,
                year: y,
                month: m,
                amount: r.openAmount,
                vatAmount: 0,
                totalAmount: r.openAmount,
                dueDate: r.dueDate!,
                status: 'OPENING',
                type: 'RENT',
                periodStart: new Date(Date.UTC(y, m - 1, 1)),
                periodEnd: new Date(Date.UTC(y, m, 0)),
                origin: 'OPENING_PACKAGE',
                openingRowId: r.id,
              },
            })
            fordringar++
          } else {
            await tx.deposit.create({
              data: {
                organizationId,
                leaseId: r.leaseId!,
                tenantId: r.tenantId!,
                amount: r.openAmount,
                status: 'PAID',
                paidAt: r.receivedDate!,
                origin: 'OPENING_PACKAGE',
                openingRowId: r.id,
                notes:
                  `Historisk deposition ur öppningspaket ${kort} (källrad ${r.sourceId}), mottagen ` +
                  `${brytdatumIso(r.receivedDate!)} enligt underlag; ursprungligt belopp ` +
                  `${r.originalAmount.toFixed(2)} kr. Skulden (2890) finns i Fortnox före brytdatum.`,
              },
            })
            depositioner++
          }
          await tx.openingExecutedSource.create({
            data: { organizationId, sourceId: r.sourceId, packageId: p.id, rowId: r.id },
          })
        }
        await tx.openingPackage.update({
          where: { id },
          data: { status: 'EXECUTED', executedById: user.sub, executedAt: new Date() },
        })
        await this.raknaOmAvstamning(organizationId, id, tx)
        const ogiltiga = await ogiltigforklaraAktiveringar(
          tx,
          organizationId,
          `Nytt verkställt öppningspaket ${kort} — kundaktiveringen måste prövas om.`,
        )
        return {
          status: 'EXECUTED' as const,
          id,
          fordringar,
          depositioner,
          ogiltigaAktiveringar: ogiltiga,
        }
      }, TX)
    } catch (e) {
      const serialisering =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2034' || e.code === 'P2002')
      if (e instanceof OpeningAbort || serialisering) {
        const skal =
          e instanceof OpeningAbort
            ? String((e.getResponse() as { message?: string }).message ?? e.message)
            : 'En samtidig ändring krockade med verkställningen (serialisering/unikhet). Inget verkställdes.'
        await this.prisma.openingPackage.updateMany({
          where: { id, organizationId, status: 'APPROVED' },
          data: {
            status: 'DRAFT',
            approvedAt: null,
            approvedById: null,
            approvedSha256: null,
            approvedVersion: null,
            approvedWatermark: null,
            approvedCutoverDate: null,
            approvedReadRunId: null,
            validatedAt: null,
            invalidatedReason: skal.slice(0, 2000),
          },
        })
        this.logger.warn(`[Kundstart] verkställning av ${id} avbröts: ${skal}`)
        throw new ConflictException(`Verkställningen avbröts utan effekt: ${skal}`)
      }
      throw e
    }
  }

  async discard(organizationId: string, id: string, user: { sub: string; role: Roll }) {
    this.kravRoll(user.role, SKRIV_ROLLER, 'kassera ett öppningspaket')
    const r = await this.prisma.openingPackage.updateMany({
      where: { id, organizationId, status: { in: ['DRAFT', 'VALIDATED', 'APPROVED'] } },
      data: { status: 'DISCARDED', discardedAt: new Date() },
    })
    if (r.count === 0) throw new ConflictException('Bara ett ej verkställt paket kan kasseras.')
    return this.get(organizationId, id)
  }
}
