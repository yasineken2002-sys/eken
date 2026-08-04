import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Deposit, DepositStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { allocateInvoiceNumber } from '../invoices/invoice-number'
import { computeInvoiceDebt } from '../invoices/invoice-debt'
import { NotificationsService } from '../notifications/notifications.service'
import { CreateDepositDto } from './dto/create-deposit.dto'
import { RefundDepositDto } from './dto/refund-deposit.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

const INCLUDE = {
  lease: { include: { unit: { include: { property: true } } } },
  tenant: { select: SAFE_TENANT_SELECT },
  invoice: { select: { id: true, invoiceNumber: true, status: true, total: true } },
} as const

interface DepositDeduction {
  reason: string
  amount: number
}

@Injectable()
export class DepositsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DepositsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly notifications: NotificationsService,
  ) {}

  // #41: kör backfillen EN gång vid uppstart (efter migrate deploy) så befintliga
  // orphan-deposition-avier får sin Deposit-rad + 1510 D/2890 K medan ingen
  // räkenskapsperiod ännu stängts. Idempotent (0 orphans efter första körningen)
  // + best-effort (får aldrig blockera app-start). Hoppas i testmiljö.
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    try {
      await this.backfillOrphanDepositNotices()
    } catch (err) {
      this.logger.error(`[deposit-backfill] uppstarts-backfill misslyckades: ${String(err)}`)
    }
  }

  async findAll(
    organizationId: string,
    filters?: { status?: DepositStatus; leaseId?: string },
  ): Promise<Deposit[]> {
    return this.prisma.deposit.findMany({
      where: {
        organizationId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!deposit) throw new NotFoundException('Depositionen hittades inte')
    return deposit
  }

  async findByLease(leaseId: string, organizationId: string) {
    return this.prisma.deposit.findFirst({
      where: { leaseId, organizationId },
      include: INCLUDE,
    })
  }

  // ── Skapa deposition (med automatisk faktura + bokföringspost) ──────────────

  async create(dto: CreateDepositDto, organizationId: string, userId: string): Promise<Deposit> {
    const lease = await this.prisma.lease.findFirst({
      where: { id: dto.leaseId, organizationId },
      select: {
        id: true,
        tenantId: true,
        depositAmount: true,
        monthlyRent: true,
        unit: { select: { type: true } },
      },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')

    const existing = await this.prisma.deposit.findUnique({ where: { leaseId: dto.leaseId } })
    if (existing) {
      throw new BadRequestException('Kontraktet har redan en deposition')
    }

    const amount = dto.amount ?? Number(lease.depositAmount)
    if (amount <= 0) {
      throw new BadRequestException('Depositionsbelopp måste vara större än 0')
    }

    // Praxis (hyresnämnden + Konsumentverket): deposition för bostad får inte
    // överstiga 3 månadshyror. Lokalhyra har fri depositionsbestämning.
    // Validering här fångar fallet då dto.amount överrider lease.depositAmount
    // — leases.service validerar redan vid kontraktsskapande.
    if (lease.unit.type === 'APARTMENT') {
      const monthlyRent = Number(lease.monthlyRent)
      const cap = monthlyRent * 3
      if (amount > cap) {
        throw new BadRequestException(
          `Deposition för bostad får enligt praxis inte överstiga 3 månadshyror (${cap.toLocaleString(
            'sv-SE',
          )} kr). Högre belopp kan ogiltigförklaras som otillåten förskottshyra.`,
        )
      }
    }

    const today = new Date()
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)

    const result = await this.prisma.$transaction(async (tx) => {
      // Delad, race-säker allokering (samma sekvens som InvoicesService) — den
      // gamla count()+1 kolliderade med sekvensen och kraschade manuell
      // fakturering efter en deposition (unique-constraint på invoiceNumber).
      const { invoiceNumber } = await allocateInvoiceNumber(tx, organizationId, today.getFullYear())

      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          type: 'DEPOSIT',
          status: 'DRAFT',
          tenantId: lease.tenantId,
          leaseId: lease.id,
          subtotal: amount,
          vatTotal: 0,
          total: amount,
          dueDate,
          issueDate: today,
          notes: 'Deposition enligt hyresavtal',
          lines: {
            create: [
              {
                description: 'Deposition',
                quantity: 1,
                unitPrice: amount,
                vatRate: 0,
                total: amount,
              },
            ],
          },
        },
      })

      const deposit = await tx.deposit.create({
        data: {
          organizationId,
          leaseId: lease.id,
          tenantId: lease.tenantId,
          amount,
          status: 'PENDING',
          invoiceId: invoice.id,
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
        include: INCLUDE,
      })

      await tx.invoiceEvent.create({
        data: {
          invoiceId: invoice.id,
          type: 'CREATED',
          actorType: 'USER',
          actorId: userId,
          payload: { invoiceNumber, depositId: deposit.id },
        },
      })

      // T5 A1: boka 1510 D / 2890 K i SAMMA transaktion som Invoice+Deposit
      // (speglar ensureDepositForNotice). En Deposit får ALDRIG existera utan sin
      // 1510-debet — annars blir bankmatchningens 1930 D/1510 K en ogrundad
      // kreditering (F1-fällan). Kastar (eller null → kontoplan saknar 1510/2890)
      // rullas HELA depositionen tillbaka. Tidigare låg bokföringen utanför tx och
      // sväljdes, så en obokförd deposition kunde bli kvar.
      const entry = await this.accounting.createJournalEntryForDepositInvoice(
        deposit.id,
        organizationId,
        Number(invoice.total),
        invoice.invoiceNumber,
        invoice.issueDate,
        userId,
        tx,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Depositionens bokföringspost (1510 D / 2890 K) kunde inte skapas för faktura ` +
            `${invoice.invoiceNumber} — kontoplanen saknar konto 1510 eller 2890.`,
        )
      }

      return { deposit, invoice }
    })

    return result.deposit
  }

  // ── #41: Deposit-rad för aktiverings-avin (skapa + boka atomiskt) ───────────
  //
  // Aktiveringen skapar en RentNotice{DEPOSIT} men historiskt ingen Deposit-rad
  // → depositionen bokfördes aldrig (1510/2890) och kunde aldrig återbetalas.
  // Denna metod skapar Deposit-raden OCH bokför 1510 D/2890 K i SAMMA transaktion
  // (Deposit finns ⇔ accrual bokförd). Delad av aktiveringen (avisering) och
  // backfillen så konteringen blir identisk. Idempotent: en deposition per lease
  // (leaseId @unique) — hoppar om den redan finns (manuell eller redan skapad).
  // Kastar om accrual-verifikatet uteblir (saknad kontoplan) så en Deposit ALDRIG
  // existerar utan bokförd 1510-debet (annars vore bankmatchningens 1930 D/1510 K
  // en ogrundad kreditering — F1-fällan).
  async ensureDepositForNotice(params: {
    organizationId: string
    leaseId: string
    tenantId: string
    rentNoticeId: string
    noticeNumber: string
    amount: number
    date: Date
  }): Promise<{ created: boolean }> {
    const amount = Number(params.amount)
    if (!(amount > 0)) return { created: false }

    const existing = await this.prisma.deposit.findUnique({
      where: { leaseId: params.leaseId },
      select: { id: true },
    })
    if (existing) return { created: false }

    try {
      await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposit.create({
          data: {
            organizationId: params.organizationId,
            leaseId: params.leaseId,
            tenantId: params.tenantId,
            rentNoticeId: params.rentNoticeId,
            amount,
            status: 'PENDING',
          },
        })
        const entry = await this.accounting.createJournalEntryForDepositInvoice(
          deposit.id,
          params.organizationId,
          amount,
          params.noticeNumber,
          params.date,
          null,
          tx,
        )
        if (entry === null) {
          throw new InternalServerErrorException(
            `Depositionens bokföringspost (1510 D / 2890 K) kunde inte skapas för avi ` +
              `${params.noticeNumber} — kontoplanen saknar konto 1510 eller 2890.`,
          )
        }
      })
      return { created: true }
    } catch (err) {
      // Race: en samtidig aktivering/backfill hann skapa Deposit (leaseId @unique).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { created: false }
      }
      throw err
    }
  }

  // #41-backfill: skapa Deposit + boka 1510 D/2890 K för befintliga deposition-avier
  // utan länkad Deposit (skapade före #41). Idempotent (ensureDepositForNotice
  // hoppar redan skapade). Körs vid uppstart — MÅSTE köras medan ingen räkenskaps-
  // period är stängd (VerifikationsnummerService blockerar annars gamla datum).
  // Best-effort per avi så en enskild felkontoplan inte stoppar hela svepet.
  async backfillOrphanDepositNotices(): Promise<{ scanned: number; created: number }> {
    const orphans = await this.prisma.rentNotice.findMany({
      where: { type: 'DEPOSIT', deposit: { is: null } },
      select: {
        id: true,
        organizationId: true,
        leaseId: true,
        tenantId: true,
        noticeNumber: true,
        totalAmount: true,
        createdAt: true,
      },
    })
    let created = 0
    for (const n of orphans) {
      try {
        const r = await this.ensureDepositForNotice({
          organizationId: n.organizationId,
          leaseId: n.leaseId,
          tenantId: n.tenantId,
          rentNoticeId: n.id,
          noticeNumber: n.noticeNumber,
          amount: Number(n.totalAmount),
          date: n.createdAt,
        })
        if (r.created) created++
      } catch (err) {
        this.logger.error(
          `[deposit-backfill] avi ${n.noticeNumber} (lease ${n.leaseId}) misslyckades: ${String(err)}`,
        )
      }
    }
    if (orphans.length > 0) {
      this.logger.log(
        `[deposit-backfill] ${created}/${orphans.length} orphan-deposition-avier bakåtfyllda (Deposit + 1510 D/2890 K)`,
      )
    }
    return { scanned: orphans.length, created }
  }

  // ── Markera som betald ──────────────────────────────────────────────────────

  async markPaid(id: string, organizationId: string, userId: string): Promise<Deposit> {
    const deposit = await this.findOne(id, organizationId)

    if (deposit.status !== 'PENDING') {
      throw new BadRequestException('Endast väntande depositioner kan markeras som betalda')
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date()

      // Status-guardad claim på DEPOSITIONEN (sanningskällan för "betald") — race-säker.
      const claimaDeposition = async () => {
        const claim = await tx.deposit.updateMany({
          where: { id, organizationId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: now },
        })
        if (claim.count === 0) {
          throw new ConflictException(
            'Depositionen är redan reglerad — uppdatera sidan och försök igen',
          )
        }
      }

      if (deposit.invoiceId) {
        // ── LÅSORDNING (#293) ────────────────────────────────────────────────
        //
        // Fakturan låses FÖRST och depositionen claimas SIST i den här grenen.
        // Bankvägen tar samma resurser i den ordningen (applyMatchToInvoice:
        // FOR UPDATE på fakturan, därefter updateMany på Deposit). Tog vi dem i
        // omvänd ordning kunde de två vägarna vänta in varandra korsvis och
        // Postgres avbryta en av dem med deadlock.
        //
        // Avi-grenen (rentNoticeId) behåller claim-FÖRST med flit: där finns
        // ingen faktura att låsa, och Deposit-statusen ÄR dess serialisering mot
        // bankmatchningen (som kräver Deposit=PENDING).
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${deposit.invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`
        const inv = await tx.invoice.findFirst({
          where: { id: deposit.invoiceId, organizationId },
          select: { id: true, status: true, invoiceNumber: true, total: true },
        })

        // ── #297: MAKULERAD/SAKNAD FAKTURA KASTAR — INGEN TYST LÄKNING ───────
        //
        // Tidigare föll båda de här fallen igenom bokningsgrinden nedan och
        // landade rakt i claimaDeposition(): depositionen flippades till PAID
        // helt utan bokning. Resultatet var ett tyst tillstånd ingen upptäcker —
        // depositionen ser betald ut, fakturan är makulerad, huvudboken vet
        // ingenting. Ingen felkod, ingen avvikande status, ingen post att stämma
        // av mot. Följdrisk: refund() kräver status === 'PAID' och skulle alltså
        // kunna betala tillbaka en deposition som aldrig bokförts.
        //
        // ATT NEKA KOSTAR INGENTING. En faktura med registrerad betalning KAN
        // inte makuleras (invoices.service.ts spärrar VOID när allokeringar
        // finns), så en VOID depositionsfaktura har per konstruktion aldrig tagit
        // emot pengar. Vi stänger alltså ingen väg som bär ett verkligt belopp.
        //
        // Och att boka VORE fel: en makulerad faktura är ett annullerat underlag.
        // Att registrera en inbetalning mot den — utan att någon tagit ställning
        // till makuleringen — är precis den sortens obevakade kreditering som
        // bankvägen redan vägrar göra för orphan-depositionsavier
        // (reconciliation.service.ts, DEPOSIT-grenen: "ingen Deposit-rad →
        // return false, FAIL-CLOSED"). Samma princip, samma svar.
        //
        // ⚠️ SEPARAT DEFEKT, MEDVETET INTE LAGAD HÄR: makuleringen reverserar
        // INTE depositionens accrual. reverseJournalEntryForInvoice söker
        // source='INVOICE' + sourceId=<invoiceId>, men depositionens post ligger
        // under sourceId='deposit-invoice:<depositId>' — findFirst ger null och
        // reverseringen blir en no-op. Efter VOID står alltså 1510 D / 2890 K
        // kvar öppen. Det är ett fel i MAKULERINGSVÄGEN, inte något markPaid ska
        // dölja genom att flippa depositionen till PAID. Verifierat mot riktig
        // Postgres i #297:s bevisrigg (E2E-scenario S2).
        //
        // AVGRÄNSNING: grinden gäller BARA makulerad/saknad faktura. Fallet
        // "restskuld 0" (banken hann före) läker fortfarande depositionen till
        // PAID längre ned — där finns en verklig, bokförd betalning bakom.
        //
        // Läsningen ligger INNANFÖR radlåset av samma skäl som restskulden gör
        // det: statusen vi fattar beslutet på ska inte kunna ändras under oss.
        if (!inv) {
          throw new ConflictException(
            'Depositionens faktura hittades inte — depositionen kan inte markeras som ' +
              'betald utan sin faktura. Kontrollera fakturan innan betalningen registreras.',
          )
        }
        if (inv.status === 'VOID') {
          // Meddelandet lovar INTE en väg som inte finns: en makulering kan inte
          // ångras, och en ny depositionsfaktura går inte att utfärda (Deposit
          // är unik per kontrakt, och en andra accrual skulle dubblera 1510).
          // Då är rätt svar att säga det, inte att peka på en knapp som saknas.
          throw new ConflictException(
            `Depositionsfakturan ${inv.invoiceNumber} är makulerad — en makulerad faktura kan ` +
              'inte ta emot en betalning, så depositionen kan inte markeras som betald. ' +
              'Makuleringen går inte att ångra i systemet: kontakta supporten för att koppla ' +
              'loss depositionen, oavsett om hyresgästen hunnit betala eller inte.',
          )
        }

        // Boka bara om fakturan inte redan reglerats (t.ex. av en bankmatch) — annars
        // står vi kvar med en redan bokförd betalning och ska inte dubbelbokföra.
        //
        // STATUS-GRINDEN ÄR KVAR MED FLIT, den ersätts INTE av restskulds-
        // beräkningen nedan: en depositionsfaktura som reglerades före #290 står
        // PAID med NOLL allokeringar, och för den skulle restskulden räknas till
        // hela totalen. Statusgrinden är det som håller den utanför.
        //
        // VOID-grenen är utbruten ovan (#297) och når aldrig hit; PAID läker
        // fortfarande, som förut.
        if (inv.status !== 'PAID') {
          // ── #293: BELOPPET ÄR RESTSKULDEN, INTE deposit.amount ─────────────
          //
          // En depositionsfaktura är en helt vanlig Invoice utan typfilter i
          // reconciliation.service.ts och kan därför delbetalas via
          // manualMatch(..., allowPartial: true) → status PARTIAL, en allokering
          // och ett verifikat på delbeloppet. Deposit synkas INTE vid partiell
          // matchning (bara vid full reglering) utan ligger kvar PENDING.
          //
          // Den här grenen läste tidigare bara inv.status, aldrig
          // allokeringsmodellen, och bokförde blint hela deposit.amount ovanpå
          // det som redan kommit in: en 20 000-faktura med 5 000 bankmatchat gav
          // 25 000 mot 1930 — 5 000 kr som aldrig tagits emot (BFL 5 kap 6 §:
          // verifikationen ska motsvara en verklig affärshändelse).
          //
          // Restskulden läses INNANFÖR radlåset, av samma skäl som
          // markAsPaidManually gör det (#288): låg läsningen utanför kunde en
          // samtidig bankmatchning skriva en allokering emellan och göra
          // beloppet beräknat på inaktuell grund.
          //
          // Ingen ny semantik: "markera betald utan angivet belopp" = "betala
          // restskulden" är precis vad markAsPaidManually redan gör när
          // enteredAmount utelämnas. Utan tidigare allokeringar är restskulden
          // hela totalen — normalfallet bokför alltså exakt som förut.
          const priorAllocations = await tx.invoicePayment.findMany({
            where: { invoiceId: inv.id },
            select: { amount: true },
          })
          const debt = computeInvoiceDebt({
            total: inv.total,
            allocations: priorAllocations.map((a) => a.amount),
          })

          // Restskuld ≤ 0: fordran är redan reglerad i sin helhet (kan inträffa
          // om banken hunnit före utan att statusen speglar det). Då finns inget
          // att bokföra — depositionen claimas ändå nedan, vilket läker den
          // hängande PENDING-statusen utan att röra huvudboken.
          if (debt.outstanding.gt(0)) {
            await tx.invoice.update({
              where: { id: inv.id },
              data: { status: 'PAID', paidAt: now },
            })
            await tx.invoiceEvent.create({
              data: {
                invoiceId: inv.id,
                type: 'PAYMENT_RECEIVED',
                actorType: 'USER',
                actorId: userId,
                // Loggen bär det FAKTISKT bokförda beloppet, inte deposit.amount
                // — annars påstår spåret något annat än verifikatet (#293).
                payload: { source: 'deposit', amount: debt.outstanding.toNumber() },
              },
            })

            // #290: allokeringen depositionsvägen aldrig skrev. Fakturan flippades
            // till PAID med noll InvoicePayment-rader — osynlig för
            // computeInvoiceDebt, som är sanningskällan för restskuld på alla andra
            // vägar. Raden är den betalning som ändå bokförs på raden nedanför
            // (samma belopp, samma datum), och den bär verifikatets idempotensnyckel.
            //
            // Ingen dubbelräkning: allokeringen skrivs BARA i den gren som också
            // sätter status PAID, och den grenen körs bara en gång per deposition
            // (Deposit-status-claimen PENDING→PAID nedan). Huvudboken och
            // allokeringstabellen är dessutom skilda dataplan — ingen vy, rapport
            // eller kravtrappa summerar båda.
            const allocation = await tx.invoicePayment.create({
              data: {
                invoiceId: inv.id,
                amount: debt.outstanding,
                paidAt: now,
                source: 'MANUAL',
              },
            })

            // Bokför inbetalningen (likvidkonto 1930 D / 1510 K) i SAMMA tx. Reglerar
            // depositionens kundfordran som bokfördes vid create (1510 D / 2890 K).
            // Utan detta stod 1510 kvar öppen trots betald deposition (BFL 5 kap 6 §).
            // Verifikatet uteblir (null) → kasta → hela markPaid rullas tillbaka.
            const entry = await this.accounting.createJournalEntryForInvoiceManualPayment(
              { id: inv.id, invoiceNumber: inv.invoiceNumber },
              debt.outstanding.toNumber(),
              now,
              'MANUAL',
              organizationId,
              userId,
              allocation.id,
              tx,
            )
            if (entry === null) {
              throw new InternalServerErrorException(
                `Betalningsverifikat kunde inte skapas för deposition ${id} — ` +
                  'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
              )
            }
          }
        }

        await claimaDeposition()
      } else if (deposit.rentNoticeId) {
        // ⚠️ CLAIM-FÖRST ÄR AVSIKTLIGT HÄR — och det bär en spärr (#296, #298).
        //
        // Fakturagrenen ovan claimar depositionen SIST (låsordning faktura →
        // deposition, samma som bankvägen). Den här grenen gör TVÄRTOM, och det ser
        // ut som en inkonsekvens. Det är det inte:
        //
        //   denna väg:  Deposit (claim här)  →  ...  →  RentNotice (updateMany)
        //   bankvägen:  RentNotice (FOR UPDATE) →  ...  →  Deposit (updateMany)
        //
        // Motsatta riktningar, med flit. Krockar de dödar Postgres en av dem innan
        // någon hunnit bokföra dubbelt — och det är det ENDA som håller #296 stängt,
        // eftersom bankvägens deposit-updateMany aldrig kontrollerar sin `count`.
        //
        // MÄTT (#296): 440 parallella försök → 440/440 ett verifikat. Med bankvägens
        // avi-lås borttaget: 39/40 gav två verifikat och 40 000 kr mot en 20 000-fordran.
        //
        // RÄTAR DU ORDNINGEN HÄR utan att först ge bankvägen en egen spärr tänder du
        // ett penningfel där. Läs #298 innan du rör den.
        await claimaDeposition()
        // #41/T2.2: avi-länkad deposition utan Invoice → boka manuell betalning
        // 1930 D / 1510 K keyat på depositId, och flippa den länkade avin → PAID.
        // Deposit-status-claimen ovan (PENDING→PAID) serialiserar mot bankmatchningen
        // (som kräver Deposit=PENDING) → bara EN väg bokför, ingen dubbelbokning.
        const entry = await this.accounting.createJournalEntryForDepositManualPayment(
          id,
          organizationId,
          Number(deposit.amount),
          now,
          'MANUAL',
          userId,
          tx,
        )
        if (entry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för deposition ${id} — ` +
              'kontoplanen saknar konto 1930 eller 1510.',
          )
        }
        // Flippa den länkade depositionsavin → PAID (status-guardad) så den inte
        // ligger kvar som obetald/bankmatchbar.
        await tx.rentNotice.updateMany({
          where: {
            id: deposit.rentNoticeId,
            organizationId,
            status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
          },
          data: { status: 'PAID', paidAt: now },
        })
      } else {
        // Deposition utan länkad faktura ELLER avi (registrerad utanför de två
        // flödena) — inget att bokföra, men statusen ska claimas som förut.
        await claimaDeposition()
      }

      return tx.deposit.findFirstOrThrow({ where: { id, organizationId }, include: INCLUDE })
    })
  }

  // ── Återbetalning ───────────────────────────────────────────────────────────

  async refund(id: string, dto: RefundDepositDto, organizationId: string, userId: string) {
    const deposit = await this.findOne(id, organizationId)

    if (deposit.status !== 'PAID' && deposit.status !== 'REFUND_PENDING') {
      throw new BadRequestException('Bara betalda depositioner kan återbetalas')
    }

    const total = Number(deposit.amount)
    const deductions = (dto.deductions ?? []) as DepositDeduction[]
    const deductionsTotal = deductions.reduce((sum, d) => sum + Number(d.amount), 0)

    if (dto.refundAmount < 0) {
      throw new BadRequestException('Återbetalningsbelopp får inte vara negativt')
    }
    if (deductionsTotal < 0) {
      throw new BadRequestException('Avdrag får inte vara negativa')
    }

    const sum = Number((dto.refundAmount + deductionsTotal).toFixed(2))
    if (Math.abs(sum - total) > 0.01) {
      throw new BadRequestException(
        `Återbetalning + avdrag (${sum.toFixed(2)}) måste matcha depositionsbeloppet (${total.toFixed(2)})`,
      )
    }

    const newStatus: DepositStatus =
      dto.refundAmount === 0
        ? 'FORFEITED'
        : deductionsTotal === 0
          ? 'REFUNDED'
          : 'PARTIALLY_REFUNDED'

    const now = new Date()
    // #25/T2.2: statusbytet OCH återbetalningsverifikatet i SAMMA transaktion.
    // Uteblir verifikatet (t.ex. saknat konto 3040 för skadeavdrag efter att
    // 1510-fallbacken tagits bort) kastar vi → hela återbetalningen rullas
    // tillbaka. Tidigare loggades bokföringsfel bara → depositionen kunde stå
    // som REFUNDED/FORFEITED medan 2890-skulden aldrig reverserades (BFL 5:6).
    return this.prisma.$transaction(async (tx) => {
      // Status-gardad claim (samma mönster som markPaid) — race-säker mot ett
      // samtidigt refund-anrop. Utan den kan en andra samtidig transaktion skriva
      // över refundAmount/deductions/status EFTER att den första committat, medan
      // idempotensnyckeln (deposit-refund:<id>) bara låter ETT verifikat skapas →
      // Deposit-fälten skulle divergera från det faktiskt bokförda verifikatet.
      const claim = await tx.deposit.updateMany({
        where: { id, organizationId, status: { in: ['PAID', 'REFUND_PENDING'] } },
        data: {
          status: newStatus,
          refundedAt: now,
          refundAmount: dto.refundAmount,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
      })
      if (claim.count === 0) {
        throw new ConflictException(
          'Depositionen är redan reglerad — uppdatera sidan och försök igen',
        )
      }

      const entry = await this.accounting.createJournalEntryForDepositRefund(
        id,
        organizationId,
        dto.refundAmount,
        deductionsTotal,
        now,
        userId,
        tx,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Återbetalningsverifikat kunde inte skapas för deposition ${id} — ` +
            'kontrollera att kontoplanen innehåller konto 2890 och 1930, samt konto 3040 ' +
            'om avdrag för skada anges.',
        )
      }

      return tx.deposit.findFirstOrThrow({ where: { id, organizationId }, include: INCLUDE })
    })
  }

  // ── Lease-uppsägning sätter REFUND_PENDING ──────────────────────────────────

  async markRefundPendingForLease(leaseId: string, organizationId: string): Promise<void> {
    const deposit = await this.prisma.deposit.findFirst({
      where: { leaseId, organizationId, status: 'PAID' },
      select: { id: true },
    })
    if (!deposit) return

    await this.prisma.deposit.update({
      where: { id: deposit.id },
      data: { status: 'REFUND_PENDING' },
    })
  }

  // #73 catch-up: läker en PAID-deposition på ett redan TERMINATED-kontrakt som av
  // någon anledning (transient DB-fel i terminateExpiredNoticeLeases best-effort-
  // anropet) aldrig flaggades REFUND_PENDING vid utflytt. Utan denna dagliga sweep
  // fanns ingen självläkning — depositionen kunde hänga permanent i PAID efter
  // avflytt (hyresjurist-fynd). Idempotent (updateMany med statusfilter).
  async sweepTerminatedLeasesForRefundPending(): Promise<number> {
    const res = await this.prisma.deposit.updateMany({
      where: { status: 'PAID', lease: { status: 'TERMINATED' } },
      data: { status: 'REFUND_PENDING' },
    })
    if (res.count > 0) {
      this.logger.log(
        `[deposit-refund-sweep] ${res.count} deposition(er) på TERMINATED-kontrakt flaggade REFUND_PENDING`,
      )
    }
    return res.count
  }

  // ── Cron-hjälpare: påminn om depositioner som väntat >30d på återbetalning ─

  async remindStaleRefundPending(): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    const stale = await this.prisma.deposit.findMany({
      where: {
        status: 'REFUND_PENDING',
        updatedAt: { lt: cutoff },
      },
      include: { lease: { include: { unit: true } } },
    })

    let sent = 0
    for (const deposit of stale) {
      const days = Math.floor((Date.now() - deposit.updatedAt.getTime()) / 86_400_000)
      try {
        await this.notifications.createForAllOrgUsers(
          deposit.organizationId,
          'SYSTEM',
          'Deposition väntar på återbetalning',
          `Deposition för ${deposit.lease.unit.name} har väntat på återbetalning i ${days} dagar.`,
          { relatedEntityType: 'DEPOSIT', relatedEntityId: deposit.id },
        )
        sent++
      } catch (err) {
        this.logger.error(`Reminder failed for deposit ${deposit.id}: ${String(err)}`)
      }
    }
    return sent
  }
}
