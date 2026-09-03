import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, RentNoticeType } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { computeRentDebt } from './rent-debt.service'
import { CreateRentNoticeCreditDto } from './dto/create-rent-notice-credit.dto'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

/**
 * En post på avin som går att kreditera, med sitt kumulativa tak.
 *
 * `sourceId` är verifikatnyckeln för posten som EN GÅNG bokförde fordran.
 * Krediteringens verifikat speglar just den posten och kan därför per
 * konstruktion inte träffa ett konto originalet inte använde — se
 * `AccountingService.createJournalEntryForRentNoticeCredit`.
 */
export interface CreditBucket {
  /** null = hyreskapitalet (`RentNotice.totalAmount`), annars avi-radens id. */
  rentNoticeLineId: string | null
  description: string
  sourceId: string
  /** Postens bruttobelopp som det debiterades. */
  invoiced: number
  /** Vad som redan krediterats av just den här posten, över ALLA krediteringar. */
  credited: number
  /** Taket för en ny kreditering av posten. Aldrig negativt. */
  remaining: number
  /** Momsbärande poster är spärrade tills momsfrågan är besvarad (#370, #535). */
  vatBearing: boolean
}

/**
 * KAN DEN HÄR AVIN KREDITERAS, OCH OM INTE — VARFÖR?
 *
 * EN källa för både spärren och gränssnittet, samma form som
 * `assessCreditability` på fakturasidan (#529). `createCredit` kastar på
 * `reason`; `getPreview` visar samma sträng, så UI:t kan förklara varför
 * knappen är stängd i stället för att gömma den.
 *
 * VARFÖR DET MÅSTE VARA SAMMA FUNKTION: skulle gränssnittet härleda sina egna
 * villkor glider de isär vid första regeländringen, och resultatet är antingen
 * en knapp som erbjuder något API:et nekar, eller en gömd knapp för något som
 * faktiskt går. Båda får operatören att tro fel saker om systemet.
 *
 * REN OCH SYNKRON. Allt den behöver veta skickas in — inklusive
 * `exportedToCollection`, som kräver en DB-läsning hos anroparen. Det gör
 * regeluppsättningen testbar utan Prisma och håller den på ETT ställe.
 *
 * Skälen är skrivna för en människa som ska förstå vad hen ska göra i stället,
 * inte för en utvecklare. Inga ärendenummer i texten (vaktad av
 * no-issue-refs-in-user-text.spec.ts).
 */
