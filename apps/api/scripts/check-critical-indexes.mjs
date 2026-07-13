#!/usr/bin/env node
/**
 * CI-guard (T5 Fas B2 / launch-readiness #59) — skyddar kritiska partiella DB-index
 * som Prisma INTE kan deklarera i schema.prisma och som därför bara lever i
 * migrations-SQL. En framtida `prisma migrate dev` kan se ett sådant index som
 * "drift" och generera en DROP → nästa `migrate deploy` tar bort skyddet TYST.
 * (Samma drift-klass har hänt en gång: Organization_status_idx.)
 *
 * Guarden bygger det KUMULATIVA sluttillståndet ur alla migration.sql (i Prismas
 * appliceringsordning = lexikografisk katalogordning) och failar bygget om ett
 * kritiskt index saknas / DROP:ats / FÖRSVAGATS.
 *
 * Matchar på SEMANTIK, inte bara namn:
 *   • en legitim omdöpning (samma definition, nytt namn) → PASSAR (inget falsklarm)
 *   • en tyst omdefinition (t.ex. WHERE-villkor ändrat, unique borttaget,
 *     kolumnlista ändrad) → FÅNGAS.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → kan köras som eget CI-steg
 * i en pipeline utan databas. Lokalt: `node apps/api/scripts/check-critical-indexes.mjs`
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', 'prisma', 'migrations')

/**
 * Deklarativa invarianter. `where`/`columns` anges i NORMALISERAD form (utan
 * blanksteg/dubbelcitat) så jämförelsen blir stabil mot formatteringsskillnader.
 * Lägg till fler rader här om fler icke-deklarerbara index tillkommer.
 */
const CRITICAL_INDEXES = [
  {
    label: 'dubbeluthyrnings-skydd — högst ETT ACTIVE-kontrakt per enhet',
    expectedName: 'lease_unit_active_unique',
    migrationRef: '20260426120000_lease_active_unique',
    unique: true,
    table: 'Lease',
    columns: ['unitId'],
    where: "status='ACTIVE'",
  },
]

