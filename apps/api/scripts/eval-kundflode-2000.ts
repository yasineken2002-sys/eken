/** Lokal integration. Ingen nätverksmodell och inga verkliga bankuppgifter. */
import 'reflect-metadata'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../src/common/prisma/prisma.service'
import { runWithActor } from '../src/common/actor/actor.context'
import { AccountingService } from '../src/accounting/accounting.service'
import { VerifikationsnummerService } from '../src/accounting/verifikationsnummer.service'
import { ReconciliationService } from '../src/reconciliation/reconciliation.service'
import { InvoiceEventsService } from '../src/invoices/invoice-events.service'
import { RentNoticeEventsService } from '../src/avisering/rent-notice-events.service'
import { PaymentFreshnessService } from '../src/payment-freshness/payment-freshness.service'
import { PaymentOutcomeService } from '../src/ai/shadow/payment/payment-outcome.service'
import { PaymentShadowService } from '../src/ai/shadow/payment/payment-shadow.service'
import { OcrService } from '../src/common/ocr/ocr.service'
import { provaKandidater } from '../src/ai/shadow/payment/payment-candidates'
import type { Bankrad, Kandidat } from '../src/ai/shadow/payment/payment-candidates'
import { berikaReferenser } from '../src/ai/shadow/eval/experiment-betalningsreferenser'
import { skapaKundflode, testUuid, MAX_MANUELLA } from '../src/ai/shadow/eval/kundflode-2000'
import type { Testbetalning } from '../src/ai/shadow/eval/kundflode-2000'

const Decimal = Prisma.Decimal
const world = skapaKundflode()
interface Matrad {
  id: string
  typ: Testbetalning['typ']
  status: 'EJ_KORD' | 'MATCHED' | 'UNMATCHED' | 'TEKNISKT_FEL'
  facit: Testbetalning['facit']
  bankrad?: Bankrad
  transactionId?: string
  importResultat?: unknown
  allokeringar?: { avi: string; beloppOre: number; tenantId: string }[]
  automatiskRatt?: boolean
  felaktigAutomatisk?: boolean
  beloppsinvariant?: boolean
  underlag?: { kandidater: Kandidat[]; takNått: boolean }
  regel?: unknown
  referensstod?: { kandidater: string[]; takNatt: boolean }
  fel?: string
}

function summary(rows: Matrad[]) {
  const ratt = rows.filter((r) => r.automatiskRatt).length
  const fel = rows.filter((r) => r.felaktigAutomatisk).length
  const pending = rows.filter((r) => r.status === 'UNMATCHED').length
  const technical = rows.filter((r) => r.status === 'TEKNISKT_FEL').length
  const unrun = rows.filter((r) => r.status === 'EJ_KORD').length
  return {
    antal: rows.length,
    korrektAutomatiska: ratt,
    felaktigtAutomatiska: fel,
    omatchade: pending,
    tekniskaFel: technical,
    ejKorda: unrun,
    behovAvManskligInsats: pending + fel + technical + unrun,
    korrektAutomatiskAndel: ratt / rows.length,
    precisionAutomatisk: ratt + fel ? ratt / (ratt + fel) : null,
    malMax20: pending + fel + technical + unrun <= MAX_MANUELLA,
    beloppsinvariantFel: rows.filter((r) => r.beloppsinvariant === false).length,
    underlagMedTak: rows.filter((r) => r.underlag?.takNått).length,
    perTyp: [...new Set(rows.map((r) => r.typ))].map((typ) => {
      const selected = rows.filter((r) => r.typ === typ)
      return {
        typ,
        antal: selected.length,
        ratt: selected.filter((r) => r.automatiskRatt).length,
        fel: selected.filter((r) => r.felaktigAutomatisk).length,
        omatchade: selected.filter((r) => r.status === 'UNMATCHED').length,
      }
    }),
  }
}