export function assessRentNoticeCreditability(
  notice: {
    noticeNumber: string
    type: RentNoticeType
    status: string
    vatAmount: Prisma.Decimal | number
    probableLossAt: Date | null
    writtenOffAt: Date | null
    payments: Array<unknown>
    exportedToCollection: boolean
  },
  debt: { ocrOutstanding: number },
): { allowed: boolean; reason: string | null } {
  // ── DEPOSITION ────────────────────────────────────────────────────────────
  //
  // En deposition är ingen kravavi: den ägs av depositionsflödets 1510/2890-
  // bokföring och ingår aldrig i kravtrappan. `computeRentDebt` kortsluter
  // därför till nollor för DEPOSIT, vilket betyder att skuldgrinden nedan inte
  // säger något meningsfullt om den. Att kreditera här hade bokfört mot ett
  // konto depositionen inte använder.
  if (notice.type === RentNoticeType.DEPOSIT) {
    return {
      allowed: false,
      reason:
        'Det här är en depositionsavi och krediteras inte här. ' +
        'Hantera den genom depositionsflödet — återbetalning eller avräkning.',
    }
  }

  if (notice.status === 'CANCELLED') {
    return {
      allowed: false,
      reason:
        `Avi ${notice.noticeNumber} är annullerad — intäkten är redan reverserad i sin helhet. ` +
        'En kreditering ovanpå det skulle bokföra bort samma intäkt två gånger.',
    }
  }

  // ── NEDSKRIVEN FORDRAN ────────────────────────────────────────────────────
  //
  // Samma spärr, och samma skäl, som i `cancelNotice`: nedskrivningen har redan
  // tömt 1510 för den här fordran (1515 D / 1510 K på HELA kravet). En
  // kreditering krediterar 1510 en andra gång och lämnar ett negativt
  // kundfordringssaldo bredvid en öppen nedskrivning av en fordran som formellt
  // inte längre finns. Varje enskilt verifikat balanserar — felet uppstår först
  // i sekvensen, vilket är precis varför ingen verifikat-kontroll fångar det.
  //
  // GRINDEN LIGGER PÅ FÄLTEN, ALDRIG PÅ STATUS: `WRITTEN_OFF` är ett värde i
  // `RentCollectionStage`, inte i `RentNoticeStatus`, så en avskriven avi står
  // kvar som OVERDUE och glider rakt genom en statusbaserad kontroll.
  if (notice.probableLossAt != null || notice.writtenOffAt != null) {
    return {
      allowed: false,
      reason:
        `Avi ${notice.noticeNumber} kan inte krediteras — fordran är bokförd som kundförlust. ` +
        'En kreditering skulle kreditera kundfordringar en andra gång. ' +
        'Hantera fordran via kundförlust-flödet i stället.',
    }
  }

  // ── ÖVERLÄMNAD TILL INKASSO ───────────────────────────────────────────────
  //
  // Inkassobolaget har fått underlag på hela beloppet. Krediterar vi här sjunker
  // skulden i vårt system medan kravet utanför står kvar oförändrat — någon
  // jagas då för pengar de inte längre är skyldiga, och vi ser det inte,
  // eftersom vår egen siffra ser rätt ut.
  //
  // VARFÖR SPÄRR OCH INTE ÅTERKALLNING: det finns ingen återkallningsväg att
  // anropa. Uppmätt i kodbasen — avi-sidans inkassomodul har export och
  // bulk-export, ingenting som drar tillbaka ett överlämnat underlag, och till
  // skillnad från fakturan bär avin inte ens ett fält för överlämningen.
  // Detektionen går därför via exportens egen händelse.
  if (notice.exportedToCollection) {
    return {
      allowed: false,
      reason:
        `Underlag för avi ${notice.noticeNumber} har lämnats över till inkasso och avin kan inte ` +
        'krediteras här. Kravet måste först hanteras hos inkassobolaget — annars fortsätter de ' +
        'driva in ett belopp som hyresgästen inte är skyldig. Systemet har ingen väg att ' +
        'återkalla ett överlämnat krav.',
    }
  }

  // ── BETALD ELLER DELBETALD ────────────────────────────────────────────────
  //
  // Grinden nyckas på FAKTISKA allokeringar, inte på status. Samma kalibrering
  // som på fakturasidan, och av samma skäl: statusen kan släpa efter pengarna.
  if (notice.payments.length > 0) {
    return {
      allowed: false,
      reason:
        `Avi ${notice.noticeNumber} har en registrerad betalning och kan inte krediteras. ` +
        'En kreditering av en betald avi ger ett tillgodohavande till hyresgästen — en skuld ' +
        'som måste bokföras och sedan regleras eller betalas tillbaka. Den hanteringen är inte ' +
        'byggd. Avmatcha eller återbetala betalningen först.',
    }
  }

  // ── MOMSBÄRANDE AVI ───────────────────────────────────────────────────────
  //
  // Bostadshyra är momsfri, men avin kan avse lokal eller parkering med frivillig
  // skattskyldighet. Att sätta ned utgående moms är oåterkalleligt i den meningen
  // att en felaktigt rättad moms inte rättas gratis, och rättsläget för
  // nedsättningen är inte fastställt. Samma hållning som nedskrivningen redan
  // har: momspliktiga fordringar hoppas över och väntar på revisor.
  if (Number(notice.vatAmount) > 0) {
    return {
      allowed: false,
      reason:
        `Avi ${notice.noticeNumber} bär utgående moms och kan inte krediteras automatiskt. ` +
        'Att sätta ned bokförd moms kräver ett ställningstagande som inte är fattat — ' +
        'hantera nedsättningen manuellt tillsammans med din redovisningskonsult.',
    }
  }

  if (debt.ocrOutstanding <= 0) {
    return {
      allowed: false,
      reason: `Avi ${notice.noticeNumber} har ingenting kvar att kreditera.`,
    }
  }

  return { allowed: true, reason: null }
}