// ── normalisering ──────────────────────────────────────────────────────────
const stripIdentQuotes = (s) => s.replace(/["`]/g, '') // bara identifierare, ej '-literaler
const normTable = (s) => stripIdentQuotes(s).replace(/^\w+\./, '') // ta bort ev. schema-prefix
const normCols = (s) =>
  s
    .split(',')
    .map((c) => stripIdentQuotes(c).trim())
    .filter(Boolean)
// WHERE-predikat: ta bort blanksteg + identifierar-citat + Postgres ::text-casts.
// Behåller '-literaler (så 'ACTIVE' inte tappas). null om inget WHERE.
const normPredicate = (s) => (s ? stripIdentQuotes(s).replace(/::text/gi, '').replace(/\s+/g, '') : null)

// ── parsers (körs på whitespace-normaliserade, ;-delade statements) ─────────
const CREATE_RE =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s(]+)"?\s+ON\s+(?:ONLY\s+)?((?:"?\w+"?\.)?"?[^"\s(]+"?)\s*\(([^)]*)\)\s*(?:WHERE\s+(.+))?$/i
const DROP_RE = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?((?:"?\w+"?\.)?"?[^"\s;]+"?)/i
const RENAME_RE =
  /^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\.)?"?[^"\s]+"?)\s+RENAME\s+TO\s+"?([^"\s;]+)"?/i

/** Bygg index-sluttillståndet: name -> {unique, table, columns[], where, origin}. */
function buildFinalIndexState() {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort() // lexikografisk = Prismas appliceringsordning

  const indexes = new Map()

  for (const dir of dirs) {
    const sqlPath = join(MIGRATIONS_DIR, dir, 'migration.sql')
    if (!existsSync(sqlPath)) continue

    // Ta bort rad-kommentarer, dela på ';', normalisera whitespace per statement.
    // (Index-DDL har aldrig ';' i sina literaler, så ;-split är säker för dessa.)
    const statements = readFileSync(sqlPath, 'utf8')
      .replace(/--[^\n]*/g, ' ')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    for (const st of statements) {
      let m
      if ((m = CREATE_RE.exec(st))) {
        indexes.set(stripIdentQuotes(m[2]), {
          unique: !!m[1],
          table: normTable(m[3]),
          columns: normCols(m[4]),
          where: normPredicate(m[5] ?? ''),
          origin: dir,
        })
      } else if ((m = DROP_RE.exec(st))) {
        indexes.delete(normTable(m[1]))
      } else if ((m = RENAME_RE.exec(st))) {
        const oldName = normTable(m[1])
        const newName = stripIdentQuotes(m[2])
        if (indexes.has(oldName)) {
          indexes.set(newName, indexes.get(oldName))
          indexes.delete(oldName)
        }
      }
    }
  }
  return indexes
}

const satisfies = (idx, inv) =>
  idx.unique === inv.unique &&
  idx.table === inv.table &&
  idx.columns.length === inv.columns.length &&
  idx.columns.every((c, i) => c === inv.columns[i]) &&
  idx.where === inv.where

function main() {
  const indexes = buildFinalIndexState()
  const failures = []

  for (const inv of CRITICAL_INDEXES) {
    const semanticMatch = [...indexes.entries()].find(([, idx]) => satisfies(idx, inv))
    if (semanticMatch) {
      const [foundName] = semanticMatch
      if (foundName === inv.expectedName) {
        console.log(`✅ ${inv.label}\n   "${inv.expectedName}" intakt (UNIQUE ON ${inv.table}(${inv.columns.join(',')}) WHERE ${inv.where}).`)
      } else {
        console.log(
          `ℹ️  ${inv.label}\n   Hittad under namnet "${foundName}" (förväntat "${inv.expectedName}") — semantiken bevarad → OK (omdöpning).`,
        )
      }
      continue
    }

    // Inget matchade semantiskt → diagnostisera VARFÖR (saknas vs försvagat).
    const byName = indexes.get(inv.expectedName)
    const wantDef = `${inv.unique ? 'UNIQUE ' : ''}INDEX ON "${inv.table}"("${inv.columns.join('","')}") WHERE ${inv.where}`
    if (!byName) {
      failures.push(
        `❌ ${inv.label}\n` +
          `   Index "${inv.expectedName}" SAKNAS i migrations-sluttillståndet — aldrig skapat, eller\n` +
          `   DROP:at utan ersättning (inget annat index har samma semantik). Skyddet är BORTA.\n` +
          `   Förväntat: ${wantDef}\n` +
          `   Referens-migration: ${inv.migrationRef}`,
      )
    } else {
      const diffs = []
      if (byName.unique !== inv.unique) diffs.push(`unique=${byName.unique} (förväntat ${inv.unique})`)
      if (byName.table !== inv.table) diffs.push(`table=${byName.table} (förväntat ${inv.table})`)
      if (byName.columns.join(',') !== inv.columns.join(','))
        diffs.push(`kolumner=(${byName.columns.join(',')}) (förväntat (${inv.columns.join(',')}))`)
      if (byName.where !== inv.where) diffs.push(`WHERE ${byName.where ?? '(saknas)'} (förväntat WHERE ${inv.where})`)
      failures.push(
        `❌ ${inv.label}\n` +
          `   Index "${inv.expectedName}" finns men dess definition har FÖRSVAGATS (ändrad i migration ${byName.origin}):\n` +
          diffs.map((d) => `     • ${d}`).join('\n') +
          `\n   En försvagad WHERE/kolumnlista/unique luckrar skyddet. Förväntat: ${wantDef}`,
      )
    }
  }

  if (failures.length > 0) {
    console.error('\n=== KRITISKT DB-INDEXSKYDD BRUTET (CI-guard · T5 Fas B2 · #59) ===\n')
    console.error(failures.join('\n\n'))
    console.error(
      '\nBakgrund: partiella index kan inte deklareras i schema.prisma (Prisma-begränsning),\n' +
        'så de lever bara i migrations-SQL. En `prisma migrate dev` kan ha tolkat det som drift\n' +
        'och genererat en DROP. Åtgärd: lägg till en ny migration som återställer indexet med\n' +
        'exakt rätt definition INNAN merge.\n',
    )
    process.exit(1)
  }

  console.log(`\n✅ Alla ${CRITICAL_INDEXES.length} kritiska index intakta i migrations-sluttillståndet.`)
}

main()
