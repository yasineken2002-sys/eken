#!/usr/bin/env node
/**
 * CI-guard (T5 PR1b) — skyddar SANNINGSKÄLLAN för "är bokföringsperioden stängd?"
 * och APPEND-ONLY-egenskapen hos historiken bakom den.
 *
 * BAKGRUND. Frågan besvarades en gång på tre ställen med tre olika queries.
 * PR1a samlade dem i `accounting/closed-period.ts`; PR1b bytte representationen
 * (mutbar rad per period → append-only `AccountingPeriodEvent`, senaste
 * händelsen avgör). Bytet är säkert exakt så länge det finns EN uppslagning. En
 * fjärde kopia som slår upp tabellerna på egen hand är inte bara duplicering —
 * den kan ställa en ANNAN fråga än spärren:
 *
 *   findFirst({ where: { type: 'REOPENED' } })   ⟶  "har någonsin återöppnats"
 *
 * vilket läser som "perioden är öppen" för all framtid, även efter omstängning.
 * Det är en TYST TILLÅTARE: verifikat landar i en stängd period utan att någon
 * spärr säger ifrån. Guarden gör "en uppslagning" till en upprätthållen
 * invariant i stället för ett påstående i en kommentar.
 *
 * TVÅ REGLER:
 *
 *  (1) UPPSLAGNING/SKRIVNING ENDAST I closed-period.ts. Alla Prisma-anrop mot
 *      `accountingPeriodEvent` och `closedAccountingPeriod` — samt rå SQL mot
 *      "AccountingPeriodEvent"/"ClosedAccountingPeriod" — måste bo i den filen.
 *      Övriga moduler går via de exporterade hjälparna.
 *
 *  (2) HISTORIKEN ÄR APPEND-ONLY. `accountingPeriodEvent.update/updateMany/
 *      delete/deleteMany/upsert` är förbjudet ÖVERALLT, inklusive i
 *      closed-period.ts — en händelse skrivs en gång och ändras aldrig. Detta
 *      skyddar egenskapen, inte bara tabellnamnet: DB-nivåns skydd (ingen
 *      updatedAt, onDelete: Restrict, CHECK på reason) hindrar inte en UPDATE
 *      från applikationen. Samma klass av hål som FIX 3, där en cascade-delete
 *      tog ner en audit-logg.
 *
 * UNDANTAG: *.spec.ts (tester bygger medvetet attrapper och simulerar kringgång)
 * och migrations-SQL (som per definition rör tabellerna).
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:     node apps/api/scripts/check-period-lookup-source.mjs
 * Självtest:  node apps/api/scripts/check-period-lookup-source.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')

/** Enda filen som får röra modellerna direkt. */
const LOOKUP_FILE = join('accounting', 'closed-period.ts')

/** Prisma-modellerna som bär periodtillståndet. */
const MODELS = ['accountingPeriodEvent', 'closedAccountingPeriod']

/** Mutatorer som bryter append-only. `create`/`createMany` är tillåtna. */
const MUTATORS = ['update', 'updateMany', 'delete', 'deleteMany', 'upsert']

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/** Är den här filen den tillåtna uppslagningen? */
function isLookupFile(relPath) {
  return relPath.split('/').join(sep).endsWith(LOOKUP_FILE)
}

/**
 * Skanna EN källfils text → lista med regelbrott. Exporterad logik så självtestet
 * kör exakt samma kod som CI.
 */
