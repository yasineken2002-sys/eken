/**
 * TESTKUND-008 provhjälp: belagda verifikat och en GODKÄND kontomappning genom den riktiga tjänsten.
 *
 * Efter 008 exporteras inget manuellt verifikat (EVENT_UNSUPPORTED) och ingen rad utan godkänd
 * mappning. Befintliga sändprov använde ett manuellt 5170/2440-verifikat; de använder nu en
 * verklig leverantörsfaktura (SupplierInvoice + verifikat supplier-invoice:<id>) och en revision
 * som skapats och godkänts av FortnoxKontomappningService mot den lokala Fortnox-fejken.
 */
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { FortnoxAccountMappingRowInput } from '@eken/shared'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxKontomappningService } from './fortnox-kontomappning.service'
import type { FortnoxLedgerReader } from './fortnox.types'

export const KOSTNADSMAPPNING: FortnoxAccountMappingRowInput[] = [
  {
    role: 'KOSTNAD',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 5170,
    targetAccountNumber: 5170,
  },
  {
    role: 'LEVERANTORSSKULD',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 2440,
    targetAccountNumber: 2440,
  },
]

/** Skapar och godkänner en revision (OWNER) för år `financialYearId`. Returnerar revisionen. */
export async function godkannMappning(
  prisma: PrismaClient,
  connections: FortnoxConnectionService,
  reader: FortnoxLedgerReader,
  organizationId: string,
  rows: FortnoxAccountMappingRowInput[] = KOSTNADSMAPPNING,
  financialYearId = 1,
) {
  const svc = new FortnoxKontomappningService(
    prisma as unknown as PrismaService,
    connections,
    reader,
  )
  for (const r of rows) {
    const finns = await prisma.account.findFirst({
      where: { organizationId, number: r.sourceAccountNumber },
    })
    if (!finns)
      await prisma.account.create({
        data: {
          organizationId,
          number: r.sourceAccountNumber,
          name: `Konto ${r.sourceAccountNumber}`,
          type:
            r.sourceAccountNumber < 2000
              ? 'ASSET'
              : r.sourceAccountNumber < 3000
                ? 'LIABILITY'
                : 'EXPENSE',
        },
      })
  }
  const user = { sub: 'u1', role: 'OWNER' }
  const utkast = await svc.skapaUtkast(organizationId, user, { financialYearId, rows })
  return svc.godkann(organizationId, user, utkast.id, utkast.contentSha256)
}

/**
 * En verklig leverantörsfaktura (mottagande) som verifikat: kostnad D / 2440 K, utan moms.
 * Samma form som AccountingService.bookSupplierInvoiceReceipt.
 */
export async function leverantorsfaktura(
  prisma: PrismaClient,
  organizationId: string,
  opts: {
    belopp?: string
    datum?: string
    beskrivning?: string
    radtext?: [string | null, string | null]
    kostnadskonto?: number
  } = {},
) {
  const belopp = opts.belopp ?? '1234.50'
  const datum = new Date(opts.datum ?? '2026-10-02')
  const kostnad = opts.kostnadskonto ?? 5170
  const konto = async (number: number, type: 'EXPENSE' | 'LIABILITY') =>
    (await prisma.account.findFirst({ where: { organizationId, number } })) ??
    prisma.account.create({ data: { organizationId, number, name: `Konto ${number}`, type } })
  const a = await konto(kostnad, 'EXPENSE')
  const b = await konto(2440, 'LIABILITY')
  const f = await prisma.supplierInvoice.create({
    data: {
      organizationId,
      supplierName: 'Syntetisk leverantör',
      description: opts.beskrivning ?? 'Reparation trapphus',
      invoiceDate: datum,
      dueDate: datum,
      expenseAccount: kostnad,
      netAmount: belopp,
      vatRate: 0,
      vatAmount: '0',
      totalAmount: belopp,
    },
  })
  return prisma.journalEntry.create({
    data: {
      organizationId,
      date: datum,
      description: opts.beskrivning ?? 'Reparation trapphus',
      fiscalYear: datum.getUTCFullYear(),
      verNumber: Math.floor(Math.random() * 1e6) + 1,
      source: 'SUPPLIER_INVOICE',
      sourceId: `supplier-invoice:${f.id}`,
      lines: {
        create: [
          { accountId: a.id, debit: belopp, description: opts.radtext?.[0] ?? null },
          { accountId: b.id, credit: belopp, description: opts.radtext?.[1] ?? null },
        ],
      },
    },
  })
}

/** Städning i rätt FK-ordning för proven (revisioner och leverantörsfakturor). */
export async function stadaKontomappning(prisma: PrismaClient, organizationId: string) {
  await prisma.fortnoxAccountMappingRow.deleteMany({ where: { revision: { organizationId } } })
  await prisma.fortnoxAccountMappingRevision.deleteMany({ where: { organizationId } })
  // TESTKUND-041: momsjusteringar refererar fakturan (Restrict) och tas bort först.
  await prisma.supplierInvoiceVatAdjustment.deleteMany({ where: { organizationId } })
  await prisma.expenseVatDecision.deleteMany({ where: { organizationId } })
  await prisma.supplierInvoice.deleteMany({ where: { organizationId } })
}

export const unik = () => randomUUID().slice(0, 8)
