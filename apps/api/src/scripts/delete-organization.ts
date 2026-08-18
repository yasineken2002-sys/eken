/**
 * RADERA EN ORGANISATION — hela trädet, i rätt ordning, i EN transaktion.
 *
 * ── VARFÖR SKRIPTET FINNS ───────────────────────────────────────────────────
 *
 * `DELETE FROM "Organization"` fungerar inte. Raderingen kaskaderar bara till
 * 17 av tabellerna; 31 bär `Restrict` mot `Organization` och fäller hela
 * försöket. Fyra tabeller till — `Lease`, `AiPendingAction`,
 * `ContractImportRow`, `Psd2ConsentState` — bär `organizationId` HELT UTAN
 * främmande nyckel, så de syns inte ens i FK-grafen. `Lease` är den farliga:
 * den är `Restrict` mot både `Tenant` och `Unit`, som båda faller via kaskaden,
 * så en radering som bara följer FK-grafen fäller på just den.
 *
 * ORDNINGEN NEDAN ÄR DOKUMENTATIONEN. Den är inte hopsatt för hand utan
 * härledd topologiskt ur den verkliga FK-grafen: varje steg ligger före sin
 * förälder, och kommentaren säger mot VAD steget är `Restrict`. Ändrar du
 * ordningen ska du kunna säga vilken kant du flyttade.
 *
 * ── VAD DET INTE ÄR ─────────────────────────────────────────────────────────
 *
 * Det här är ett DEV-verktyg för att städa testdata. Det är inte
 * GDPR-raderingsvägen: en raderingsbegäran från en hyresgäst verkställs med
 * avidentifiering (`src/common/gdpr/anonymize-tenant.ts`, #493), eftersom
 * underlaget är räkenskapsmaterial som ska bevaras. Skriptet raderar på
 * riktigt och bevarar ingenting.
 *
 * ── ANVÄNDNING ──────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @eken/api org:delete <org-id> [<org-id> …]     # torrkörning
 *   pnpm --filter @eken/api org:delete <org-id> --yes            # verkställ
 *
 * Torrkörning är DEFAULT och visar rader per tabell. Id:n tas som argument,
 * aldrig ett mönster: ett `LIKE` utvärderas om vid varje steg och kan svälja
 * rader som skapats under körningen.
 *
 * Skriptet vägrar köra mot annat än localhost/eken_dev. `--allow-non-dev`
 * finns, men den som sätter den har sagt det högt.
 */

import { PrismaClient } from '@prisma/client'

type Step = {
  /** Modellnamnet som i schema.prisma. Vakten matchar mot det här. */
  model: string
  /** Vad steget är Restrict mot — alltså varför det ligger just här. */
  restrictAgainst: string
  /** Prisma-filter för de utpekade organisationerna. */
  where: (ids: string[]) => Record<string, unknown>
}

const byOrg = (ids: string[]) => ({ organizationId: { in: ids } })

/**
 * Raderingsordningen. Barn före förälder. `Organization` själv står inte här —
 * den raderas sist av `deleteOrganizations` och tar kaskad-tabellerna med sig.
 */
