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
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

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
  {
    label: 'en LEVANDE hyreshöjning per avtal och ikraftträdande',
    expectedName: 'rent_increase_lease_effective_live_unique',
    migrationRef: '20260902150000_rent_increase_live_unique',
    unique: true,
    table: 'RentIncrease',
    columns: ['leaseId', 'effectiveDate'],
    // PARTIELLT med flit: en återkallad, nekad eller annullerad höjning gör
    // inte längre anspråk på datumet, och en ny för samma datum är då en
    // legitim andra handling. Faller predikatet bort blir villkoret för grovt
    // och blockerar den — därför står statuslistan i invarianten och inte bara
    // i migrationen.
    where: "statusIN('DRAFT','NOTICE_SENT','ACCEPTED','APPLIED')",
  },
  {
    label: 'en hyresfaktura per avtal och period',
    expectedName: 'invoice_rent_period_unique',
    migrationRef: '20260902170000_invoice_rent_period',
    unique: true,
    table: 'Invoice',
    columns: ['leaseId', 'rentPeriodYear', 'rentPeriodMonth'],
    // PREDIKATET ÄR KONSTRUKTIONEN och står därför i invarianten, inte bara i
    // migrationen. `creditedInvoiceId IS NULL` är det led en läsare frestas att
    // "förenkla" bort: credit-note.service skriver `type: original.type`, så en
    // kreditnota på en hyresfaktura är SJÄLV type='RENT' med samma leaseId och
    // period — och att kreditera i samma månad är normalfallet.
    where: "type='RENT'ANDcreditedInvoiceIdISNULLANDstatus<>'VOID'",
  },
  {
    label: 'återupptagningsmotorns läsning av PÅBÖRJADE verktygskörningar',
    expectedName: 'ai_tool_execution_started_idx',
    migrationRef: '20260902180000_ai_resumption_shadow',
    // ── DEN HÄR ÄR EN PRESTANDAINVARIANT, INTE EN KORREKTHETSINVARIANT ──────
    //
    // De tre ovan gör en felaktig SKRIVNING omöjlig. Den här gör inte det:
    // försvinner den blir ingenting fel, bara långsamt. Den står här ändå,
    // eftersom den delar exakt den sårbarhet guarden finns för — partiell,
    // odeklarerbar i schema.prisma, och därmed något en `migrate dev` kan se
    // som drift och tyst DROP:a.
    //
    // Kostnaden om den faller bort: motorn kör en full scan av AiToolExecution
    // varje varv. Tabellen är liten i dag (11 rader i prod) och det märks inte
    // — vilket är själva skälet att skydda den nu i stället för den dag den
    // inte är liten.
    unique: false,
    table: 'AiToolExecution',
    columns: ['createdAt'],
    // PREDIKATET ÄR HELA POÄNGEN. Utan det är indexet ett fullt index över
    // varje AI-verktygsanrop som någonsin skett, och skrivkostnaden bärs av
    // varje anrop för en läsare som bara bryr sig om de påbörjade.
    where: 'completedAtISNULL',
  },
  {
    label: 'ETT leveransutfall per UTSKICK — inte per avi (#656)',
    expectedName: 'RentNoticeEvent_delivery_idempotency_key',
    migrationRef: '20260902200000_leverans_per_utskick',
    unique: true,
    table: 'RentNoticeEvent',
    // ENHETEN ÄR INVARIANTEN. Utan `sendId` påstår villkoret "en avi kan studsa
    // en gång", och en omsändning som studsar igen går inte att registrera —
    // webhooken fångar P2002 som no-op och utfallet försvinner tyst.
    //
    // Faller kolumnen bort blir INV-B dessutom omöjlig att svara rätt på: den
    // läser det SENASTE utskickets utfall, och utan enhet finns inget senaste.
    columns: ['rentNoticeId', 'type', 'sendId'],
    // De fyra typerna står i invarianten och inte bara i migrationen: tas en av
    // dem bort tappar just den sin idempotens under Resends at-least-once, i en
    // append-only-tabell där dubbletten inte går att städa bort.
    where:
      "typeIN('EMAIL_DELIVERED','EMAIL_BOUNCED','NOTICE_EMAIL_DELIVERED','NOTICE_EMAIL_BOUNCED')",
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

    // Ta bort rad-kommentarer via den DELADE SQL-skannern, dela på ';',
    // normalisera whitespace per statement. Den nakna `--`-regexen kunde inte
    // strängar: ett `--` inuti en literal hade ätit resten av raden.
    // (Index-DDL har aldrig ';' i sina literaler, så ;-split är säker för dessa.)
    const statements = withoutComments(readFileSync(sqlPath, 'utf8'), { dialect: 'sql' })
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
        console.log(
          `✅ ${inv.label}\n   "${inv.expectedName}" intakt (${inv.unique ? 'UNIQUE ' : ''}ON ${inv.table}(${inv.columns.join(',')})` +
            `${inv.where ? ` WHERE ${inv.where}` : ''}).`,
        )
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
