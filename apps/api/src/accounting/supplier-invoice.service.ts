import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from './accounting.service'
import {
  isOverdue,
  supplierInvoiceStatus,
  type SupplierInvoiceStatus,
} from './supplier-invoice-status'

/**
 * LEVERANTÖRSFAKTUROR — registret, och de två bokföringsstegen.
 *
 * ── ORDNINGEN ÄR LASTBÄRANDE ────────────────────────────────────────────────
 *
 * Raden skrivs FÖRST, verifikatet sedan, båda i samma transaktion. Skälet är att
 * verifikatets idempotensnyckel härleds ur radens id — utan raden finns ingen
 * nyckel, och en nyckel som hittas på (en uuid per anrop) är ingen nyckel alls:
 * ett omtag hade gett två verifikat för samma faktura.
 *
 * Kastar bokföringen rullas raden tillbaka. Det är rätt håll: en faktura i
 * registret utan verifikat i huvudboken är en skuld som inte syns i
 * balansräkningen, och det är värre än ett fel användaren kan göra om.
 *
 * ── STATUS ÄR BERÄKNAT ──────────────────────────────────────────────────────
 *
 * Ingen `status`-kolumn. Se `supplier-invoice-status.ts`.
 */
@Injectable()
export class SupplierInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Registrera en MOTTAGEN leverantörsfaktura och bokför steg 1.
   *
   * `totalAmount` är BRUTTO — det som ska lämna bankkontot. `vatAmount` bryts UT
   * ur det, inte till. Nettot räknas här och lagras som snapshot; frontend
   * räknar aldrig om det.
   */
  async create(params: {
    organizationId: string
    createdById: string
    supplierName: string
    invoiceNumber?: string | undefined
    description: string
    invoiceDate: Date
    dueDate: Date
    expenseAccount: number
    totalAmount: number
    vatRate: number
    vatAmount: number
    attachmentUrl?: string | undefined
  }) {
    if (params.dueDate.getTime() < params.invoiceDate.getTime()) {
      throw new UnprocessableEntityException('Förfallodatum kan inte ligga före fakturadatum.')
    }
    if (params.vatAmount > params.totalAmount) {
      throw new UnprocessableEntityException(
        'Momsen kan inte vara större än beloppet — beloppet ska vara inklusive moms.',
      )
    }

    const netAmount = params.totalAmount - params.vatAmount

    return this.prisma.$transaction(async (tx) => {
      const faktura = await tx.supplierInvoice.create({
        data: {
          organizationId: params.organizationId,
          createdById: params.createdById,
          supplierName: params.supplierName,
          ...(params.invoiceNumber ? { invoiceNumber: params.invoiceNumber } : {}),
          description: params.description,
          invoiceDate: params.invoiceDate,
          dueDate: params.dueDate,
          expenseAccount: params.expenseAccount,
          netAmount,
          vatRate: params.vatRate,
          vatAmount: params.vatAmount,
          totalAmount: params.totalAmount,
          ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
        },
      })

      // Verifikatet i SAMMA transaktion. `tx` skickas in, så en kastad
      // bokföring rullar tillbaka registerraden — anroparen äger rollbacken,
      // vilket är precis vad createNumberedEntrys docblock föreskriver.
      await this.accounting.bookSupplierInvoiceReceipt({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        date: params.invoiceDate,
        supplierName: params.supplierName,
        description: params.description,
        expenseAccount: params.expenseAccount,
        totalAmount: params.totalAmount,
        vatAmount: params.vatAmount,
        createdById: params.createdById,
        ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
        tx,
      })

      return faktura
    })
  }

  /**
   * Markera som betald och bokför steg 2.
   *
   * `paidAt` sätts i SAMMA transaktion som betalningsverifikatet. Det är hela
   * kopplingen mellan det beräknade tillståndet och huvudboken: fältet kan inte
   * vara satt utan att verifikatet finns.
   */
  async markPaid(params: {
    organizationId: string
    invoiceId: string
    paidDate: Date
    createdById: string
  }) {
    const faktura = await this.findOne(params.invoiceId, params.organizationId)

    if (faktura.paidAt) {
      throw new UnprocessableEntityException('Fakturan är redan markerad som betald.')
    }
    if (faktura.cancelledAt) {
      throw new UnprocessableEntityException(
        'Fakturan är makulerad och kan inte betalas. Registrera en ny faktura om den ändå ska betalas.',
      )
    }

    return this.prisma.$transaction(async (tx) => {
      await this.accounting.bookSupplierInvoicePayment({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        paidDate: params.paidDate,
        supplierName: faktura.supplierName,
        totalAmount: Number(faktura.totalAmount),
        createdById: params.createdById,
        tx,
      })

      return tx.supplierInvoice.update({
        where: { id: faktura.id },
        data: { paidAt: params.paidDate },
      })
    })
  }

  /**
   * Makulera en OBETALD faktura — och VÄND VERIFIKATET.
   *
   * Att bara sätta `cancelledAt` hade gjort makuleringen till en ren flagga som
   * SÄGER EMOT huvudboken: listan hade visat "Makulerad" medan kostnaden låg
   * kvar i resultatet och skulden kvar på 2440. Ett tillstånd som inte går att
   * härleda ur verifikaten är precis det kodbasen inte får ha (CLAUDE.md:
   * "Skuld är ett beräknat tillstånd, aldrig en flagga").
   *
   * Motverifikatet skrivs i SAMMA transaktion som flaggan, av samma skäl som i
   * `create` och `markPaid`: fältet kan inte vara satt utan att verifikatet
   * finns.
   *
   * Fakturan RADERAS inte. En bokförd affärshändelse ska gå att följa i
   * efterhand (BFL 5 kap) — både mottagningen och rättelsen ligger kvar i
   * journalen.
   */
  async cancel(params: { organizationId: string; invoiceId: string; createdById: string }) {
    const faktura = await this.findOne(params.invoiceId, params.organizationId)
    this.accounting.assertMayCancelSupplierInvoice(faktura)

    // Rättelsedagen, inte fakturadagen. Se bookSupplierInvoiceCancellation.
    const idag = new Date()

    return this.prisma.$transaction(async (tx) => {
      await this.accounting.bookSupplierInvoiceCancellation({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        date: idag,
        supplierName: faktura.supplierName,
        description: faktura.description,
        expenseAccount: faktura.expenseAccount,
        totalAmount: Number(faktura.totalAmount),
        vatAmount: Number(faktura.vatAmount),
        createdById: params.createdById,
        tx,
      })

      return tx.supplierInvoice.update({
        where: { id: faktura.id },
        data: { cancelledAt: idag },
      })
    })
  }

  /** Org-scopat uppslag. NotFound, aldrig Forbidden — se documents-mönstret. */
  async findOne(id: string, organizationId: string) {
    const faktura = await this.prisma.supplierInvoice.findFirst({
      where: { id, organizationId },
    })
    if (!faktura) throw new NotFoundException('Leverantörsfakturan hittades inte')
    return faktura
  }

  /**
   * Listan. `status` och `overdue` är BERÄKNADE här, inte lagrade — och de
   * räknas på ETT ställe så att listan och detaljvyn inte kan säga olika.
   */
  async findAll(
    organizationId: string,
    filter?: { status?: SupplierInvoiceStatus },
  ): Promise<
    Array<{
      id: string
      supplierName: string
      invoiceNumber: string | null
      description: string
      invoiceDate: Date
      dueDate: Date
      expenseAccount: number
      netAmount: number
      vatRate: number
      vatAmount: number
      totalAmount: number
      attachmentUrl: string | null
      paidAt: Date | null
      cancelledAt: Date | null
      status: SupplierInvoiceStatus
      overdue: boolean
    }>
  > {
    const rader = await this.prisma.supplierInvoice.findMany({
      where: { organizationId },
      orderBy: { dueDate: 'asc' },
    })
    const nu = new Date()
    return rader
      .map((r) => ({
        id: r.id,
        supplierName: r.supplierName,
        invoiceNumber: r.invoiceNumber,
        description: r.description,
        invoiceDate: r.invoiceDate,
        dueDate: r.dueDate,
        expenseAccount: r.expenseAccount,
        netAmount: Number(r.netAmount),
        vatRate: r.vatRate,
        vatAmount: Number(r.vatAmount),
        totalAmount: Number(r.totalAmount),
        attachmentUrl: r.attachmentUrl,
        paidAt: r.paidAt,
        cancelledAt: r.cancelledAt,
        status: supplierInvoiceStatus(r),
        overdue: isOverdue(r, nu),
      }))
      .filter((r) => (filter?.status ? r.status === filter.status : true))
  }
}