/**
 * KREDITERING AV HYRESAVI — den OBETALDA vägen (#518).
 *
 * ENDA VÄGEN IN. En `RentNoticeCredit` skrivs på exakt ett ställe i kodbasen,
 * och `rent-notice-credit-guard.spec.ts` sveper produktionskoden och faller om
 * en andra skrivare dyker upp: en kreditering utan verifikat är ett belopp som
 * försvinner ur skuldberäkningen utan motsvarighet i huvudboken.
 *
 * ── VARFÖR KREDITERING OCH `CANCELLED` BÅDA FINNS ─────────────────────────────
 *
 * Annullering ("avin skulle aldrig ha funnits") och nedsättning ("beloppet var
 * för högt") är olika affärshändelser, och historiken ska kunna skilja dem åt.
 * De överlappar inte heller i praktiken: `cancelNotice` är redan spärrad mot
 * betald avi, delbetald avi och nedskriven fordran. Krediteringen KOMPLETTERAR
 * alltså `CANCELLED` och ersätter den inte — inget i annulleringens beteende
 * ändras av den här klassen.
 *
 * ── VAD SOM INTE ÄR BYGGT, OCH VARFÖR DET ÄR SPÄRRAT I STÄLLET FÖR HALVBYGGT ──
 *
 * Kreditering av en BETALD eller DELBETALD avi ingår inte. På en obetald avi är
 * kundfordran (1510) fortfarande öppen och krediteringen går rakt mot den. Har
 * betalning kommit in är 1510 redan reglerad, och en kreditering skulle i
 * stället skapa ett TILLGODOHAVANDE — en skuld till hyresgästen på ett
 * 2xxx-konto. Vilket konto det ska vara är inte fastställt, och valet låses i
 * praktiken av den första kreditering som bokförs. Att gissa här vore att fatta
 * beslutet i tysthet.
 *
 * Momsbärande avier är spärrade av motsvarande skäl: nedsättning av bokförd
 * utgående moms kräver ett ställningstagande som inte är fattat.
 */