export const DELETION_STEPS: readonly Step[] = [
  // Fyra tabeller saknar organizationId och nås via sin förälder.
  {
    model: 'RentNoticeLine',
    restrictAgainst: 'MiscCharge',
    where: (ids) => ({ rentNotice: byOrg(ids) }),
  },
  {
    model: 'RentNoticeEvent',
    restrictAgainst: 'RentNotice',
    where: (ids) => ({ rentNotice: byOrg(ids) }),
  },
  {
    model: 'MaintenanceTicket',
    restrictAgainst: 'MiscCharge, Organization, Property',
    where: byOrg,
  },
  {
    model: 'ConsumptionCharge',
    restrictAgainst: 'Lease, MeterReading, Organization, Tenant',
    where: byOrg,
  },
  { model: 'SignatureEvidence', restrictAgainst: 'Organization, SigningRequest', where: byOrg },
  { model: 'RentNotice', restrictAgainst: 'Lease, Organization, Tenant', where: byOrg },
  { model: 'MiscCharge', restrictAgainst: 'Lease, Organization, Tenant', where: byOrg },
  { model: 'MeterReading', restrictAgainst: 'Meter, Organization', where: byOrg },
  {
    model: 'JournalEntryLine',
    restrictAgainst: 'Account, JournalEntry',
    where: (ids) => ({ journalEntry: byOrg(ids) }),
  },
  { model: 'InvoiceEvent', restrictAgainst: 'Invoice', where: (ids) => ({ invoice: byOrg(ids) }) },
  { model: 'TenantOcrSequence', restrictAgainst: 'Organization', where: byOrg },
  { model: 'TenantAnonymizationLog', restrictAgainst: 'Organization, Tenant', where: byOrg },
  { model: 'SigningRequest', restrictAgainst: 'Document, Organization', where: byOrg },
  { model: 'RentNoticeNumberSequence', restrictAgainst: 'Organization', where: byOrg },
  { model: 'RentIncrease', restrictAgainst: 'Organization', where: byOrg },
  // Ingen FK mot Organization alls — osynlig i FK-grafen, måste stå här.
  { model: 'Psd2ConsentState', restrictAgainst: '— (ingen FK mot Organization)', where: byOrg },
  { model: 'PlatformInvoice', restrictAgainst: 'Organization', where: byOrg },
  { model: 'NewsPost', restrictAgainst: 'Organization, User', where: byOrg },
  { model: 'Meter', restrictAgainst: 'Organization, Unit', where: byOrg },
  // Lease: ingen FK mot Organization, men Restrict mot Tenant och Unit som
  // BÅDA faller via kaskaden. Det här steget är skälet till att skriptet finns.
  { model: 'Lease', restrictAgainst: 'Tenant, Unit (ingen FK mot Organization)', where: byOrg },
  { model: 'KeyHandover', restrictAgainst: 'Organization, Tenant, Unit', where: byOrg },
  { model: 'JournalEntrySequence', restrictAgainst: 'Organization', where: byOrg },
  { model: 'JournalEntry', restrictAgainst: 'Organization', where: byOrg },
  { model: 'InvoiceNumberSequence', restrictAgainst: 'Organization', where: byOrg },
  { model: 'Invoice', restrictAgainst: 'Organization', where: byOrg },
  { model: 'ImpersonationLog', restrictAgainst: 'Organization', where: byOrg },
  { model: 'ErrorLog', restrictAgainst: 'Organization', where: byOrg },
  { model: 'Deposit', restrictAgainst: 'Organization, Tenant', where: byOrg },
  { model: 'ContractImportRow', restrictAgainst: '— (ingen FK mot Organization)', where: byOrg },
  { model: 'ConsumptionTariff', restrictAgainst: 'Organization', where: byOrg },
  { model: 'ClosedAccountingPeriod', restrictAgainst: 'Organization', where: byOrg },
  { model: 'BankTransaction', restrictAgainst: 'Organization', where: byOrg },
  { model: 'BankStatementImport', restrictAgainst: 'Organization', where: byOrg },
  { model: 'BankConsent', restrictAgainst: 'Organization', where: byOrg },
  { model: 'AiUsageLog', restrictAgainst: 'Organization', where: byOrg },
  { model: 'AiToolExecution', restrictAgainst: 'Organization', where: byOrg },
  { model: 'AiPendingAction', restrictAgainst: '— (ingen FK mot Organization)', where: byOrg },
  { model: 'AccountingPeriodEvent', restrictAgainst: 'Organization', where: byOrg },
  { model: 'Account', restrictAgainst: 'Organization', where: byOrg },
] as const

/** Prisma-klientens egenskap för ett modellnamn: JournalEntryLine → journalEntryLine. */
export const clientKey = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1)

type Delegate = {
  count: (a: unknown) => Promise<number>
  deleteMany: (a: unknown) => Promise<{ count: number }>
}
const delegate = (prisma: PrismaClient, model: string): Delegate => {
  const d = (prisma as unknown as Record<string, Delegate | undefined>)[clientKey(model)]
  // Ett stegnamn som inte motsvarar en modell ska smälla här, inte tyst hoppas
  // över. Vakten fångar det i test; det här fångar det i körning.
  if (!d) throw new Error(`Okänd modell i raderingsordningen: ${model}`)
  return d
}

