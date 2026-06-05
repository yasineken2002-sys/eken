import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { CompanyForm, PaymentMethod, RentNoticeType, UnitType } from '@prisma/client'
import type {
  BankTransaction,
  ConsumptionVatStatus,
  Invoice,
  InvoiceLine,
  JournalEntrySource,
  MeterType,
  Prisma,
} from '@prisma/client'
import type { Decimal } from '@prisma/client/runtime/library'
import type {
  BalanceSheet,
  ProfitLossReport,
  ReportAccountAmount,
  ReportAccountBalance,
  VatReport,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { basChartFor } from './bas-chart'

// Konteringsrad i internt format innan den mappas till Prisma create-input.
interface JournalLineInput {
  accountId: string
  debit?: number
  credit?: number
  description?: string
}

interface JournalFilters {
  from?: string
  to?: string
  source?: string
}

// Map VAT rate to account number. 0% (momsbefriad) ska INTE bokföras som
// momskredit alls — då hoppas raden över i createJournalEntryForInvoice.
const VAT_TO_ACCOUNT: Record<number, number> = {
  25: 2611,
  12: 2621,
  6: 2631,
}

// BAS 2024-konto för hyresintäkt per upplåtelsetyp. Avgör vilket 39xx-konto
// en hyresfaktura/-avi krediteras mot. Bostäder (3911) är undantagna moms
// (ML 3 kap 2 §); lokaler (3913) kan vara momspliktiga vid frivillig
// skattskyldighet (ML 9 kap). Saknas koppling till en Unit används 3914
// (övriga rörelseintäkter) som säker fallback.
const REVENUE_ACCOUNT_BY_UNIT_TYPE: Record<UnitType, number> = {
  APARTMENT: 3911,
  PARKING: 3912,
  OFFICE: 3913,
  RETAIL: 3913,
  STORAGE: 3914,
  OTHER: 3914,
}
const DEFAULT_REVENUE_ACCOUNT = 3914

export function revenueAccountForUnitType(type: UnitType | null | undefined): number {
  return type ? REVENUE_ACCOUNT_BY_UNIT_TYPE[type] : DEFAULT_REVENUE_ACCOUNT
}

// BAS-intäktskonto för förbrukningsersättning (IMD) per mätartyp. Bruttoredovisat
// och skilt från hyresintäkten (39xx ovan): el/värme → 3920, vatten → 3970.
// Kostnaden (5020/5040) bokförs ALDRIG här — den hör till leverantörsfaktura-
// flödet. Vi nettar aldrig kostnad mot intäkt.
const CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE: Record<MeterType, number> = {
  ELECTRICITY: 3920,
  HEATING: 3920,
  WATER_COLD: 3970,
  WATER_HOT: 3970,
}

// Svensk etikett per mätartyp för verifikatets beskrivning/radtext.
const METER_TYPE_LABEL: Record<MeterType, string> = {
  ELECTRICITY: 'el',
  HEATING: 'värme',
  WATER_COLD: 'kallvatten',
  WATER_HOT: 'varmvatten',
}

// BAS-likvidkonto som debiteras vid manuell betalningsregistrering, per
// betalningssätt. Kontona seedas av basChartFor och backfillas för
// befintliga organisationer via migration (PR 6) — saknas kontot loggas ett
// fel och betalningsverifikatet skapas inte (hellre än att boka mot fel konto).
const PAYMENT_METHOD_TO_ACCOUNT: Record<PaymentMethod, number> = {
  BANK: 1930,
  CASH: 1910,
  // Swish-medel landar inom sekunder på företagskontot (1930) — det är inte ett
  // separatredovisat bankkonto. Vi bokför därför mot 1930 (undviker ett
  // "fantasikonto" som aldrig kan stämmas av mot ett kontoutdrag). Att det var
  // Swish framgår av paymentMethod på avin + verifikatets radtext.
  SWISH: 1930,
  MANUAL: 1930,
}

// Radtext på debetraden i betalningsverifikatet, per betalningssätt.
const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  BANK: 'Inbetalning bank',
  CASH: 'Inbetalning kontant',
  SWISH: 'Inbetalning Swish',
  MANUAL: 'Inbetalning (manuell registrering)',
}