function ore(n: Prisma.Decimal | null): number {
  if (n === null) return 0 // Journalens oanvända debet-/kreditsida lagras som NULL.
  const v = n.mul(100)
  if (!v.isInteger() || !v.isFinite() || v.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error('Belopp kunde inte representeras exakt i ören')
  return v.toNumber()
}
const same = (a: { avi: string; beloppOre: number }[], b: { avi: string; beloppOre: number }[]) =>
  JSON.stringify(
    a.map(({ avi, beloppOre }) => ({ avi, beloppOre })).sort((x, y) => x.avi.localeCompare(y.avi)),
  ) ===
  JSON.stringify(
    b.map(({ avi, beloppOre }) => ({ avi, beloppOre })).sort((x, y) => x.avi.localeCompare(y.avi)),
  )

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (
    process.env.ALLOW_SYNTHETIC_BANK_WRITES !== '1' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '56432' ||
    !/^\/eveno_bank2000_[a-z0-9_]+$/.test(url.pathname)
  ) {
    throw new Error('Endast uttryckligen godkänd lokal bank2000-testdatabas får användas')
  }
  const output = resolve(process.argv[2] ?? '/tmp/eveno-bank2000/resultat')
  if (existsSync(output))
    throw new Error('Utmatningskatalogen finns redan; tidigare mätningar skrivs aldrig över')
  mkdirSync(output, { recursive: true })
  const files = [
    'scripts/eval-kundflode-2000.ts',
    'src/ai/shadow/eval/kundflode-2000.ts',
    'src/reconciliation/reconciliation.service.ts',
    'src/reconciliation/ocr-proveniens.ts',
    'src/ai/shadow/payment/payment-shadow.service.ts',
    'src/ai/shadow/payment/payment-candidates.ts',
    'src/ai/shadow/eval/experiment-betalningsreferenser.ts',
    'src/ai/shadow/eval/experiment-betalningsgrind.ts',
    'src/accounting/accounting.service.ts',
    'src/avisering/rent-debt.service.ts',
    'prisma/schema.prisma',
  ]
  const meta = {
    at: new Date().toISOString(),
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeChanged: Boolean(
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    ),
    sourceHashes: Object.fromEntries(
      files.map((f) => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]),
    ),
    datamixUppmattHosKund: false,
    modellAnrop: 0,
    fullstandigtHttpE2e: false,
    testdatabas: url.pathname.slice(1),
    kund: {
      fastigheter: 10,
      lagenheter: 200,
      hyresgaster: 200,
      avtal: 200,
      avier: world.avier.length,
      betalningar: world.betalningar.length,
    },
  }
  writeFileSync(resolve(output, 'kund-och-facit.json'), JSON.stringify(world, null, 2) + '\n')
  const db = new PrismaService()
  const accounting = new AccountingService(db, new VerifikationsnummerService(db))
  const ocr = new OcrService(db)
  // Bara externa gränser stoppas. Matchning, databassvar, skuld, journal och händelser är äkta.
  const noMail = {
    sendEmail: async () => {
      throw new Error('Mejl är inte tillåtet i testet')
    },
  }
  const freshness = new PaymentFreshnessService(db, noMail as never)
  const queue: { organizationId: string; bankTransactionId: string }[] = []
  const reconciliation = new ReconciliationService(
    db,
    {} as never, // InvoicesService används inte av aviimporten; inget svar mockas.
    new InvoiceEventsService(db),
    accounting,
    freshness,
    new RentNoticeEventsService(db),
    {
      enqueue: async (item: { organizationId: string; bankTransactionId: string }) => {
        queue.push(item)
        return 'lokalt-registrerat'
      },
    } as never,
    new PaymentOutcomeService(db),
  )
  // Återanvänd läsmetoden utan att konstruera SDK-klienten eller ladda en API-nyckel.
  const readCandidates = (org: string) =>
    PaymentShadowService.prototype['hämtaKandidater'].call(
      { prisma: db } as unknown as PaymentShadowService,
      org,
    )
  const results: Record<string, unknown> = {}
  const runId = createHash('sha256').update(output).digest('hex').slice(0, 12)
  Logger.overrideLogger(['error', 'warn'])
  try {
    await db.$connect()
    const migrations = await db.$queryRaw<
      { antal: bigint; misslyckade: bigint }[]
    >`SELECT count(*) AS antal, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS misslyckade FROM "_prisma_migrations"`
    if (!migrations[0] || migrations[0].antal === 0n || migrations[0].misslyckade !== 0n)
      throw new Error('Migrationerna är inte verifierat klara')
    const postgres = await db.$queryRaw<{ version: string }[]>`SELECT version()`
    writeFileSync(
      resolve(output, 'miljo.json'),
      JSON.stringify({ ...meta, postgres, migrationer: Number(migrations[0].antal) }, null, 2) +
        '\n',
    )
    for (const arm of ['AGENT_AV', 'AGENT_PA'] as const) {
      const orgId = testUuid(`${runId}:${arm}:org`)
      if (await db.organization.findUnique({ where: { id: orgId } }))
        throw new Error('Testorganisationen finns redan')
      const id = (label: string) => testUuid(`${runId}:${arm}:${label}`)
      const rows: Matrad[] = world.betalningar.map((p) => ({
        id: p.id,
        typ: p.typ,
        status: 'EJ_KORD',
        facit: p.facit,
      }))
      const byId = new Map(rows.map((r) => [r.id, r]))
      const logicalNotice = new Map(world.avier.map((n) => [id(n.id), n.id]))
      const tenantOcr = new Map<number, string>()
      const save = () =>
        writeFileSync(
          resolve(output, `${arm}.json`),
          JSON.stringify(
            { ...meta, arm, organizationId: orgId, sammanfattning: summary(rows), rader: rows },
            null,
            2,
          ) + '\n',
        )
      save()
      await runWithActor('SYSTEM', async () => {
        await db.organization.create({
          data: {
            id: orgId,
            name: `SYNTETISK Testkund 2000 ${arm} ${runId}`,
            email: `bank2000-${arm.toLowerCase()}-${runId}@example.invalid`,
            street: 'Testgatan 1',
            postalCode: '11111',
            city: 'Testköping',
            orgNumber: `TEST-${runId}-${arm}`,
            fiscalYearStartMonth: 1,
            shadowPaymentAgentEnabled: arm === 'AGENT_PA',
          },
        })
        await accounting.seedDefaultAccounts(orgId)
        for (let property = 0; property < 10; property++) {
          await db.property.create({
            data: {
              id: id(`fastighet-${property}`),
              organizationId: orgId,
              name: `Testfastighet ${property + 1}`,
              propertyDesignation: `Testköping ${property + 1}:1`,
              type: 'RESIDENTIAL',
              street: `Testgatan ${property + 1}`,
              city: 'Testköping',
              postalCode: '11111',
              totalArea: 1400,
            },
          })
        }
        for (const t of world.hyresgaster) {
          await db.unit.create({
            data: {
              id: id(`lagenhet-${t.index}`),
              propertyId: id(`fastighet-${t.fastighet}`),
              name: `Lägenhet ${t.lagenhet}`,
              unitNumber: t.lagenhet,
              type: 'APARTMENT',
              rooms: 1 + (t.index % 4),
              area: 35 + (t.index % 4) * 17,
              monthlyRent: new Decimal(t.hyraOre).div(100),
              status: 'OCCUPIED',
            },
          })
          await db.tenant.create({
            data: {
              id: id(`hyresgast-${t.index}`),
              organizationId: orgId,
              type: 'INDIVIDUAL',
              firstName: t.fornamn,
              lastName: t.efternamn,
              email: `hyresgast-${runId}-${arm.toLowerCase()}-${t.index}@example.invalid`,
            },
          })
          tenantOcr.set(t.index, await ocr.assignOcrToTenant(id(`hyresgast-${t.index}`), orgId))
          await db.lease.create({
            data: {
              id: id(`avtal-${t.index}`),
              organizationId: orgId,
              unitId: id(`lagenhet-${t.index}`),
              tenantId: id(`hyresgast-${t.index}`),
              contractNumber: `HK-TEST-${t.index + 1}`,
              monthlyRent: new Decimal(t.hyraOre).div(100),
              depositAmount: 0,
              startDate: new Date('2025-10-01T00:00:00Z'),
              tenancyStartDate: new Date('2025-10-01T00:00:00Z'),
              status: 'ACTIVE',
            },
          })
        }
        process.stdout.write(
          `${arm}: 10 fastigheter, 200 lägenheter, hyresgäster och avtal skapade.\n`,
        )
        for (let period = 0; period < 10; period++) {
          for (const n of world.avier.filter((n) => n.period === period)) {
            await db.$transaction(
              async (tx) => {
                const notice = await tx.rentNotice.create({
                  data: {
                    id: id(n.id),
                    organizationId: orgId,
                    tenantId: id(`hyresgast-${n.hyresgast}`),
                    leaseId: id(`avtal-${n.hyresgast}`),
                    noticeNumber: n.nummer,
                    ocrNumber: tenantOcr.get(n.hyresgast)!,
                    month: n.month,
                    year: n.year,
                    amount: new Decimal(n.beloppOre).div(100),
                    totalAmount: new Decimal(n.beloppOre).div(100),
                    dueDate: new Date(n.forfallodatum),
                    status: 'SENT',
                    sentAt: new Date(Date.UTC(n.year, n.month - 1, 1)),
                    type: 'RENT',
                  },
                })
                const entry = await accounting.createJournalEntryForRentNotice(
                  notice,
                  orgId,
                  null,
                  tx,
                )
                if (!entry) throw new Error('Testavi saknar bokförd fordran')
              },
              { timeout: 15000 },
            )
          }
          for (const payment of world.betalningar.filter((p) => p.period === period)) {
            const row = byId.get(payment.id)!
            const underlag = await readCandidates(orgId)
            let reference =
              payment.ocrFranHyresgast === null ? '' : tenantOcr.get(payment.ocrFranHyresgast)!
            if (payment.felskrivOcr)
              reference = reference.slice(0, -1) + ((Number(reference.at(-1)) + 1) % 10)
            const csv = `Datum;Text;Belopp;Referens\n${payment.datum.slice(0, 10)};${payment.text};${new Decimal(payment.beloppOre).div(100).toFixed(2)};${reference}\n`
            const imported = await reconciliation.importBankStatement(
              Buffer.from(csv),
              'syntetisk-bank.csv',
              orgId,
            )
            row.importResultat = imported
            const found = await db.bankTransaction.findMany({
              where: {
                organizationId: orgId,
                date: new Date(payment.datum),
                description: payment.text,
                amount: new Decimal(payment.beloppOre).div(100),
              },
            })
            if (found.length !== 1 || imported.errors.length || imported.imported !== 1) {
              row.status = 'TEKNISKT_FEL'
              row.fel = `Import ${JSON.stringify(imported)}, hittade bankrader: ${found.length}`
              row.underlag = underlag
              continue
            }
            const bank = found[0]!
            row.transactionId = bank.id
            row.bankrad = {
              id: bank.id,
              datum: bank.date,
              text: bank.description,
              belopp: bank.amount.toNumber(),
              rawOcr: bank.rawOcr,
            }
            const allocs = await db.rentNoticePayment.findMany({
              where: { bankTransactionId: bank.id, rentNotice: { organizationId: orgId } },
              select: {
                id: true,
                rentNoticeId: true,
                amount: true,
                rentNotice: { select: { tenantId: true } },
              },
            })
            row.allokeringar = allocs.map((a) => ({
              avi: logicalNotice.get(a.rentNoticeId) ?? `OKAND:${a.rentNoticeId}`,
              beloppOre: ore(a.amount),
              tenantId: a.rentNotice.tenantId,
            }))
            row.status = bank.status === 'MATCHED' ? 'MATCHED' : 'UNMATCHED'
            const sum = row.allokeringar.reduce((n, a) => n + a.beloppOre, 0)
            const entries = await db.journalEntry.findMany({
              where: {
                organizationId: orgId,
                source: 'PAYMENT',
                sourceId: { in: allocs.map((a) => `rent-notice-bank-payment:${a.id}`) },
              },
              include: { lines: { include: { account: true } } },
            })
            const ledger = entries.flatMap((e) => e.lines)
            const bankDebit = ledger
              .filter((l) => l.account.number === 1930)
              .reduce((n, l) => n + ore(l.debit) - ore(l.credit), 0)
            const receivableCredit = ledger
              .filter((l) => l.account.number === 1510)
              .reduce((n, l) => n + ore(l.credit) - ore(l.debit), 0)
            row.beloppsinvariant =
              row.status === 'MATCHED'
                ? sum === payment.beloppOre &&
                  bankDebit === sum &&
                  receivableCredit === sum &&
                  entries.length === allocs.length
                : allocs.length === 0 && entries.length === 0
            row.automatiskRatt =
              row.status === 'MATCHED' &&
              !payment.facit.granskningKravsAvUnderlaget &&
              same(row.allokeringar, payment.facit.allokeringar) &&
              row.beloppsinvariant
            row.felaktigAutomatisk = row.status === 'MATCHED' && !row.automatiskRatt
            if (!row.automatiskRatt) {
              row.underlag = underlag
              row.regel = provaKandidater(row.bankrad, underlag.kandidater)
              const regel = provaKandidater(row.bankrad, underlag.kandidater)
              const enriched = berikaReferenser(
                row.bankrad,
                underlag.kandidater,
                regel.typ === 'KANDIDATER' ? regel.kandidater : [],
              )
              row.referensstod = {
                kandidater: enriched.kandidater.map((k) => k.id),
                takNatt: underlag.takNått,
              }
            }
          }
          save()
          const done = rows.filter((r) => r.status !== 'EJ_KORD')
          process.stdout.write(
            `${arm}: månad ${period + 1}/10, ${done.length}/2000 betalningar. ${JSON.stringify(summary(done))}\n`,
          )
        }
      })
      // Återimport får inte ändra en enda allokering eller journalpost.
      const beforeRetry = {
        bank: await db.bankTransaction.count({ where: { organizationId: orgId } }),
        allocations: await db.rentNoticePayment.count({
          where: { rentNotice: { organizationId: orgId } },
        }),
        entries: await db.journalEntry.count({ where: { organizationId: orgId } }),
      }
      const first = world.betalningar[0]!
      const firstRef = first.ocrFranHyresgast === null ? '' : tenantOcr.get(first.ocrFranHyresgast)!
      const retry = await reconciliation.importBankStatement(
        Buffer.from(
          `Datum;Text;Belopp;Referens\n${first.datum.slice(0, 10)};${first.text};${new Decimal(first.beloppOre).div(100).toFixed(2)};${firstRef}\n`,
        ),
        'aterimport.csv',
        orgId,
      )
      const afterRetry = {
        bank: await db.bankTransaction.count({ where: { organizationId: orgId } }),
        allocations: await db.rentNoticePayment.count({
          where: { rentNotice: { organizationId: orgId } },
        }),
        entries: await db.journalEntry.count({ where: { organizationId: orgId } }),
      }
      const allEntries = await db.journalEntry.findMany({
        where: { organizationId: orgId },
        include: { lines: true },
      })
      const balanced = allEntries.every((e) =>
        e.lines.reduce((n, l) => n.add(l.debit ?? 0).sub(l.credit ?? 0), new Decimal(0)).eq(0),
      )
      const counts = {
        ...afterRetry,
        properties: await db.property.count({ where: { organizationId: orgId } }),
        units: await db.unit.count({ where: { property: { organizationId: orgId } } }),
        tenants: await db.tenant.count({ where: { organizationId: orgId } }),
        leases: await db.lease.count({ where: { organizationId: orgId } }),
        notices: await db.rentNotice.count({ where: { organizationId: orgId } }),
      }
      const checks = {
        counts,
        allaVerifikatBalanserar: balanced,
        aterimportIdempotent:
          JSON.stringify(beforeRetry) === JSON.stringify(afterRetry) && retry.duplicates === 1,
        koadeSkuggjobb: queue.filter((q) => q.organizationId === orgId).length,
      }
      results[arm] = { sammanfattning: summary(rows), kontroller: checks }
      writeFileSync(
        resolve(output, `${arm}-kontroller.json`),
        JSON.stringify(checks, null, 2) + '\n',
      )
      save()
      if (
        !balanced ||
        !checks.aterimportIdempotent ||
        rows.some((r) => r.status === 'TEKNISKT_FEL' || r.status === 'EJ_KORD')
      )
        process.exitCode = 2
      else if (!summary(rows).malMax20 || rows.some((r) => r.felaktigAutomatisk))
        process.exitCode = process.exitCode ?? 1
    }
    writeFileSync(
      resolve(output, 'sammanfattning.json'),
      JSON.stringify({ ...meta, resultat: results }, null, 2) + '\n',
    )
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    // Ingen env eller SDK-begäran skrivs ut. Endast denna lokala riggs fel.
    console.error(
      error instanceof Error
        ? error.message.replace(/postgresql:\/\/[^\s]+/g, '[testdatabas]')
        : 'Kundflödesprovet avbröts',
    )
    process.exitCode = 2
  })
