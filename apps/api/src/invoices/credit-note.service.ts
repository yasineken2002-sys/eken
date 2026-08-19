import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { InvoiceEventsService } from './invoice-events.service'
import { allocateInvoiceNumber } from './invoice-number'
import { computeInvoiceAmounts } from './invoice-amounts'
import { computeInvoiceDebt } from './invoice-debt'
import { CreateCreditNoteDto } from './dto/create-credit-note.dto'

/**
 * KREDITNOTA PÅ FAKTURA — den OBETALDA halvan (#517).
 *
 * ENDA VÄGEN IN. Kreditnotan är en Invoice-rad med `isCreditNote = true`, och
 * det finns med flit exakt en funktion i kodbasen som skriver den. Vakten
 * `credit-note-guard.spec.ts` sveper produktionskoden och faller om en andra
 * skrivare dyker upp: en kreditnota utan koppling till sitt original, eller
 * utan verifikat, är ett belopp som försvinner ur skuldberäkningen utan
 * härledning.
 *
 * ── VAD SOM INTE ÄR BYGGT, OCH VARFÖR DET ÄR SPÄRRAT I STÄLLET FÖR HALVBYGGT ──
 *
 * Kreditering av en BETALD eller DELBETALD faktura ingår inte. Skälet är
 * bokföringsmässigt och inte en tidsfråga: på en obetald faktura är
 * kundfordran (1510) fortfarande öppen och krediteringen går rakt mot den. Har
 * betalning kommit in är 1510 redan reglerad, och en kreditering skulle i
 * stället skapa ett TILLGODOHAVANDE — en skuld till hyresgästen på ett
 * 2xxx-konto. Vilket konto det ska vara är inte fastställt, och valet låses i
 * praktiken av den första kreditering som bokförs. Att gissa här vore att fatta
 * beslutet i tysthet.
 *
 * ── VAD SOM ÄR SPÄRRAT ────────────────────────────────────────────────────────
 *
 *   • faktura med registrerad betalning  → tillgodohavande, ej byggt
 *   • redan makulerad faktura            → intäkten är redan reverserad
 *   • en kreditnota                      → krediteringar krediteras inte
 *   • belopp över obetald rest           → tillgodohavande, ej byggt
 *
 * ── VAD SOM GÅR ───────────────────────────────────────────────────────────────
 *
 * Hel och delvis kreditering av en obetald faktura, upprepat, så länge summan
 * håller sig inom det obetalda beloppet.
 */