export function scanSource(text, relPath) {
  const violations = []
  const inLookupFile = isLookupFile(relPath)

  // (2) Append-only-brott — gäller ÄVEN i closed-period.ts, därför först.
  const mutatorRe = new RegExp(
    `\\baccountingPeriodEvent\\s*\\.\\s*(${MUTATORS.join('|')})\\s*\\(`,
    'g',
  )
  let m
  while ((m = mutatorRe.exec(text))) {
    violations.push({
      line: lineOf(text, m.index),
      rule: `accountingPeriodEvent.${m[1]}() — bryter append-only`,
      detail:
        'En periodhändelse skrivs en gång och ändras aldrig. Rättelse sker genom att ' +
        'lägga en NY händelse, aldrig genom att skriva om eller radera den gamla.',
    })
  }

  // (1) Direkt modellåtkomst utanför den delade uppslagningen.
  if (!inLookupFile) {
    for (const model of MODELS) {
      const accessRe = new RegExp(`\\b${model}\\s*\\.\\s*[a-zA-Z]`, 'g')
      let a
      while ((a = accessRe.exec(text))) {
        violations.push({
          line: lineOf(text, a.index),
          rule: `direkt Prisma-åtkomst till ${model}`,
          detail:
            'Periodtillståndet får bara slås upp via accounting/closed-period.ts ' +
            '(isPeriodClosed / assertPeriodOpen / getClosedPeriods / getClosedPeriodStates).',
        })
      }
    }

    // Rå SQL mot tabellerna kringgår Prisma och därmed hela hjälparen.
    text.split('\n').forEach((ln, i) => {
      if (/["'`]?(AccountingPeriodEvent|ClosedAccountingPeriod)["'`]?/i.test(ln) === false) return
      if (/\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)/.test(ln)) {
        violations.push({
          line: i + 1,
          rule: 'rå $queryRaw/$executeRaw mot periodtabellerna',
          detail: 'Rå SQL kringgår den delade uppslagningen — flytta den till closed-period.ts.',
        })
      }
      if (/(insert\s+into|update|delete\s+from)\s+["'`]?(AccountingPeriodEvent|ClosedAccountingPeriod)\b/i.test(ln)) {
        violations.push({
          line: i + 1,
          rule: 'rå INSERT/UPDATE/DELETE mot periodtabellerna',
          detail: 'Skrivningar går via appendPeriodClosedEvent() i closed-period.ts.',
        })
      }
    })
  }

  return violations.map((v) => ({ ...v, file: relPath }))
}

// ── fil-traversering ─────────────────────────────────────────────────────────
function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) yield p
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
const GOOD = [
  [
    'uppslagning i closed-period.ts',
    'src/accounting/closed-period.ts',
    `const latest = await client.accountingPeriodEvent.findFirst({ where: { organizationId, year, month }, orderBy: { seq: 'desc' } })`,
  ],
  [
    'skrivning + spegling i closed-period.ts',
    'src/accounting/closed-period.ts',
    `await tx.accountingPeriodEvent.create({ data })\nawait tx.closedAccountingPeriod.create({ data })`,
  ],
  [
    'rå DISTINCT ON i closed-period.ts',
    'src/accounting/closed-period.ts',
    `const rows = await client.$queryRaw\`SELECT DISTINCT ON ("year","month") * FROM "AccountingPeriodEvent"\``,
  ],
  [
    'anropare går via hjälparen',
    'src/accounting/verifikationsnummer.service.ts',
    `await assertPeriodOpen(client, organizationId, date, 'ny verifikation kan inte skapas')`,
  ],
  [
    'bulkform via hjälparen',
    'src/avisering/rent-backfill.service.ts',
    `const closedSet = await getClosedPeriods(this.prisma, organizationId)`,
  ],
  [
    'orelaterad modell med liknande namn',
    'src/accounting/accounting.service.ts',
    `await this.prisma.journalEntry.create({ data })\nconst p = await this.prisma.accountingPeriodSummary.findMany()`,
  ],
]
const BAD = [
  [
    'fjärde kopia av uppslagningen',
    'src/consumption/consumption.service.ts',
    `const closed = await this.prisma.closedAccountingPeriod.findFirst({ where: { organizationId, year, month } })`,
  ],
  [
    'kopia mot den NYA modellen',
    'src/ai/tools/tool-executor.service.ts',
    `const ev = await this.prisma.accountingPeriodEvent.findFirst({ where: { organizationId, year, month } })`,
  ],
  [
    'typfiltrerad kopia (tyst tillåtare)',
    'src/avisering/rent-backfill.service.ts',
    `const reopened = await this.prisma.accountingPeriodEvent.findFirst({ where: { type: 'REOPENED' } })`,
  ],
  [
    'append-only-brott: update',
    'src/accounting/accounting-period.service.ts',
    `await this.prisma.accountingPeriodEvent.update({ where: { id }, data: { summary } })`,
  ],
  [
    'append-only-brott: delete',
    'src/accounting/accounting-period.service.ts',
    `await this.prisma.accountingPeriodEvent.delete({ where: { id } })`,
  ],
  [
    'append-only-brott ÄVEN i den tillåtna filen',
    'src/accounting/closed-period.ts',
    `await tx.accountingPeriodEvent.updateMany({ where: { organizationId }, data: { seq: 1 } })`,
  ],
  [
    'rå SQL-kringgång',
    'src/accounting/accounting.service.ts',
    `await this.prisma.$executeRawUnsafe('DELETE FROM "AccountingPeriodEvent" WHERE id = $1', id)`,
  ],
]

function selfTest() {
  let ok = true
  for (const [label, path, code] of GOOD) {
    const v = scanSource(code, path)
    if (v.length !== 0) {
      ok = false
      console.error(`❌ FALSKLARM på legitim kod: "${label}" → ${v.map((x) => x.rule).join(', ')}`)
    } else console.log(`✅ inget falsklarm: ${label}`)
  }
  for (const [label, path, code] of BAD) {
    const v = scanSource(code, path)
    if (v.length === 0) {
      ok = false
      console.error(`❌ MISSADE kringgång: "${label}" flaggades inte`)
    } else console.log(`✅ fångad kringgång: ${label} (${v[0].rule})`)
  }
  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const repoRoot = join(HERE, '..', '..', '..')
  const failures = []
  for (const file of walk(SRC_DIR)) {
    failures.push(...scanSource(readFileSync(file, 'utf8'), relative(repoRoot, file)))
  }

  if (failures.length > 0) {
    console.error('\n=== PERIODUPPSLAGNING: SANNINGSKÄLLA KRINGGÅNGEN (CI-guard) ===\n')
    for (const f of failures) {
      console.error(`❌ ${f.file}:${f.line}\n   ${f.rule}\n   ${f.detail}`)
    }
    console.error(
      '\nÅtgärd: gå via apps/api/src/accounting/closed-period.ts.\n' +
        '  • "är perioden stängd?"  → isPeriodClosed() / assertPeriodOpen()\n' +
        '  • många perioder på en gång → getClosedPeriods() / getClosedPeriodStates()\n' +
        '  • stänga en period        → appendPeriodClosedEvent() i en $transaction\n' +
        'Historiken är append-only: rätta genom att lägga en NY händelse.\n',
    )
    process.exit(1)
  }

  console.log(
    '✅ Periodtillståndet slås upp uteslutande via closed-period.ts, och historiken är append-only.',
  )
}

main()