// Tillämplig momssats (%) för hyresintäkt per upplåtelsetyp (ML 1994:200):
//   • Bostad (APARTMENT)         → 0 %. Undantagen moms (ML 3 kap 2 §). Frivillig
//     skattskyldighet får ALDRIG avse stadigvarande bostad (3 kap 3 § 2 st) —
//     därför alltid 0 % oavsett voluntaryTaxLiability.
//   • Lokal (OFFICE/RETAIL)      → 0 % som huvudregel; 25 % endast vid frivillig
//     skattskyldighet (ML 9 kap, 3 kap 3 § 2 st).
//   • Parkering (PARKING)        → 25 %. Momspliktig enligt lag (ML 3 kap 3 § 5),
//     oberoende av frivillig skattskyldighet. Gäller fristående p-plats; ingår
//     platsen i en bostadsupplåtelse hör den till APARTMENT-enheten.
//   • Förråd/övrigt (STORAGE/OTHER) → 0 % som huvudregel; 25 % vid frivillig
//     skattskyldighet (konservativ tolkning — fristående förvaringsbox kan vara
//     momspliktig enligt 3 kap 3 § 6, men kräver då explicit skattskyldighet).
export function vatRateForRent(
  type: UnitType | null | undefined,
  voluntaryTaxLiability: boolean,
): number {
  switch (type) {
    case 'APARTMENT':
      return 0
    case 'PARKING':
      return 25
    case 'OFFICE':
    case 'RETAIL':
    case 'STORAGE':
    case 'OTHER':
      return voluntaryTaxLiability ? 25 : 0
    default:
      return 0
  }
}

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifikationsnummer: VerifikationsnummerService,
  ) {}

  /**
   * Skapar en JournalEntry med ett gap-free, race-säkert verifikationsnummer.
   *
   * Allt sker i EN transaktion: idempotenskontrollen körs om inuti transaktionen
   * (TOCTOU-säkert tillsammans med det unika indexet på (org, source, sourceId)),
   * verifikationsnumret allokeras atomiskt, och posten skapas. Misslyckas något
   * rullas hela transaktionen — inklusive sekvensökningen — tillbaka, så serien
   * förblir obruten (BFL 5 kap 6 §).
   */
  private async createNumberedEntry(params: {
    organizationId: string
    date: Date
    description: string
    source: JournalEntrySource
    sourceId: string | null
    createdById?: string | null
    lines: JournalLineInput[]
    idempotencyWhere: Prisma.JournalEntryWhereInput
    include?: Prisma.JournalEntryInclude
    // Valfri yttre transaktion. Anges när verifikatet måste skapas ATOMISKT
    // tillsammans med andra DB-writes (t.ex. unmatch-flödet som måste rulla
    // tillbaka statusändringar om bokföringen fallerar — BFL 5 kap 5 §/9 §).
    // Utan tx öppnar metoden en egen transaktion som tidigare.
    tx?: Prisma.TransactionClient
  }) {
    const run = async (tx: Prisma.TransactionClient) => {
      // Idempotenskontrollen körs inuti transaktionen och matchar samma
      // (org, source, sourceId) som det unika DB-indexet — så app-kontroll och
      // DB-constraint är i synk (TOCTOU-säkert).
      const existing = await tx.journalEntry.findFirst({
        where: { ...params.idempotencyWhere, source: params.source },
        ...(params.include ? { include: params.include } : {}),
      })
      if (existing) return existing

      const { series, verNumber, fiscalYear } = await this.verifikationsnummer.allocate(
        tx,
        params.organizationId,
        params.date,
      )

      return tx.journalEntry.create({
        data: {
          organizationId: params.organizationId,
          date: params.date,
          description: params.description,
          source: params.source,
          series,
          verNumber,
          fiscalYear,
          ...(params.sourceId != null ? { sourceId: params.sourceId } : {}),
          ...(params.createdById != null ? { createdById: params.createdById } : {}),
          lines: {
            create: params.lines.map((l) => ({
              accountId: l.accountId,
              ...(l.debit != null ? { debit: l.debit } : {}),
              ...(l.credit != null ? { credit: l.credit } : {}),
              ...(l.description ? { description: l.description } : {}),
            })),
          },
        },
        ...(params.include ? { include: params.include } : {}),
      })
    }
    return params.tx ? run(params.tx) : this.prisma.$transaction(run)
  }

  /**
   * Bokför en påminnelseavgift: 1510 D / 3593 K. DELAD kärna för BÅDE
   * faktura-flödet (PaymentReminderService) och hyresavi-flödet (RentReminder-
   * Service, inkasso PR 2) — ingen bokföringslogik byggs på annat håll.
   *
   * Momsfri: avgiften är en lagstadgad påföljd (lag 1981:739), inte omsättning
   * — den får ALDRIG moms, oavsett om underliggande hyra var bostad (0 %) eller
   * lokal (25 %). 3593 är ett momsfritt intäktskonto; inget 26xx-momskonto rörs.
   *
   * Idempotent + gap-free via createNumberedEntry (unikt index (org, source,
   * sourceId)). En `tx` kan skickas in så att källans avgiftsmarkering och detta
   * verifikat skapas ATOMISKT (INV-A: ingen avgift utan verifikat — faller
   * verifikatet rullas hela transaktionen, inkl. markeringen, tillbaka).
   *
   * Returnerar verifikatet, eller null om avgiften ≤ 0 eller om 1510/3593 saknas
   * i kontoplanen (loggas) — anroparen avgör då om eskaleringen ska avbrytas.
   */
  async bookReminderFee(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    fee: number
    description: string
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, fee, description } = params
    if (!Number.isFinite(fee) || fee <= 0) return null

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1510, 3593] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const reminderRevenueId = byNumber.get(3593)
    if (!receivableId || !reminderRevenueId) {
      this.logger.warn(
        `Saknar konto 1510 eller 3593 för organisation ${organizationId} — ` +
          `påminnelseavgift (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: receivableId, debit: fee, description: 'Påminnelseavgift fordran' },
        { accountId: reminderRevenueId, credit: fee, description: 'Påminnelseintäkt (momsfri)' },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  /**
   * Bokför dröjsmålsränta: 1510 D / 8131 K. Speglar bookReminderFee men
   * krediterar 8131 (Dröjsmålsränta, kundfordringar) — en FINANSIELL intäkt.
   * Räntan får ALDRIG hamna på 3593 (påminnelseavgift, rörelseintäkt); det är
   * två olika resultatposter (bokföringsexpertens uttryckliga poäng).
   *
   * Momsfri (dröjsmålsränta är inte omsättning, ML). Idempotent + gap-free via
   * createNumberedEntry (unikt index (org, source, sourceId)). En `tx` kan
   * skickas in så att räntemarkeringen på avin och verifikatet skapas ATOMISKT
   * (INV-A). `date` daterar verifikatet till kristalliseringspunkten.
   *
   * Returnerar verifikatet, eller null om beloppet ≤ 0 eller om 1510/8131 saknas
   * i kontoplanen (loggas) — anroparen avgör då om kristalliseringen ska avbrytas.
   */
  async bookInterest(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    amount: number
    description: string
    date?: Date
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, amount, description } = params
    if (!Number.isFinite(amount) || amount <= 0) return null

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1510, 8131] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const interestIncomeId = byNumber.get(8131)
    if (!receivableId || !interestIncomeId) {
      this.logger.warn(
        `Saknar konto 1510 eller 8131 för organisation ${organizationId} — ` +
          `dröjsmålsränta (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: params.date ?? new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: receivableId, debit: amount, description: 'Dröjsmålsränta fordran' },
        { accountId: interestIncomeId, credit: amount, description: 'Dröjsmålsränteintäkt' },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  async getAccounts(organizationId: string) {
    return this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
  }

  async getJournalEntries(organizationId: string, filters?: JournalFilters) {
    return this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        ...(filters?.from || filters?.to
          ? {
              date: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters?.source
          ? { source: filters.source as 'MANUAL' | 'INVOICE' | 'PAYMENT' | 'LEASE' }
          : {}),
      },
      include: {
        lines: {
          include: { account: true },
        },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
  }

  async getJournalEntry(id: string, organizationId: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, organizationId },
      include: {
        lines: {
          include: { account: true },
        },
      },
    })
    if (!entry) throw new NotFoundException('Verifikation hittades inte')
    return entry
  }

  /**
   * Seeda BAS-kontoplan för en organisation. Hoppar över om kontona
   * redan är seedade — idempotent och säker att kalla flera gånger.
   *
   * Eget kapital-serien väljs baserat på companyForm:
   *   • AB             → 2080-serien (aktiekapital, reservfond, fritt kapital)
   *   • ENSKILD_FIRMA  → 2010-serien (eget kapital, egna uttag/insättningar)
   *   • HB / KB        → 2010-serien per delägare
   *   • FORENING       → 2065-serien
   *   • STIFTELSE      → 2070-serien
   *
   * Anropas både från AuthService.register() (vid org-skapande) och
   * från POST /v1/accounting/accounts/seed (manuell trigger för
   * importerade orgs som saknar kontoplan).
   */
  async seedDefaultAccounts(organizationId: string, companyForm?: CompanyForm): Promise<void> {
    const existing = await this.prisma.account.count({ where: { organizationId } })
    if (existing > 0) return

    let form: CompanyForm
    if (companyForm) {
      form = companyForm
    } else {
      // Fallback: läs upp från Organization-raden om anroparen inte
      // skickat med formen explicit. Default till AB om kolumnen är null.
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { companyForm: true },
      })
      form = org?.companyForm ?? CompanyForm.AB
    }

    const accounts = basChartFor(form)
    await this.prisma.account.createMany({
      data: accounts.map((a) => ({ ...a, organizationId })),
    })
  }

  async exportSie4(organizationId: string, from: string, to: string): Promise<Buffer> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, orgNumber: true },
    })

    // Dedikerad hämtning för export: ALLA verifikationer i perioden, kronologiskt
    // ordnade efter verifikationsnummer. (getJournalEntries har take:100 för UI —
    // får aldrig användas för SIE, då blir räkenskapsinformationen ofullständig.)
    const entries = await this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        date: { gte: new Date(from), lte: new Date(to) },
      },
      include: { lines: { include: { account: true } } },
      orderBy: [{ date: 'asc' }, { series: 'asc' }, { verNumber: 'asc' }],
    })

    const fromCompact = from.replace(/-/g, '')
    const toCompact = to.replace(/-/g, '')

    // SIE4-format enligt SIE Gruppen specifikation 4B.
    // Källa: https://sie.se/wp-content/uploads/2020/05/SIE_filformat_ver_4B_080930.pdf
    const generatedAt = new Date()
    const genDate =
      generatedAt.getFullYear().toString() +
      String(generatedAt.getMonth() + 1).padStart(2, '0') +
      String(generatedAt.getDate()).padStart(2, '0')
    const lines: string[] = [
      '#FLAGGA 0',
      '#PROGRAM "Eveno" "1.0"',
      '#FORMAT PC8',
      `#GEN ${genDate}`,
      '#SIETYP 4',
      `#ORGNR ${org?.orgNumber ?? organizationId}`,
      `#FNAMN "${(org?.name ?? 'Okänd organisation').replace(/"/g, '')}"`,
      `#RAR 0 ${fromCompact} ${toCompact}`,
      '',
    ]

    // Kontoplan – krävs för att bokslutsprogram ska kunna mappa.
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
    for (const acc of accounts) {
      lines.push(`#KONTO ${acc.number} "${acc.name.replace(/"/g, '')}"`)
    }
    lines.push('')

    // Verifikationsnummer (serie + nummer) skrivs ut deterministiskt så att
    // samma verifikation identifieras lika i varje export (BFL 5 kap 6 §).
    for (const entry of entries) {
      const dateStr = entry.date.toISOString().slice(0, 10).replace(/-/g, '')
      const serie = entry.series.replace(/"/g, '')
      lines.push(
        `#VER "${serie}" ${entry.verNumber} ${dateStr} "${entry.description.replace(/"/g, '')}"`,
      )
      lines.push('{')
      for (const l of entry.lines) {
        const amount = l.debit != null ? Number(l.debit) : -Number(l.credit ?? 0)
        lines.push(`  #TRANS ${l.account.number} {} ${amount.toFixed(2)}`)
      }
      lines.push('}')
      lines.push('')
    }

    return Buffer.from(lines.join('\n'), 'utf8')
  }

  // ── Finansiella rapporter ───────────────────────────────────────────────
  // EN sanningskälla för beräkningen. Både REST-endpoints (AccountingController)
  // och AI-verktygen (tool-executor) anropar dessa metoder — ingen divergens.

  // Momsrapport: utgående moms (kredit på 2611/2621/2631 = försäljning ökar
  // skuld) minus ingående moms (debet på 2641 = köp ökar fordran på SKV).
  async getVatReport(organizationId: string, from: string, to: string): Promise<VatReport> {
    const accounts = await this.prisma.account.findMany({
      where: { organizationId, number: { in: [2611, 2621, 2631, 2641] } },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a]))

    const sumFor = async (num: number) => {
      const acc = accountByNumber.get(num)
      if (!acc) return { debit: 0, credit: 0 }
      const agg = await this.prisma.journalEntryLine.aggregate({
        where: {
          accountId: acc.id,
          journalEntry: {
            organizationId,
            date: { gte: new Date(from), lte: new Date(to) },
          },
        },
        _sum: { debit: true, credit: true },
      })
      return {
        debit: Number(agg._sum.debit ?? 0),
        credit: Number(agg._sum.credit ?? 0),
      }
    }

    const [v25, v12, v6, vIn] = await Promise.all([
      sumFor(2611),
      sumFor(2621),
      sumFor(2631),
      sumFor(2641),
    ])
    const outVat25 = v25.credit - v25.debit
    const outVat12 = v12.credit - v12.debit
    const outVat6 = v6.credit - v6.debit
    const outTotal = outVat25 + outVat12 + outVat6
    const inVat = vIn.debit - vIn.credit
    const netToPay = outTotal - inVat
    return {
      period: { from, to },
      outgoing: { vat25: outVat25, vat12: outVat12, vat6: outVat6, total: outTotal },
      incoming: { total: inVat },
      netToPay,
      direction: netToPay >= 0 ? 'BETALA' : 'ÅTERBÄRING',
    }
  }

  // Resultaträkning: intäkter (3xxx, kreditsaldo) minus kostnader
  // (5xxx–8xxx, debetsaldo), grupperat i BAS-kontoklasser.
  async getProfitLossReport(
    organizationId: string,
    from: string,
    to: string,
    propertyId?: string,
  ): Promise<ProfitLossReport> {
    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        journalEntry: {
          organizationId,
          date: { gte: new Date(from), lte: new Date(to) },
        },
      },
      include: { account: true },
    })
    const buckets: Record<string, ReportAccountAmount[]> = {
      revenue: [],
      operating: [],
      admin: [],
      personnel: [],
      depreciation: [],
      financial: [],
    }
    const sums = {
      revenue: 0,
      operating: 0,
      admin: 0,
      personnel: 0,
      depreciation: 0,
      financial: 0,
    }
    const perAccount = new Map<number, { name: string; amount: number }>()
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      const value = num >= 3000 && num < 4000 ? credit - debit : debit - credit
      const cur = perAccount.get(num) ?? { name: l.account.name, amount: 0 }
      cur.amount += value
      perAccount.set(num, cur)
    }
    for (const [num, info] of perAccount) {
      if (num >= 3000 && num < 4000) {
        buckets.revenue!.push({ number: num, name: info.name, amount: info.amount })
        sums.revenue += info.amount
      } else if (num >= 5000 && num < 6000) {
        buckets.operating!.push({ number: num, name: info.name, amount: info.amount })
        sums.operating += info.amount
      } else if (num >= 6000 && num < 7000) {
        buckets.admin!.push({ number: num, name: info.name, amount: info.amount })
        sums.admin += info.amount
      } else if (num >= 7000 && num < 8000) {
        buckets.personnel!.push({ number: num, name: info.name, amount: info.amount })
        sums.personnel += info.amount
      } else if (num >= 8000 && num < 8400) {
        buckets.depreciation!.push({ number: num, name: info.name, amount: info.amount })
        sums.depreciation += info.amount
      } else if (num >= 8400 && num < 9000) {
        buckets.financial!.push({ number: num, name: info.name, amount: info.amount })
        sums.financial += info.amount
      }
    }
    const totalCosts =
      sums.operating + sums.admin + sums.personnel + sums.depreciation + sums.financial
    const result = sums.revenue - totalCosts
    return {
      period: { from, to },
      ...(propertyId
        ? {
            propertyFilter: propertyId,
            note: 'Per-fastighets-resultat kräver att kostnader är taggade per fastighet — totalsumman gäller hela organisationen tills dess.',
          }
        : {}),
      revenue: { total: sums.revenue, accounts: buckets.revenue! },
      costs: {
        operating: { total: sums.operating, accounts: buckets.operating! },
        admin: { total: sums.admin, accounts: buckets.admin! },
        personnel: { total: sums.personnel, accounts: buckets.personnel! },
        depreciation: { total: sums.depreciation, accounts: buckets.depreciation! },
        financial: { total: sums.financial, accounts: buckets.financial! },
        total: totalCosts,
      },
      result,
    }
  }

  // Balansräkning per ett datum: tillgångar (1xxx, debet−kredit) mot
  // skulder/eget kapital (2xxx, kredit−debet). difference ska vara 0 i en
  // balanserad bok.
  async getBalanceSheet(organizationId: string, asOf: string): Promise<BalanceSheet> {
    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        journalEntry: { organizationId, date: { lte: new Date(asOf) } },
      },
      include: { account: true },
    })
    const perAccount = new Map<number, { name: string; balance: number }>()
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      const value = num < 2000 ? debit - credit : credit - debit
      const cur = perAccount.get(num) ?? { name: l.account.name, balance: 0 }
      cur.balance += value
      perAccount.set(num, cur)
    }
    const assets: ReportAccountBalance[] = []
    const liabilities: ReportAccountBalance[] = []
    let totalAssets = 0
    let totalLiabilities = 0
    for (const [num, info] of perAccount) {
      if (num < 2000) {
        assets.push({ number: num, name: info.name, balance: info.balance })
        totalAssets += info.balance
      } else if (num < 3000) {
        liabilities.push({ number: num, name: info.name, balance: info.balance })
        totalLiabilities += info.balance
      }
    }
    assets.sort((a, b) => a.number - b.number)
    liabilities.sort((a, b) => a.number - b.number)
    return {
      asOf,
      assets: { total: totalAssets, accounts: assets },
      liabilitiesAndEquity: { total: totalLiabilities, accounts: liabilities },
      difference: totalAssets - totalLiabilities,
    }
  }

  async createJournalEntryForInvoice(
    invoice: Invoice & { lines: InvoiceLine[] },
    organizationId: string,
    createdById: string,
  ) {
    // Look up account numbers
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    // Välj hyresintäktskonto (39xx) utifrån lägenhetens/lokalens typ. En
    // hyresfaktura avser ett kontrakt (lease) → en unit, så typen avgör om
    // intäkten är bostad (3911), lokal (3913), p-plats (3912) eller övrigt.
    let unitType: UnitType | null = null
    if (invoice.leaseId) {
      // Org-scopad findFirst (inte findUnique på enbart id) — FIX 2-mönstret mot
      // cross-tenant-läsning. Ett leaseId från en annan org → null → fallback
      // till default-intäktskonto (3914) i revenueAccountForUnitType.
      const lease = await this.prisma.lease.findFirst({
        where: { id: invoice.leaseId, organizationId },
        select: { unit: { select: { type: true } } },
      })
      // leaseId var satt men ingen lease hittades i org → anomali (möjligt
      // cross-tenant-försök eller felkopplad lease). Logga så det syns; intäkten
      // faller tillbaka till 3914. Förväntat null (faktura utan lease) loggas ej.
      if (!lease) {
        this.logger.warn(
          `[Accounting] Lease ${invoice.leaseId} hittades ej i org ${organizationId} ` +
            `för faktura ${invoice.invoiceNumber} — intäkt bokförs mot 3914 (fallback).`,
        )
      }
      unitType = lease?.unit?.type ?? null
    }
    const revenueAccountNumber = revenueAccountForUnitType(unitType)

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)

    // Skip if required accounts don't exist
    if (!receivableId || !revenueId) return null

    const subtotal = Number(invoice.subtotal)
    const vatTotal = Number(invoice.vatTotal)
    const total = Number(invoice.total)

    // Build journal lines
    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [
      // Debit receivables for full amount
      { accountId: receivableId, debit: total, description: `Faktura ${invoice.invoiceNumber}` },
      // Credit revenue for subtotal
      { accountId: revenueId, credit: subtotal, description: 'Hyresintäkt' },
    ]

    // Credit VAT accounts if applicable
    if (vatTotal > 0) {
      // Group VAT by rate
      const vatByRate = new Map<number, number>()
      for (const line of invoice.lines) {
        const vat = Number(line.quantity) * Number(line.unitPrice) * (line.vatRate / 100)
        vatByRate.set(line.vatRate, (vatByRate.get(line.vatRate) ?? 0) + vat)
      }

      for (const [rate, amount] of vatByRate) {
        // 0% är momsbefriat — bokförs inte mot momskonto.
        if (rate === 0 || amount <= 0) continue
        const vatAccountNumber = VAT_TO_ACCOUNT[rate]
        if (!vatAccountNumber) continue
        const vatAccountId = accountByNumber.get(vatAccountNumber)
        if (vatAccountId) {
          lines.push({
            accountId: vatAccountId,
            credit: amount,
            description: `Moms ${rate}%`,
          })
        }
      }
    }

    return this.createNumberedEntry({
      organizationId,
      date: invoice.issueDate,
      description: `Faktura ${invoice.invoiceNumber}`,
      source: 'INVOICE',
      sourceId: invoice.id,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId: invoice.id },
      include: { lines: { include: { account: true } } },
    })
  }

  // BFL 5 kap 7 §: verifikationen ska ange motparten. Fakturanumret räcker
  // tekniskt (motpart kan slås upp via fakturakedjan), men BFN:s allmänna råd
  // till 5 kap 7 § anger att motparten bör framgå direkt om det kan ske utan
  // svårigheter. Vi hämtar därför motpartsnamnet via faktura-/avi→tenant-
  // relationen och skriver in det i betalningsverifikatets beskrivning.
  //
  // Selekterar endast namnfälten (inga känsliga uppgifter). Företagsnamn först,
  // annars privatpersonens för-/efternamn. Saknas namn helt returneras null →
  // beskrivningen lämnas utan motpartssuffix (ingen tom parentes).
  private formatCounterparty(
    tenant: {
      companyName: string | null
      firstName: string | null
      lastName: string | null
    } | null,
  ): string | null {
    if (!tenant) return null
    const name =
      tenant.companyName?.trim() || `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
    return name || null
  }

  // Org-scopad findFirst (inte findUnique på enbart id) — FIX 2-mönstret mot
  // multi-tenant-läckage. Anroparna validerar redan id mot org, men scopningen
  // hålls konsekvent i fall metoderna återanvänds från ett mindre strikt kontext.
  private async counterpartyForInvoice(
    invoiceId: string,
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      select: { tenant: { select: { companyName: true, firstName: true, lastName: true } } },
    })
    return this.formatCounterparty(row?.tenant ?? null)
  }

  private async counterpartyForRentNotice(
    noticeId: string,
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: { tenant: { select: { companyName: true, firstName: true, lastName: true } } },
    })
    return this.formatCounterparty(row?.tenant ?? null)
  }

  // BAS-bokning vid bankbetalning: 1930 (Företagskonto) Debet → 1510 (Kundfordringar) Kredit.
  // Idempotent — sourceId = bankTransaction.id, så samma transaktion kan inte
  // bokas två gånger även om matchen ångras och görs om.
  async createJournalEntryForPayment(
    invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'total'>,
    transaction: Pick<BankTransaction, 'id' | 'date' | 'amount'>,
    organizationId: string,
    createdById: string | null,
  ) {
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const bankAccountId = accountByNumber.get(1930)
    const receivableId = accountByNumber.get(1510)

    if (!bankAccountId || !receivableId) return null

    const amount = Number(transaction.amount)
    if (amount <= 0) return null

    const counterparty = await this.counterpartyForInvoice(invoice.id, organizationId)

    return this.createNumberedEntry({
      organizationId,
      date: transaction.date,
      description: `Inbetalning faktura ${invoice.invoiceNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId: transaction.id,
      createdById,
      lines: [
        { accountId: bankAccountId, debit: amount, description: 'Inbetalning bank' },
        { accountId: receivableId, credit: amount, description: 'Reglering kundfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId: transaction.id },
      include: { lines: { include: { account: true } } },
    })
  }

  // Intäktsverifikation vid avisering (BFL 1999:1078, LAGBROTT 2). När en
  // hyresavi skapas uppstår en hyresfordran som ska bokföras enligt
  // bokföringsmässiga grunder (god redovisningssed, BFL 4 kap 2 §):
  //
  //   1510 Kundfordringar    D  totalbelopp
  //   39xx Hyresintäkt       K  nettobelopp (konto per upplåtelsetyp)
  //   26xx Utgående moms     K  momsbelopp (endast om vatAmount > 0)
  //
  // Den efterföljande inbetalningen (createJournalEntryForRentNoticePayment)
  // reglerar fordran 1930 D / 1510 K — utan denna accrual skulle betalningen
  // sakna intäktsmotpost och hyresintäkten aldrig redovisas.
  //
  // Datumet sätts till första dagen i den period avin avser så att intäkten
  // periodiseras rätt vid räkenskapsårsskifte. Idempotent via sourceId
  // ("rent-notice:<id>"). Depositionsavier (type=DEPOSIT) är en skuld, inte
  // intäkt, och hoppas över — de hanteras av deposits-modulen.
  async createJournalEntryForRentNotice(
    notice: {
      id: string
      noticeNumber: string
      leaseId: string
      type: RentNoticeType
      amount: Decimal | number
      vatAmount: Decimal | number
      totalAmount: Decimal | number
      year: number
      month: number
    },
    organizationId: string,
    createdById: string | null,
  ) {
    if (notice.type === RentNoticeType.DEPOSIT) return null

    const sourceId = `rent-notice:${notice.id}`
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    // Intäktskonto utifrån lägenhetens/lokalens typ (bostad 3911, lokal 3913,
    // p-plats 3912, övrigt 3914). Org-scopad findFirst (FIX 2) — ett leaseId
    // från en annan org → null → fallback till 3914.
    const lease = await this.prisma.lease.findFirst({
      where: { id: notice.leaseId, organizationId },
      select: { unit: { select: { type: true } } },
    })
    // Anomali: hyresavins leaseId hittades ej i org → möjligt cross-tenant-
    // försök eller felkopplad lease. Logga; intäkten faller tillbaka till 3914.
    if (!lease) {
      this.logger.warn(
        `[Accounting] Lease ${notice.leaseId} hittades ej i org ${organizationId} ` +
          `för hyresavi ${notice.noticeNumber} — intäkt bokförs mot 3914 (fallback).`,
      )
    }
    const revenueAccountNumber = revenueAccountForUnitType(lease?.unit?.type ?? null)

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)
    if (!receivableId || !revenueId) return null

    const net = Number(notice.amount)
    const vat = Number(notice.vatAmount)
    const total = Number(notice.totalAmount)
    if (total <= 0) return null

    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [{ accountId: receivableId, debit: total, description: `Hyresavi ${notice.noticeNumber}` }]

    // Moms krediteras separat på rätt 26xx-konto. Hellre INGEN verifikation
    // än en som döljer moms i intäktskontot eller bokar fel sats — det vore
    // felaktig momsredovisning (ML 1 kap 1 §) och bryter mot god redovisningssed
    // (BFL 4 kap 2 §). Net krediteras alltid intäktskontot → posten balanserar.
    if (vat > 0 && net > 0) {
      const rate = Math.round((vat / net) * 100)
      const vatAccountNumber = VAT_TO_ACCOUNT[rate]
      if (!vatAccountNumber) {
        this.logger.error(
          `[Accounting] Okänd momssats ${rate}% för hyresavi ${notice.noticeNumber} — verifikation skapas ej`,
        )
        return null
      }
      const vatAccountId = accountByNumber.get(vatAccountNumber)
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto ${vatAccountNumber} saknas i kontoplanen för hyresavi ${notice.noticeNumber} — verifikation skapas ej`,
        )
        return null
      }
      lines.push({ accountId: vatAccountId, credit: vat, description: `Moms ${rate}%` })
    }
    lines.push({
      accountId: revenueId,
      credit: net,
      description: `Hyresintäkt ${notice.month}/${notice.year}`,
    })

    // Periodisering: intäkten hör till den månad avin avser.
    const periodDate = new Date(Date.UTC(notice.year, notice.month - 1, 1))

    return this.createNumberedEntry({
      organizationId,
      date: periodDate,
      description: `Hyresavi ${notice.noticeNumber}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
      include: { lines: { include: { account: true } } },
    })
  }

  // Bokföring av förbrukningsersättning (IMD). Speglar createJournalEntryForRent-
  // Notice: kundfordran debiteras, intäkten krediteras netto, ev. moms separat.
  //
  //   1510 D  totalAmount                (kundfordran)
  //   3920|3970 K  netAmount             (el/värme resp. vatten – bruttoredovisat)
  //   2611 K  vatAmount   (ENDAST om vatStatus = TAXABLE_25)
  //
  // Datumet sätts till mätperiodens slut (periodEnd) — mätperioden styr räken-
  // skapsåret, ALDRIG skapandedatumet (jfr bokföringsbedömningen). Idempotent via
  // sourceId="consumption-charge:<id>" → dubbel confirm skapar inte dubbla
  // verifikat. Momsen tas från charge-snapshotet (PR 2), beräknas aldrig om.
  //
  // Bruttoredovisning: ENDAST intäktssidan bokförs här. Kostnaden (5020/5040)
  // hör till leverantörsfakturan och nettas aldrig mot ersättningen.
  async createJournalEntryForConsumptionCharge(
    charge: {
      id: string
      meterType: MeterType
      periodEnd: Date
      netAmount: Decimal | number
      vatStatus: ConsumptionVatStatus
      vatAmount: Decimal | number
      totalAmount: Decimal | number
    },
    organizationId: string,
    createdById: string | null,
  ) {
    const sourceId = `consumption-charge:${charge.id}`

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const revenueAccountNumber = CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE[charge.meterType]
    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)
    if (!receivableId || !revenueId) {
      this.logger.error(
        `[Accounting] Konto saknas (1510 eller ${revenueAccountNumber}) för förbrukningspost ` +
          `${charge.id} — verifikation skapas ej`,
      )
      return null
    }

    const net = Number(charge.netAmount)
    const vat = Number(charge.vatAmount)
    const total = Number(charge.totalAmount)
    if (total <= 0) return null

    const label = METER_TYPE_LABEL[charge.meterType]
    const period = charge.periodEnd.toISOString().slice(0, 7) // YYYY-MM

    const lines: JournalLineInput[] = [
      { accountId: receivableId, debit: total, description: `Förbrukning ${label} ${period}` },
    ]

    // Momsraden tas DIREKT från charge-snapshotet — beräknas aldrig om (PR 2 äger
    // momsregeln via vatRateForRent). EXEMPT (bostad m.fl.) ger ingen 26xx-rad;
    // hellre INGEN verifikation än en med fel momsbehandling (ML 1 kap 1 §, god
    // redovisningssed BFL 4 kap 2 §).
    if (charge.vatStatus === 'TAXABLE_25' && vat > 0) {
      const vatAccountNumber = VAT_TO_ACCOUNT[25] // 2611
      const vatAccountId = vatAccountNumber ? accountByNumber.get(vatAccountNumber) : undefined
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto ${vatAccountNumber} saknas för förbrukningspost ${charge.id} — verifikation skapas ej`,
        )
        return null
      }
      lines.push({ accountId: vatAccountId, credit: vat, description: 'Moms 25%' })
    }

    lines.push({
      accountId: revenueId,
      credit: net,
      description: `Förbrukningsersättning ${label} ${period}`,
    })

    return this.createNumberedEntry({
      organizationId,
      // Mätperiodens slut styr räkenskapsåret — inte skapandedatumet.
      date: charge.periodEnd,
      description: `Förbrukning ${label} ${period}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
      include: { lines: { include: { account: true } } },
    })
  }

  // Bokslutspost: upplupen förbrukningsintäkt (IMD). Förbrukning som är konsumerad
  // men ännu OMÄTT vid räkenskapsårets slut (mätaren läses först i januari) saknar
  // ett ACTUAL-verifikat i rätt år. Här periodiseras den estimerade intäkten:
  //
  //   Accrual (datum = räkenskapsårets slut, normalt 31/12):
  //     1790 D  total        (upplupen intäkt, interimsfordran)
  //     3920|3970 K  net     (el/värme resp. vatten — bruttoredovisat)
  //     2611 K  vat          (endast om vatStatus = TAXABLE_25)
  //   Reversal (datum = nästa räkenskapsårs första dag, normalt 1/1) — speglar
  //   accrual rad för rad så intäkten inte dubbelräknas när den verkliga (ACTUAL)
  //   förbrukningen bokförs:
  //     3920|3970 D  net   / 2611 D vat   / 1790 K total
  //
  // Bruttoredovisning: endast intäktssidan. Idempotent via separata sourceId för
  // accrual respektive reversal → bokslutet kan köras om utan dubbla poster.
  // Detta är en BOKSLUTSPOST — den materialiseras ALDRIG som en ConsumptionCharge
  // och hamnar aldrig på en avi/faktura (jfr ACTUAL-flödet).
  async createConsumptionAccrualEntry(
    params: {
      meterId: string
      meterType: MeterType
      fiscalYear: number
      yearEndDate: Date
      reversalDate: Date
      netAmount: number
      vatStatus: ConsumptionVatStatus
      vatAmount: number
      totalAmount: number
    },
    organizationId: string,
    createdById: string | null,
  ) {
    const { meterId, meterType, fiscalYear, yearEndDate, reversalDate } = params
    const net = params.netAmount
    const vat = params.vatAmount
    const total = params.totalAmount
    if (total <= 0) return null

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const accrualAccountId = accountByNumber.get(1790)
    const revenueId = accountByNumber.get(CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE[meterType])
    if (!accrualAccountId || !revenueId) {
      this.logger.error(
        `[Accounting] Konto saknas (1790 eller intäktskonto) för upplupen förbrukning ` +
          `mätare ${meterId} ${fiscalYear} — bokslutspost skapas ej`,
      )
      return null
    }

    let vatAccountId: string | undefined
    if (params.vatStatus === 'TAXABLE_25' && vat > 0) {
      const vatNumber = VAT_TO_ACCOUNT[25] // 2611
      vatAccountId = vatNumber ? accountByNumber.get(vatNumber) : undefined
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto 2611 saknas för upplupen förbrukning mätare ${meterId} — bokslutspost skapas ej`,
        )
        return null
      }
    }

    const label = METER_TYPE_LABEL[meterType]
    // Mätarreferens i verifikattexten (BFL 5 kap 7 §) — sambandet ska kunna
    // fastställas utan att slå upp sourceId.
    const meterRef = meterId.slice(0, 8)
    const accrualSourceId = `consumption-accrual:${meterId}:${fiscalYear}`
    const reversalSourceId = `consumption-accrual-reversal:${meterId}:${fiscalYear}`

    const accrualLines: JournalLineInput[] = [
      { accountId: accrualAccountId, debit: total, description: `Upplupen förbrukning ${label}` },
    ]
    if (vatAccountId)
      accrualLines.push({ accountId: vatAccountId, credit: vat, description: 'Moms 25%' })
    accrualLines.push({
      accountId: revenueId,
      credit: net,
      description: `Upplupen förbrukningsersättning ${label} ${fiscalYear}`,
    })

    const reversalLines: JournalLineInput[] = [
      { accountId: revenueId, debit: net, description: `Återföring upplupen förbrukning ${label}` },
    ]
    if (vatAccountId)
      reversalLines.push({ accountId: vatAccountId, debit: vat, description: 'Moms 25%' })
    reversalLines.push({
      accountId: accrualAccountId,
      credit: total,
      description: `Återföring upplupen intäkt ${label} ${fiscalYear}`,
    })

    // Accrual (räkenskapsårets slut) + reversal (nästa års första dag) skapas
    // ATOMISKT i EN transaktion: en halvfärdig periodisering (accrual utan
    // reversal) skulle dubbelräkna intäkten nästa år. Antingen båda eller inget.
    // createNumberedEntry förblir idempotent inuti transaktionen via sourceId.
    return this.prisma.$transaction(async (tx) => {
      const accrual = await this.createNumberedEntry({
        organizationId,
        date: yearEndDate,
        description: `Bokslut: upplupen förbrukning ${label} ${fiscalYear} (mätare ${meterRef})`,
        source: 'MANUAL',
        sourceId: accrualSourceId,
        createdById,
        lines: accrualLines,
        idempotencyWhere: { organizationId, sourceId: accrualSourceId },
        include: { lines: { include: { account: true } } },
        tx,
      })

      const reversal = await this.createNumberedEntry({
        organizationId,
        date: reversalDate,
        description: `Bokslut: återföring upplupen förbrukning ${label} ${fiscalYear} (mätare ${meterRef})`,
        source: 'MANUAL',
        sourceId: reversalSourceId,
        createdById,
        lines: reversalLines,
        idempotencyWhere: { organizationId, sourceId: reversalSourceId },
        include: { lines: { include: { account: true } } },
        tx,
      })

      return { accrual, reversal }
    })
  }

  // Bokföring av hyresinbetalning (RentNotice). Använder samma BAS-konton som
  // Invoice-betalning (1930 D bank / 1510 K kundfordran) — hyresavin är en
  // kundfordran på samma sätt. Vi indexerar med samma source='PAYMENT' och
  // sourceId=transaction.id så reverseJournalEntryForPayment fungerar för
  // båda typerna utan särfall.
  async createJournalEntryForRentNoticePayment(
    notice: { id: string; noticeNumber: string; totalAmount: Decimal },
    transaction: Pick<BankTransaction, 'id' | 'date' | 'amount'>,
    organizationId: string,
    createdById: string | null,
  ) {
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const bankAccountId = accountByNumber.get(1930)
    const receivableId = accountByNumber.get(1510)
    if (!bankAccountId || !receivableId) return null

    const amount = Number(transaction.amount)
    if (amount <= 0) return null

    void notice.totalAmount

    const counterparty = await this.counterpartyForRentNotice(notice.id, organizationId)

    return this.createNumberedEntry({
      organizationId,
      date: transaction.date,
      description: `Inbetalning hyresavi ${notice.noticeNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId: transaction.id,
      createdById,
      lines: [
        { accountId: bankAccountId, debit: amount, description: 'Inbetalning bank' },
        { accountId: receivableId, credit: amount, description: 'Reglering hyresfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId: transaction.id },
      include: { lines: { include: { account: true } } },
    })
  }

  // FIX 9 · PR 6 — Manuell betalningsregistrering av en hyresavi (markAsPaid).
  // Sluter intäktscykeln: PR 2 bokförde fordran vid avisering (1510 D / 39xx K),
  // och denna post reglerar fordran när betalningen registreras manuellt:
  //
  //   1930/1910/1934  Likvidkonto    D  inbetalt belopp   (per betalningssätt)
  //   1510            Kundfordringar K  inbetalt belopp
  //
  // Till skillnad från createJournalEntryForRentNoticePayment (som matchar en
  // importerad BankTransaction vid bankavstämning) finns här ingen transaktion —
  // betalningssättet styr debetkontot och idempotensen nycklas på själva avin
  // (sourceId = "rent-notice-payment:<id>") så att en dubbel-markering aldrig
  // bokför betalningen två gånger (BFL 5 kap 6 §, gap-free serie via
  // createNumberedEntry). Beloppet är det FAKTISKT inbetalda (paidAmount) — vid
  // delbetalning regleras fordran bara delvis, vilket är korrekt dubbel bokföring.
  //
  // Depositionsavier (type=DEPOSIT) hoppas över: deras 1510/2890-flöde ägs av
  // deposits-modulen (createJournalEntryForDepositInvoice), inte avisering.
  async createJournalEntryForRentNoticeManualPayment(
    notice: { id: string; noticeNumber: string; type: RentNoticeType },
    paidAmount: number,
    paidAt: Date,
    paymentMethod: PaymentMethod,
    organizationId: string,
    createdById: string | null,
  ) {
    if (notice.type === RentNoticeType.DEPOSIT) return null

    const amount = Number(paidAmount)
    if (!Number.isFinite(amount) || amount <= 0) return null

    const debitAccountNumber = PAYMENT_METHOD_TO_ACCOUNT[paymentMethod]

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const debitAccountId = accountByNumber.get(debitAccountNumber)
    const receivableId = accountByNumber.get(1510)
    if (!debitAccountId || !receivableId) {
      this.logger.error(
        `[Accounting] Likvidkonto ${debitAccountNumber} eller 1510 saknas i ` +
          `kontoplanen (org ${organizationId}) — betalningsverifikat för hyresavi ` +
          `${notice.noticeNumber} skapas ej.`,
      )
      return null
    }

    const sourceId = `rent-notice-payment:${notice.id}`

    const counterparty = await this.counterpartyForRentNotice(notice.id, organizationId)

    return this.createNumberedEntry({
      organizationId,
      date: paidAt,
      description: `Inbetalning hyresavi ${notice.noticeNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        {
          accountId: debitAccountId,
          debit: amount,
          description: PAYMENT_METHOD_LABEL[paymentMethod],
        },
        { accountId: receivableId, credit: amount, description: 'Reglering hyresfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
    })
  }

  // Reverse av betalningsverifikat: skapar ett motverifikat (debet/kredit byter
  // plats) — append-only, vi raderar aldrig en tidigare bokad post.
  async reverseJournalEntryForPayment(
    transactionId: string,
    organizationId: string,
    createdById: string | null,
    // Valfri yttre transaktion — när reverseringen måste ske atomiskt med en
    // statusåterställning (unmatch). Utan den körs den fristående som förut.
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source: 'PAYMENT', sourceId: transactionId },
      include: { lines: true },
    })
    if (!original) return

    // Motverifikatet byter plats på debet/kredit. createNumberedEntry är
    // idempotent via det unika indexet på (org, source, sourceId) — en redan
    // skapad reversal returneras utan att en dubblett bokförs.
    const reversalLines: JournalLineInput[] = original.lines.map((l) => ({
      accountId: l.accountId,
      ...(l.debit != null ? { credit: Number(l.debit) } : {}),
      ...(l.credit != null ? { debit: Number(l.credit) } : {}),
      ...(l.description ? { description: `Reversal: ${l.description}` } : {}),
    }))

    await this.createNumberedEntry({
      organizationId,
      date: new Date(),
      description: `Hävd matchning: ${original.description}`,
      source: 'PAYMENT',
      sourceId: `reversal:${transactionId}`,
      createdById,
      lines: reversalLines,
      idempotencyWhere: {
        organizationId,
        source: 'PAYMENT',
        sourceId: `reversal:${transactionId}`,
      },
      ...(tx ? { tx } : {}),
    })
  }

  // BAS för registrering av deposition: 1510 D (kundfordran) / 2890 K (skuld
  // för mottagen deposition). 2890 (Övriga kortfristiga skulder, beskrivning
  // "Mottagna depositioner") är rätt BAS 2024-konto — depositionen är en skuld
  // till hyresgästen tills avflyttning. Tidigare felaktigt 2490; även 2820 är
  // fel då det officiellt avser löneskulder. Posten skrivs en gång per deposit
  // (idempotent).
  async createJournalEntryForDepositInvoice(
    depositId: string,
    organizationId: string,
    amount: number,
    invoiceNumber: string,
    issueDate: Date,
    createdById: string | null,
  ) {
    const sourceId = `deposit-invoice:${depositId}`
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = accountByNumber.get(1510)
    const liabilityId = accountByNumber.get(2890)
    if (!receivableId || !liabilityId) return null

    return this.createNumberedEntry({
      organizationId,
      date: issueDate,
      description: `Deposition ${invoiceNumber}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines: [
        { accountId: receivableId, debit: amount, description: 'Depositionsfordran' },
        { accountId: liabilityId, credit: amount, description: 'Mottagen deposition' },
      ],
      idempotencyWhere: { organizationId, sourceId },
    })
  }

  // BAS för återbetalning av deposition: 2890 D (skulden minskar)
  // / 1930 K (bank) för återbetald del. Eventuella avdrag krediteras 3040
  // (skadeersättningar) istället, så bokföringen alltid balanserar.
  async createJournalEntryForDepositRefund(
    depositId: string,
    organizationId: string,
    refundAmount: number,
    deductionsTotal: number,
    transactionDate: Date,
    createdById: string | null,
  ) {
    const sourceId = `deposit-refund:${depositId}`
    const total = refundAmount + deductionsTotal
    if (total <= 0) return null

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const liabilityId = accountByNumber.get(2890)
    const bankId = accountByNumber.get(1930)
    const damageRevenueId = accountByNumber.get(3040)
    if (!liabilityId || !bankId) return null

    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [{ accountId: liabilityId, debit: total, description: 'Återförd depositionsskuld' }]
    if (refundAmount > 0) {
      lines.push({ accountId: bankId, credit: refundAmount, description: 'Återbetalning bank' })
    }
    if (deductionsTotal > 0 && damageRevenueId) {
      lines.push({
        accountId: damageRevenueId,
        credit: deductionsTotal,
        description: 'Avdrag (skador)',
      })
    } else if (deductionsTotal > 0) {
      // Saknas 3040 — boka resten på 1510 (fordran) som fallback så att
      // bokföringen balanserar. Användaren får manuellt rätta efteråt.
      const receivableId = accountByNumber.get(1510)
      if (!receivableId) return null
      lines.push({
        accountId: receivableId,
        debit: 0,
        credit: deductionsTotal,
        description: 'Avdrag (manuell justering krävs — saknar konto 3040)',
      })
    }

    return this.createNumberedEntry({
      organizationId,
      date: transactionDate,
      description: `Återbetalning deposition`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
    })
  }
}