@Injectable()
export class CreditNoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: InvoiceEventsService,
    private readonly accountingService: AccountingService,
  ) {}

  async createCreditNote(
    invoiceId: string,
    organizationId: string,
    actorId: string,
    dto: CreateCreditNoteDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // ── RADLÅS FÖRST ────────────────────────────────────────────────────────
      //
      // Samma skäl som i transitionStatus (#302): grinden nedan läser
      // allokeringar och fattar ett beslut på dem. Utan lås kan en samtidig
      // `markAsPaidManually` eller bankmatchning skriva en allokering mellan
      // läsningen och skrivningen — och då bokförs en kreditering mot 1510 på
      // en fordran som just reglerats, alltså exakt den negativa kundfordran
      // som spärren finns för att förhindra.
      //
      // LÅSORDNING: Invoice först, samma riktning som alla andra vägar.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`

      const original = await tx.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        include: {
          lines: true,
          payments: { select: { amount: true } },
          creditNotes: { select: { total: true } },
        },
      })
      if (!original) throw new NotFoundException('Faktura hittades inte')

      if (original.isCreditNote) {
        throw new BadRequestException(
          'Dokumentet är redan en kreditnota och kan inte krediteras. ' +
            'Kreditera ursprungsfakturan i stället.',
        )
      }

      if (original.status === 'VOID') {
        throw new BadRequestException(
          'Fakturan är makulerad — intäkten är redan reverserad. ' +
            'En kreditnota ovanpå det skulle bokföra bort samma intäkt två gånger.',
        )
      }

      // ── ÖVERLÄMNAD TILL INKASSO: SPÄRRAD ───────────────────────────────────
      //
      // Inkassobolaget har fått ett krav på hela beloppet. Krediterar vi här
      // sjunker skulden i vårt system medan kravet utanför står kvar oförändrat
      // — någon jagas då för pengar de inte längre är skyldiga, och vi ser det
      // inte, eftersom vår egen siffra ser rätt ut.
      //
      // VARFÖR SPÄRR OCH INTE ÅTERKALLNING: det finns ingen återkallningsväg
      // att anropa. Uppmätt i kodbasen — `CollectionsModule` har export,
      // mark-sent och paus/återupptag av påminnelser, ingenting som drar
      // tillbaka ett överlämnat krav. `sentToCollectionAt` sätts på två ställen
      // och nollställs på inget. Statusmaskinen ger SENT_TO_COLLECTION exakt
      // två utgångar, PAID och VOID, och VOID är spärrad av allokeringsgrinden
      // så snart en betalning finns. Samma slutsats som redan står i
      // `reconciliation.service.ts` vid avmatchningsspärren.
      //
      // Att bygga återkallningen här vore att uppfinna ett flöde mot en extern
      // motpart utan att veta hur den motparten tar emot det. Meddelandet lovar
      // därför ingen väg som inte finns: det säger var kravet måste hanteras.
      if (original.status === 'SENT_TO_COLLECTION') {
        throw new BadRequestException(
          `Faktura ${original.invoiceNumber} är överlämnad till inkasso och kan inte ` +
            'krediteras här. Kravet måste först hanteras hos inkassobolaget — ' +
            'annars fortsätter de driva in ett belopp som hyresgästen inte är ' +
            'skyldig. Systemet har ingen väg att återkalla ett överlämnat krav.',
        )
      }

      // ── BETALD ELLER DELBETALD: SPÄRRAD ────────────────────────────────────
      //
      // Grinden nyckas på FAKTISKA allokeringar, inte på status. Samma
      // kalibrering som VOID-spärren, och av samma skäl: statusen kan släpa
      // efter pengarna.
      if (original.payments.length > 0) {
        throw new BadRequestException(
          'Fakturan har en registrerad betalning och kan inte krediteras. ' +
            'En kreditering av en betald faktura ger ett tillgodohavande till ' +
            'hyresgästen — en skuld som måste bokföras och sedan regleras eller ' +
            'betalas tillbaka. Den hanteringen är inte byggd.',
        )
      }

      // Obetald rest enligt den GEMENSAMMA sanningskällan, inte ett eget
      // uttryck. `paid` är noll här (spärren ovan), så resten är fakturans
      // belopp minus det som redan krediterats.
      const debtBefore = computeInvoiceDebt({
        total: original.total,
        allocations: original.payments.map((p) => p.amount),
        credits: original.creditNotes.map((c) => c.total),
      })

      if (debtBefore.outstanding.lte(0)) {
        throw new BadRequestException(
          `Faktura ${original.invoiceNumber} är redan fullt krediterad — det finns ingenting kvar att kreditera.`,
        )
      }

      // ── VAD SOM REDAN KREDITERATS PER RAD ──────────────────────────────────
      //
      // Summeras ur tidigare kreditnotors rader via `creditedInvoiceLineId`.
      // Utan den här summan skulle radtaket nedan gälla per kreditnota i
      // stället för kumulativt, och samma 1 000-kronorsrad kunde krediteras med
      // 1 000 kr två gånger — var för sig inom taket.
      const tidigareKreditrader = await tx.invoiceLine.findMany({
        where: {
          invoice: { creditedInvoiceId: original.id },
          creditedInvoiceLineId: { not: null },
        },
        select: { creditedInvoiceLineId: true, total: true },
      })
      const kredteratPerRad = new Map<string, Prisma.Decimal>()
      for (const rad of tidigareKreditrader) {
        const nyckel = rad.creditedInvoiceLineId!
        kredteratPerRad.set(
          nyckel,
          (kredteratPerRad.get(nyckel) ?? new Prisma.Decimal(0)).plus(rad.total),
        )
      }

      // ── RADERNA ÄRVER MOMSSATSEN FRÅN ORIGINALET ───────────────────────────
      const lineById = new Map(original.lines.map((l) => [l.id, l]))
      const creditLines = dto.lines.map((l) => {
        const source = lineById.get(l.invoiceLineId)
        if (!source) {
          throw new BadRequestException(
            `Raden finns inte på faktura ${original.invoiceNumber} och kan inte krediteras.`,
          )
        }
        return {
          description: l.description ?? source.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          // Ärvd, aldrig klientstyrd — se noten i CreditNoteLineDto.
          vatRate: source.vatRate,
          creditedInvoiceLineId: source.id,
        }
      })

      const amounts = computeInvoiceAmounts(creditLines)

      // ── RADNIVÅ-TAKET ──────────────────────────────────────────────────────
      //
      // Skälet är SPÅRBARHET, inte moms. 8 000 kr krediterade på en
      // 1 000-kronorsrad ger rätt momssats (den ärvs) och kan rymmas under
      // fakturans totala obetalda belopp — men verifikationskedjan går då inte
      // att följa tillbaka till vad som faktiskt fakturerades på just den
      // raden, vilket är vad en granskare förväntar sig kunna göra.
      //
      // Taket räknas KUMULATIVT mot tidigare krediteringar av samma rad, och
      // jämförs mot radens BRUTTObelopp (`total`), samma storhet som
      // kreditradens beräknade `total` — netto mot brutto hade gett ett tak som
      // var fel med momsen.
      //
      // OBS: detta AVVISAR krediteringar som gick igenom före den här
      // ändringen. Det är avsikten; en kreditering som överskrider raden var
      // aldrig spårbar, den var bara tillåten.
      for (let i = 0; i < creditLines.length; i++) {
        const rad = creditLines[i]!
        const belopp = amounts.lines[i]!
        const source = lineById.get(rad.creditedInvoiceLineId)!
        const redan = kredteratPerRad.get(source.id) ?? new Prisma.Decimal(0)
        const kvar = new Prisma.Decimal(source.total).minus(redan)
        const begärt = new Prisma.Decimal(belopp.total)

        if (begärt.greaterThan(kvar)) {
          const överskott = begärt.minus(kvar)
          const redanText = redan.isZero()
            ? ''
            : ` (${redan.toFixed(2)} kr av raden är redan krediterat)`
          throw new BadRequestException(
            `Raden "${source.description}" krediteras med ${begärt.toFixed(2)} kr men ` +
              `högst ${kvar.toFixed(2)} kr återstår att kreditera på den raden${redanText} — ` +
              `${överskott.toFixed(2)} kr för mycket. En kreditering får inte överstiga ` +
              'raden den avser; annars går den inte att följa tillbaka till det som fakturerades.',
          )
        }
      }

      // ── TAKET ──────────────────────────────────────────────────────────────
      //
      // Aldrig mer än den obetalda resten. Överskjutande kreditering leder till
      // ett tillgodohavande, och det är exakt den väg som är avgränsad bort —
      // se klassens docblock. Meddelandet säger VARFÖR, inte bara att det inte
      // går, och innehåller talen som gör felet begripligt för den som skrev
      // beloppet.
      const creditTotal = new Prisma.Decimal(amounts.total)
      if (creditTotal.greaterThan(debtBefore.outstanding)) {
        throw new BadRequestException(
          `Krediteringen (${creditTotal.toFixed(2)} kr) överstiger fakturans obetalda ` +
            `belopp (${debtBefore.outstanding.toFixed(2)} kr). Ett överskjutande belopp ` +
            'blir ett tillgodohavande till hyresgästen, vilket kräver en egen ' +
            'bokföring och återbetalningshantering som inte är byggd. ' +
            'Kreditera högst det obetalda beloppet.',
        )
      }

      // Kreditnotan drar nummer ur SAMMA sekvens som vanliga fakturor. Ingen ny
      // sekvenstabell — serien är redan obruten och org-scopad, och det som
      // bär spårbarheten är kopplingen nedan, inte vilken serie numret kom ur.
      const { invoiceNumber } = await allocateInvoiceNumber(tx, organizationId)

      const issueDate = new Date()

      const creditNote = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          // ── INGET BETAL-OCR ──────────────────────────────────────────────
          //
          // En kreditnota ska inte gå att betala in på. OCR-numret är det som
          // gör ett dokument betalbart: bankavstämningen matchar inbetalningar
          // på just det numret. Genereras inget OCR kan ingen inbetalning
          // heller hitta hit. `reference` pekar i stället ut originalet, så att
          // dokumentet är självförklarande utan att vara betalbart.
          ocrNumber: null,
          reference: `Kreditering av faktura ${original.invoiceNumber}`,
          type: original.type,
          // DRAFT, inte SENT: en kreditnota förfaller inte. Statusen håller den
          // dessutom utanför `markOverdueInvoices`, som bara rör SENT — och
          // därmed utanför hela kravtrappan, som grindar på OVERDUE.
          status: 'DRAFT',
          isCreditNote: true,
          creditedInvoiceId: original.id,
          tenantId: original.tenantId,
          customerId: original.customerId,
          leaseId: original.leaseId,
          subtotal: amounts.subtotal,
          vatTotal: amounts.vatTotal,
          total: amounts.total,
          // Förfallodatum = utfärdandedatum. Fältet är obligatoriskt i schemat
          // och saknar innebörd för ett dokument som inte ska betalas.
          dueDate: issueDate,
          issueDate,
          notes: dto.reason,
          lines: {
            createMany: {
              // Index-parning mot `creditLines`: `computeInvoiceAmounts` bär
              // bara beloppsfälten vidare, så kopplingen hämtas från indatan.
              // Ordningen är garanterad — hjälparen mappar 1:1.
              data: amounts.lines.map((l, i) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                vatRate: l.vatRate,
                total: l.total,
                // Kopplingen radnivå-taket räknar kumulativt på.
                creditedInvoiceLineId: creditLines[i]!.creditedInvoiceLineId,
              })),
            },
          },
        },
        include: { lines: true },
      })

      // Verifikatet i SAMMA transaktion. Faller bokföringen ska dokumentet inte
      // finnas — samma regel som för vanliga fakturor.
      await this.accountingService.createJournalEntryForCreditNote(
        creditNote,
        organizationId,
        actorId,
        tx,
      )

      // Händelsen skrivs på ORIGINALET. Det är där någon letar efter varför
      // fordran krympte.
      await this.eventsService.record(
        original.id,
        'CREDIT_NOTE_CREATED',
        'USER',
        actorId,
        {
          creditNoteId: creditNote.id,
          creditNoteNumber: creditNote.invoiceNumber,
          amount: amounts.total,
          reason: dto.reason,
        },
        { tx },
      )

      // Och en CREATED på kreditnotan själv, så att dokumentet har en egen
      // tidslinje precis som varje annan faktura.
      await this.eventsService.record(
        creditNote.id,
        'CREATED',
        'USER',
        actorId,
        { invoiceNumber: creditNote.invoiceNumber, creditedInvoiceId: original.id },
        { tx },
      )

      const debtAfter = computeInvoiceDebt({
        total: original.total,
        allocations: original.payments.map((p) => p.amount),
        credits: [...original.creditNotes.map((c) => c.total), creditNote.total],
      })

      return {
        creditNote,
        creditedInvoice: {
          id: original.id,
          invoiceNumber: original.invoiceNumber,
          // Restskulden EFTER krediteringen, ur samma helper som kravtrappan
          // läser. Anroparen ska aldrig behöva räkna ut den själv.
          outstanding: debtAfter.outstanding.toNumber(),
        },
      }
    })
  }
}