@Injectable()
export class RentNoticeCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: RentNoticeEventsService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Har underlag för avin lämnats över till inkasso?
   *
   * Avin saknar fält för överlämningen — till skillnad från `Invoice`, som bär
   * `sentToCollectionAt`. Exporten skriver i stället en append-only händelse med
   * `action` i sin payload, och det är den enda kvarvarande spåren. Båda
   * varianterna (enskild och bulk) måste med; en uppräkning som missar den ena
   * gör spärren tyst overksam för halva vägen in.
   */
  private async exportedToCollection(noticeId: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma
    const träff = await db.rentNoticeEvent.findFirst({
      where: {
        rentNoticeId: noticeId,
        type: 'NOTE_ADDED',
        OR: [
          { payload: { path: ['action'], equals: 'inkasso-export' } },
          { payload: { path: ['action'], equals: 'inkasso-export-bulk' } },
        ],
      },
      select: { id: true },
    })
    return träff !== null
  }

  /**
   * Posterna på avin och deras kumulativa tak.
   *
   * VARFÖR SERVERN RÄKNAR DET HÄR OCH INTE KLIENTEN: taket är kumulativt över
   * alla tidigare krediteringar, och den summan finns bara i databasen. En
   * klient som gissade "återstår = postens belopp" hade föreslagit belopp som
   * API:et sedan avvisar — operatören hade fått ett felmeddelande för något
   * gränssnittet självt föreslog.
   */
  private buckets(
    notice: {
      id: string
      totalAmount: Prisma.Decimal
      vatAmount: Prisma.Decimal
      month: number
      year: number
      lines: Array<{
        id: string
        description: string
        total: Prisma.Decimal
        vatRate: number
        consumptionChargeId: string | null
        miscChargeId: string | null
      }>
    },
    krediteratPerPost: Map<string, Prisma.Decimal>,
  ): CreditBucket[] {
    const bygg = (
      rentNoticeLineId: string | null,
      description: string,
      sourceId: string,
      invoiced: Prisma.Decimal,
      vatBearing: boolean,
    ): CreditBucket => {
      const credited = krediteratPerPost.get(rentNoticeLineId ?? KAPITAL) ?? new Prisma.Decimal(0)
      const kvar = invoiced.minus(credited)
      return {
        rentNoticeLineId,
        description,
        sourceId,
        invoiced: invoiced.toNumber(),
        credited: credited.toNumber(),
        remaining: kvar.isNegative() ? 0 : kvar.toNumber(),
        vatBearing,
      }
    }

    const ut: CreditBucket[] = [
      bygg(
        null,
        `Hyra ${notice.month}/${notice.year}`,
        `rent-notice:${notice.id}`,
        notice.totalAmount,
        Number(notice.vatAmount) > 0,
      ),
    ]

    for (const rad of notice.lines) {
      // ── EN RAD UTAN BOKFÖRD KÄLLA GÅR INTE ATT KREDITERA ──────────────────
      //
      // Förbruknings- och övriga debiteringsposter bokförs av EGNA verifikat
      // (`consumption-charge:<id>` resp. `misc-charge:<id>`), och det är dem
      // krediteringen speglar. En rad utan någon av kopplingarna har ingen
      // bokförd fordran att spegla — och ingår inte heller i
      // `consumptionAmount`/`miscChargeAmount`, alltså inte i den betalbara
      // totalen. Den utelämnas därför helt i stället för att erbjudas med ett
      // tak som inte motsvarar något.
      const sourceId = rad.consumptionChargeId
        ? `consumption-charge:${rad.consumptionChargeId}`
        : rad.miscChargeId
          ? `misc-charge:${rad.miscChargeId}`
          : null
      if (!sourceId) continue
      ut.push(bygg(rad.id, rad.description, sourceId, rad.total, rad.vatRate > 0))
    }

    return ut
  }

  /** Summerar tidigare krediteringar per post (kapital resp. avi-rad). */
  private async krediteratPerPost(noticeId: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma
    const rader = await db.rentNoticeCreditLine.findMany({
      where: { credit: { rentNoticeId: noticeId } },
      select: { rentNoticeLineId: true, amount: true },
    })
    const karta = new Map<string, Prisma.Decimal>()
    for (const rad of rader) {
      const nyckel = rad.rentNoticeLineId ?? KAPITAL
      karta.set(nyckel, (karta.get(nyckel) ?? new Prisma.Decimal(0)).plus(rad.amount))
    }
    return karta
  }

  /**
   * UNDERLAGET GRÄNSSNITTET FÖRFYLLER SIG FRÅN.
   *
   * Ren läsning. Ingen transaktion, inget radlås: siffrorna är ett förslag att
   * visa, och det bindande beslutet tas av `createCredit`, som läser om allt
   * under lås. Skulle något ändras däremellan är det skrivningen som gäller.
   *
   * ── `proposedAmount`: RÄNTEFALLET AVGÖRS HÄR, INTE I KLIENTEN ──────────────
   *
   * Gränssnittet måste kunna säga, INNAN operatören bekräftar, att den här
   * krediteringen tömmer kapitalet men lämnar dröjsmålsränta kvar — och att
   * avin då stannar och väntar på hennes beslut i stället för att gå vidare i
   * kravtrappan.
   *
   * Att räkna ut det i React hade betytt att regeln fanns på två ställen. Den
   * skulle glida isär vid första ändringen, och glidningen syns inte: båda
   * sidor visar ett tal, bara olika. Klienten skickar därför sin tänkta SUMMA
   * och får tillbaka utfallet ur `computeRentDebt` — samma funktion som
   * kravtrappan, inkassoexporten och nedskrivningen läser.
   *
   * Beloppet KLAMPAS mot vad som faktiskt går att kreditera. Utan det kan en
   * godtycklig summa i frågesträngen rendera en projektion som inte motsvarar
   * någon kreditering `createCredit` skulle acceptera.
   */
  async getPreview(noticeId: string, organizationId: string, proposedAmount?: number) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      include: {
        lines: { orderBy: { id: 'asc' } },
        payments: { select: { amount: true } },
        // Krediteringarna läses HELA — inte bara beloppen. Avi-detaljen ska
        // visa vad som krediterats, varför och när; ett skäl som bara finns i
        // händelseloggen är i praktiken osynligt för operatören.
        credits: {
          orderBy: { creditedAt: 'desc' },
          select: {
            id: true,
            amount: true,
            reason: true,
            creditedAt: true,
            lines: {
              orderBy: { id: 'asc' },
              select: { id: true, rentNoticeLineId: true, description: true, amount: true },
            },
          },
        },
      },
    })
    if (!notice) throw new NotFoundException('Hyresavi hittades inte')

    const debt = computeRentDebt({
      type: notice.type,
      totalAmount: notice.totalAmount,
      consumptionAmount: notice.consumptionAmount,
      miscChargeAmount: notice.miscChargeAmount,
      reminderFeeAmount: notice.reminderFeeAmount,
      interestAccruedAmount: notice.interestAccruedAmount,
      allocations: notice.payments.map((p) => p.amount),
      credits: notice.credits.map((c) => c.amount),
    })

    const bedömning = assessRentNoticeCreditability(
      { ...notice, exportedToCollection: await this.exportedToCollection(noticeId) },
      debt,
    )

    const buckets = this.buckets(notice, await this.krediteratPerPost(noticeId))

    // Taket för hela avin: summan av vad varje post har kvar. Klampningen nedan
    // vilar på det, och gränssnittet visar det som "går att kreditera nu".
    const creditableNow = round2(buckets.reduce((s, b) => s + b.remaining, 0))

    return {
      rentNoticeId: notice.id,
      noticeNumber: notice.noticeNumber,
      payableTotal: debt.ocrOutstanding + debt.credited,
      outstanding: debt.ocrOutstanding,
      credited: debt.credited,
      allowed: bedömning.allowed,
      blockedReason: bedömning.reason,
      buckets,
      creditableNow,
      /**
       * NULÄGET, ur samma helper som kravtrappan läser. Avi-detaljen ska kunna
       * visa den BERÄKNADE skulden — inte `totalAmount`, som är bruttot och
       * blir fel i samma sekund något krediteras.
       */
      debt: {
        capital: debt.capital,
        consumption: debt.consumption,
        miscCharge: debt.miscCharge,
        reminderFee: debt.reminderFee,
        interest: debt.interest,
        paid: debt.paid,
        credited: debt.credited,
        outstanding: debt.outstanding,
        ocrOutstanding: debt.ocrOutstanding,
        interestOnlyAfterCredit: debt.interestOnlyAfterCredit,
      },
      /** Kravtrappans läge. Nödvändigt för att kunna säga VAD som stannat. */
      collectionStage: notice.collectionStage,
      credits: notice.credits.map((c) => ({
        id: c.id,
        amount: c.amount.toNumber(),
        reason: c.reason,
        creditedAt: c.creditedAt,
        lines: c.lines.map((r) => ({
          id: r.id,
          rentNoticeLineId: r.rentNoticeLineId,
          description: r.description,
          amount: r.amount.toNumber(),
        })),
      })),
      /**
       * UTFALLET AV DEN TÄNKTA KREDITERINGEN. `null` när klienten inte frågat.
       *
       * Räknas med `computeRentDebt` och inte med subtraktion i klienten, av
       * skälet i docblocket ovan: `interestOnlyAfterCredit` är en regel, inte
       * en differens, och den regeln ska bara finnas på ett ställe.
       */
      projection:
        proposedAmount === undefined
          ? null
          : this.projicera(notice, debt, creditableNow, proposedAmount),
    }
  }

  /**
   * Vad blir skuldläget om `önskat` krediteras?
   *
   * `applied` är det klampade beloppet och skickas MED i svaret: bad klienten om
   * mer än som går att kreditera ska projektionen inte tyst gälla ett annat tal
   * än det som visas.
   */
  private projicera(
    notice: {
      type: RentNoticeType
      totalAmount: Prisma.Decimal
      consumptionAmount: Prisma.Decimal
      miscChargeAmount: Prisma.Decimal
      reminderFeeAmount: Prisma.Decimal
      interestAccruedAmount: Prisma.Decimal
      payments: Array<{ amount: Prisma.Decimal }>
      credits: Array<{ amount: Prisma.Decimal }>
    },
    debtNow: { outstanding: number; ocrOutstanding: number },
    creditableNow: number,
    önskat: number,
  ) {
    const applied = round2(Math.min(Math.max(önskat, 0), creditableNow))
    const efter = computeRentDebt({
      type: notice.type,
      totalAmount: notice.totalAmount,
      consumptionAmount: notice.consumptionAmount,
      miscChargeAmount: notice.miscChargeAmount,
      reminderFeeAmount: notice.reminderFeeAmount,
      interestAccruedAmount: notice.interestAccruedAmount,
      allocations: notice.payments.map((p) => p.amount),
      credits: [...notice.credits.map((c) => c.amount), applied],
    })
    return {
      requested: round2(önskat),
      applied,
      outstandingBefore: debtNow.outstanding,
      ocrOutstandingBefore: debtNow.ocrOutstanding,
      outstanding: efter.outstanding,
      ocrOutstanding: efter.ocrOutstanding,
      interest: efter.interest,
      credited: efter.credited,
      /** Kapitalet bortkrediterat, ränta kvar → kravtrappan stannar. */
      interestOnlyAfterCredit: efter.interestOnlyAfterCredit,
    }
  }

  async createCredit(
    noticeId: string,
    organizationId: string,
    actorId: string,
    dto: CreateRentNoticeCreditDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // ── RADLÅS FÖRST ────────────────────────────────────────────────────────
      //
      // Grinden nedan läser allokeringar och fattar ett beslut på dem. Utan lås
      // kan en samtidig `markAsPaid` eller bankmatchning skriva en allokering
      // mellan läsningen och skrivningen — och då bokförs en kreditering mot
      // 1510 på en fordran som just reglerats, alltså exakt det tillgodohavande
      // spärren finns för att förhindra.
      //
      // LÅSORDNING: RentNotice först, samma riktning som alla andra vägar
      // (annullering, betalning, bankmatchning). Att bryta den ordningen är hur
      // två transaktioner sluter en cirkel mot varandra.
      await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${organizationId} FOR UPDATE`

      const notice = await tx.rentNotice.findFirst({
        where: { id: noticeId, organizationId },
        include: {
          lines: true,
          payments: { select: { amount: true } },
          credits: { select: { amount: true } },
        },
      })
      if (!notice) throw new NotFoundException('Hyresavi hittades inte')

      const debtBefore = computeRentDebt({
        type: notice.type,
        totalAmount: notice.totalAmount,
        consumptionAmount: notice.consumptionAmount,
        miscChargeAmount: notice.miscChargeAmount,
        reminderFeeAmount: notice.reminderFeeAmount,
        interestAccruedAmount: notice.interestAccruedAmount,
        allocations: notice.payments.map((p) => p.amount),
        credits: notice.credits.map((c) => c.amount),
      })

      // SAMMA bedömning som `getPreview` visar för gränssnittet. Två
      // uppsättningar regler hade oundvikligen glidit isär.
      const bedömning = assessRentNoticeCreditability(
        { ...notice, exportedToCollection: await this.exportedToCollection(noticeId, tx) },
        debtBefore,
      )
      if (!bedömning.allowed) throw new BadRequestException(bedömning.reason)

      const poster = new Map(
        this.buckets(notice, await this.krediteratPerPost(noticeId, tx)).map((b) => [
          b.rentNoticeLineId ?? KAPITAL,
          b,
        ]),
      )

      // ── EN POST FÅR INTE KREDITERAS TVÅ GÅNGER I SAMMA ANROP ───────────────
      //
      // Utan den här kontrollen prövas varje rad var för sig mot postens tak,
      // och två rader på 600 kr mot en post på 1 000 kr passerar båda — 1 200 kr
      // krediterat på en post som var på 1 000. Det kumulativa taket fångar det
      // först vid NÄSTA kreditering, alltså för sent.
      const sedda = new Set<string>()
      const kreditrader: Array<{
        rentNoticeLineId: string | null
        amount: Prisma.Decimal
        sourceId: string
        description: string
      }> = []

      for (const rad of dto.lines) {
        const nyckel = rad.rentNoticeLineId ?? KAPITAL
        const post = poster.get(nyckel)
        if (!post) {
          throw new BadRequestException(
            `Posten finns inte på avi ${notice.noticeNumber} och kan inte krediteras.`,
          )
        }
        if (sedda.has(nyckel)) {
          throw new BadRequestException(
            `Posten "${post.description}" förekommer flera gånger i samma kreditering. ` +
              'Ange en rad per post med det sammanlagda beloppet.',
          )
        }
        sedda.add(nyckel)

        if (post.vatBearing) {
          throw new BadRequestException(
            `Posten "${post.description}" bär moms och kan inte krediteras automatiskt. ` +
              'Att sätta ned bokförd moms kräver ett ställningstagande som inte är fattat — ' +
              'hantera nedsättningen manuellt tillsammans med din redovisningskonsult.',
          )
        }

        // ── POSTNIVÅ-TAKET, KUMULATIVT ────────────────────────────────────────
        //
        // Skälet är SPÅRBARHET. 8 000 kr krediterade på en post om 1 000 kr kan
        // rymmas under avins totala obetalda belopp — men verifikationskedjan går
        // då inte att följa tillbaka till vad som faktiskt debiterades på just
        // den posten, vilket är vad en granskare förväntar sig kunna göra.
        //
        // KUMULATIVT mot tidigare krediteringar av samma post: utan det kan samma
        // 1 000-kronorspost krediteras med 1 000 kr i två omgångar, var för sig
        // inom taket, tillsammans dubbelt så mycket som posten var på.
        const begärt = new Prisma.Decimal(rad.amount)
        const kvar = new Prisma.Decimal(post.remaining)
        if (begärt.greaterThan(kvar)) {
          const överskott = begärt.minus(kvar)
          const redanText =
            post.credited > 0
              ? ` (${post.credited.toFixed(2)} kr av posten är redan krediterat)`
              : ''
          throw new BadRequestException(
            `Posten "${post.description}" krediteras med ${begärt.toFixed(2)} kr men högst ` +
              `${kvar.toFixed(2)} kr återstår att kreditera på den${redanText} — ` +
              `${överskott.toFixed(2)} kr för mycket. En kreditering får inte överstiga posten ` +
              'den avser; annars går den inte att följa tillbaka till det som debiterades.',
          )
        }

        kreditrader.push({
          rentNoticeLineId: post.rentNoticeLineId,
          amount: begärt,
          sourceId: post.sourceId,
          description: post.description,
        })
      }

      const summa = kreditrader.reduce<Prisma.Decimal>(
        (s, r) => s.plus(r.amount),
        new Prisma.Decimal(0),
      )

      // ── TAKET MOT AVINS OBETALDA REST ─────────────────────────────────────
      //
      // Postnivå-taket är strängare i praktiken, men inte per konstruktion: en
      // påminnelseavgift ingår i den betalbara totalen utan att vara en
      // krediterbar post, och avgiften har dessutom en EGEN strykningsväg med
      // eget motverifikat. Kontrollen här är därför inte redundant utan det
      // andra lagret — och ett överskjutande belopp är exakt den väg som är
      // avgränsad bort: det blir ett tillgodohavande.
      if (summa.greaterThan(new Prisma.Decimal(debtBefore.ocrOutstanding))) {
        throw new BadRequestException(
          `Krediteringen (${summa.toFixed(2)} kr) överstiger avins obetalda belopp ` +
            `(${debtBefore.ocrOutstanding.toFixed(2)} kr). Ett överskjutande belopp blir ett ` +
            'tillgodohavande till hyresgästen, vilket kräver en egen bokföring och ' +
            'återbetalningshantering som inte är byggd. Kreditera högst det obetalda beloppet.',
        )
      }

      const creditedAt = new Date()
      const credit = await tx.rentNoticeCredit.create({
        data: {
          organizationId,
          rentNoticeId: notice.id,
          amount: summa,
          reason: dto.reason,
          creditedAt,
          createdById: actorId,
          lines: {
            createMany: {
              data: kreditrader.map((r) => ({
                rentNoticeLineId: r.rentNoticeLineId,
                description: r.description,
                amount: r.amount,
              })),
            },
          },
        },
        include: { lines: true },
      })

      // Verifikatet i SAMMA transaktion. Faller bokföringen ska nedsättningen
      // inte finnas — samma regel som för avins egen accrual.
      const entry = await this.accounting.createJournalEntryForRentNoticeCredit(
        {
          id: credit.id,
          amount: credit.amount,
          creditedAt,
          lines: kreditrader.map((r) => ({
            amount: r.amount,
            sourceId: r.sourceId,
            description: r.description,
          })),
        },
        { id: notice.id, noticeNumber: notice.noticeNumber },
        organizationId,
        actorId,
        tx,
      )

      const debtAfter = computeRentDebt({
        type: notice.type,
        totalAmount: notice.totalAmount,
        consumptionAmount: notice.consumptionAmount,
        miscChargeAmount: notice.miscChargeAmount,
        reminderFeeAmount: notice.reminderFeeAmount,
        interestAccruedAmount: notice.interestAccruedAmount,
        allocations: notice.payments.map((p) => p.amount),
        credits: [...notice.credits.map((c) => c.amount), credit.amount],
      })

      // ── STATUS RÖRS INTE — MEN KRAVSTEGET GÖR DET ─────────────────────────
      //
      // Den första halvan står kvar och är rätt: ingen ny STATUS, ingen flipp.
      // Skulden är ett BERÄKNAT tillstånd, `computeRentDebt` läser
      // krediteringarna, och en statuskolumn hade blivit ett andra muterbart
      // påstående om samma sak — precis den spegel som `paidAmount` fick rättad.
      //
      // `collectionStage` är INTE den sortens spegel. Den säger inte hur stor
      // skulden är utan VAR I KRAVTRAPPAN ärendet står, och det läget måste
      // lämnas aktivt. Att låta bli var inte en försiktighet utan en permanent
      // återvändsgränd, och den är uppmätt (#648):
      //
      //     en fullt krediterad avi i REMINDED, cronen körd tre dygn
      //       → stage REMINDED, tre NOTE_ADDED ("ingen utestående skuld att
      //         driva in"), state=BLOCKED i /collection-status
      //
      // Grinden faller på steg 10 i `checkInkassoReadiness`
      // (`rent-reminder.service.ts`, ocrOutstanding <= 0), så eskaleringen kan
      // aldrig ske — och kundförlust-cronen plockar bara
      // `collectionStage: 'INKASSO_READY'` (`rent-bad-debt.service.ts`), så
      // avskrivningen kan aldrig ske heller. Ingen cron tar ärendet ur loopen:
      // det blockeras varje dygn, för alltid, och skriver en append-only-rad
      // per dygn om saken.
      //
      // Manuell utväg finns inte heller: `cancelNotice` matchar bara rader med
      // `credits: { none: {} }` (`avisering.service.ts`) — en krediterad avi
      // kan alltså inte annulleras.
      //
      // BETALVÄGARNA GÖR REDAN EXAKT DET HÄR, i samma update som statusen:
      // `reconciliation.service.ts` (enskild match och vattenfall) och
      // `avisering.service.ts` (manuell markering). En delbetalning som lämnar
      // skuld kvar rör inte steget — samma gräns gäller här: en DELKREDIT
      // lämnar `collectionStage` orört.
      //
      // `interestOnlyAfterCredit` (kapitalet bortkrediterat, ränta kvar) ingår
      // MED FLIT i utträdet. Kravtrappan kan ändå aldrig gå vidare på ren
      // restränta — `ocrOutstanding` exkluderar ränta av ett uttryckligt val
      // (`rent-debt.service.ts`) — så att lämna avin i REMINDED är inte att
      // "vänta på ett människobeslut", det är samma permanenta blockering som
      // ovan. Räntefordran finns kvar och syns i skuldunderlaget.
      //
      // INGET EGET EVENT: ingen av betalvägarna skriver ett för utträdet, och
      // en ny händelsetyp för samma sak hade gjort historiken oense med
      // fakturasidan. `CREDITED` skrivs ändå nedan och bär flaggan i sin
      // payload, så utträdet går att fråga efter.
      const lämnarKravtrappan =
        debtAfter.ocrOutstanding <= 0 &&
        notice.collectionStage !== 'NONE' &&
        notice.collectionStage !== 'WRITTEN_OFF'

      if (lämnarKravtrappan) {
        // Villkorad updateMany, inte update: `organizationId` som
        // defense-in-depth (samma form som annulleringen), och steget i
        // where-satsen så att en samtidig eskalering inte skrivs över av ett
        // beslut som fattades på en äldre läsning.
        await tx.rentNotice.updateMany({
          where: {
            id: notice.id,
            organizationId,
            collectionStage: { notIn: ['NONE', 'WRITTEN_OFF'] },
          },
          data: { collectionStage: 'NONE' },
        })
      }

      await this.events.record(
        notice.id,
        'CREDITED',
        'USER',
        actorId,
        {
          creditId: credit.id,
          amount: summa.toNumber(),
          reason: dto.reason,
          journalEntryId: entry?.id ?? null,
          // Utträdet ur kravtrappan, om det skedde. Se blocket ovan: ingen egen
          // händelsetyp, men frågan ska gå att ställa mot loggen.
          collectionStageCleared: lämnarKravtrappan,
          lines: kreditrader.map((r) => ({
            rentNoticeLineId: r.rentNoticeLineId,
            description: r.description,
            amount: r.amount.toNumber(),
          })),
        },
        { tx },
      )

      return {
        credit,
        rentNotice: {
          id: notice.id,
          noticeNumber: notice.noticeNumber,
          // Restskulden EFTER krediteringen, ur samma helper som kravtrappan
          // läser. Anroparen ska aldrig behöva räkna ut den själv.
          outstanding: debtAfter.ocrOutstanding,
          // Se `RentDebtBreakdown.interestOnlyAfterCredit`: kapitalet är
          // bortkrediterat men ränta står kvar. Avin har då LÄMNAT kravtrappan
          // (blocket ovan) — den kunde ändå aldrig eskalera på ren restränta —
          // och räntefordran står kvar som en egen post för ett människobeslut.
          interestOnlyAfterCredit: debtAfter.interestOnlyAfterCredit,
        },
      }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }
}

/**
 * Öresavrundning. Samma form som beräkningslagret i `rent-debt.service.ts` —
 * summorna här är redan avrundade tal ur `computeRentDebt`, men en summering av
 * dem kan ändå bära ett flyttalsspår, och det talet visas för en operatör.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Nyckeln för hyreskapitalet i post-kartorna. En sträng som inte kan kollidera
 * med ett UUID — avi-radernas id:n är uuid v4, och `null` går inte att använda
 * som Map-nyckel tillsammans med strängar utan att typen blir otydlig.
 */
const KAPITAL = 'capital'