/** Torrkörning: rader per tabell, utan att röra något. */
export async function countRows(
  prisma: PrismaClient,
  ids: string[],
): Promise<{ model: string; rows: number }[]> {
  const out: { model: string; rows: number }[] = []
  for (const step of DELETION_STEPS) {
    out.push({
      model: step.model,
      rows: await delegate(prisma, step.model).count({ where: step.where(ids) }),
    })
  }
  out.push({
    model: 'Organization',
    rows: await prisma.organization.count({ where: { id: { in: ids } } }),
  })
  return out
}

/**
 * Raderar i EN transaktion. Faller ett steg på en Restrict-relation som
 * ordningen missat rullas ALLT tillbaka — en halvraderad organisation är värre
 * än en orörd, eftersom nästa försök då startar från ett tillstånd ingen
 * beskrivit.
 */
export async function deleteOrganizations(
  prisma: PrismaClient,
  ids: string[],
): Promise<{ model: string; rows: number }[]> {
  return prisma.$transaction(async (tx) => {
    const deleted: { model: string; rows: number }[] = []
    for (const step of DELETION_STEPS) {
      const { count } = await delegate(tx as unknown as PrismaClient, step.model).deleteMany({
        where: step.where(ids),
      })
      deleted.push({ model: step.model, rows: count })
    }
    const org = await tx.organization.deleteMany({ where: { id: { in: ids } } })
    deleted.push({ model: 'Organization', rows: org.count })
    return deleted
  })
}

/** localhost/eken_dev, eller uttryckligt medgivande. Skriver aldrig ut lösenordet. */
export function assertDevDatabase(
  url: string | undefined,
  allowNonDev: boolean,
): { host: string; database: string } {
  const m = /^\w+:\/\/(?:[^@/]*@)?(?<host>[^:/?]+)(?::\d+)?\/(?<database>[^?]+)/.exec(url ?? '')
  if (!m?.groups) throw new Error('DATABASE_URL saknas eller går inte att tolka.')
  const { host, database } = m.groups as { host: string; database: string }
  const isDev = (host === 'localhost' || host === '127.0.0.1') && database === 'eken_dev'
  if (!isDev && !allowNonDev) {
    throw new Error(
      `Vägrar köra mot ${host}/${database}. Skriptet raderar på riktigt och är avsett för dev.\n` +
        'Är det ändå meningen: kör om med --allow-non-dev.',
    )
  }
  return { host, database }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const execute = args.includes('--yes')
  const allowNonDev = args.includes('--allow-non-dev')
  const ids = args.filter((a) => !a.startsWith('--'))

  if (ids.length === 0) {
    console.error('Ange minst ett organisations-id. Mönster (LIKE) stöds avsiktligt inte.')
    process.exitCode = 1
    return
  }

  const { host, database } = assertDevDatabase(process.env.DATABASE_URL, allowNonDev)
  const prisma = new PrismaClient()
  try {
    console.warn(`Databas: ${host}/${database}`)
    console.warn(`${ids.length} organisation(er): ${ids.join(', ')}\n`)

    const found = await prisma.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })
    if (found.length !== ids.length) {
      const missing = ids.filter((id) => !found.some((o) => o.id === id))
      console.error(
        `Avbryter: ${missing.length} id finns inte i databasen:\n  ${missing.join('\n  ')}`,
      )
      process.exitCode = 1
      return
    }
    found.forEach((o) => console.warn(`  ${o.id}  ${o.name}`))
    console.warn('')

    const rows = execute ? await deleteOrganizations(prisma, ids) : await countRows(prisma, ids)
    const affected = rows.filter((r) => r.rows > 0)
    console.warn(execute ? 'RADERAT:' : 'TORRKÖRNING — ingenting raderas:')
    affected.forEach((r) => console.warn(`  ${r.model.padEnd(26)} ${String(r.rows).padStart(7)}`))
    console.warn(
      `\n  ${affected.length} tabell(er), ${rows.reduce((s, r) => s + r.rows, 0)} rader totalt.`,
    )
    if (!execute) console.warn('\nKör om med --yes för att verkställa.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
