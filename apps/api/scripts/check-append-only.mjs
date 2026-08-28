#!/usr/bin/env node
/**
 * APPEND-ONLY MÅSTE BO I DATABASEN, INTE I VANAN.
 *
 * ── VAD SOM MÄTTES ──────────────────────────────────────────────────────────
 *
 * Red team-revisionen prövade egenskapen mot en riktig PG 18.6:
 *
 *     UPDATE "InvoiceEvent" …  → LYCKADES
 *     DELETE FROM "InvoiceEvent" …  → LYCKADES
 *
 * Koden var ren — noll `invoiceEvent.update/delete` i apps/api/src — men
 * egenskapen fanns bara i vanan. Ett revisionsspår som GÅR att ändra är inget
 * revisionsspår när någon frågar.
 *
 * ── VARFÖR TRIGGER OCH INTE REVOKE ──────────────────────────────────────────
 *
 * Mätt mot prod: appen ansluter som `postgres`, som både ÄGER alla 88 tabeller
 * och är SUPERUSER. `REVOKE` gäller inte ägaren och en superuser förbigår
 * rättighetskontrollen. Prövat sida vid sida mot ett kluster i samma läge:
 *
 *     REVOKE UPDATE mot ägaren  → UPDATE LYCKADES
 *     BEFORE UPDATE-trigger     → UPDATE AVVISADES
 *
 * ── VAD VAKTEN GÖR ──────────────────────────────────────────────────────────
 *
 * Håller TVÅ HÄRLEDDA MÄNGDER lika, åt båda hållen:
 *
 *   A. modeller vars docblock i `schema.prisma` SÄGER append-only
 *   B. tabeller som har en `append_only_*`-trigger i migrationerna
 *
 * A ⊄ B  → någon har skrivit avsikten men inte spärren.
 * B ⊄ A  → någon har tagit bort avsikten men lämnat spärren (eller tvärtom).
 *
 * Ingen lista att underhålla: skriver du "append-only" i ett docblock ärver
 * modellen kravet, och tar du bort triggern blir CI röd.
 *
 * ── VAD VAKTEN INTE GÖR ─────────────────────────────────────────────────────
 *
 * Den är statisk och kan bara se att spärren står i en migration. Att den
 * FAKTISKT GÄLLER i en levande databas ägs av `append-only.db.spec.ts`, som
 * kör en riktig UPDATE mot en riktig Postgres och kräver att den avvisas. Att
 * något står i en migration är inte samma sak som att det gäller.
 *
 * Självtest: node apps/api/scripts/check-append-only.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blankComments, withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const MIGRATIONS = join(HERE, '..', 'prisma', 'migrations')
const TRIGGER_PREFIX = 'append_only_'

/**
 * Modeller vars DOCBLOCK säger append-only.
 *
 * Kommentarerna ÄR indatan här — det är i dem avsikten står — så texten läses
 * rå med flit. Men modellgränserna läses ur `withoutComments`, så en `model`-rad
 * som står inuti ett kodexempel i en kommentar inte kan uppfinna en modell.
 */
export function avsiktISchema(text) {
  // `blankComments` och INTE `withoutComments`, och skälet är MÄTT — inte det
  // jag först skrev här.
  //
  // Algoritmen indexerar PER RAD: den hittar `model`-raden i den maskerade vyn
  // och går bakåt i den RÅ vyn efter docblocket. Det kräver att de två vyerna
  // har samma radnummer.
  //
  //   `//`-kommentar : båda bevarar radantalet — här är valet likgiltigt
  //   BLOCKkommentar : withoutComments 6 rader → 4, blankComments 6 → 6
  //
  // Prisma-docblocken är `//`-rader i dag, så det spelar ingen roll just nu.
  // Men en `/* … */` någonstans i schemat hade tyst flyttat varje efterföljande
  // radnummer, och docblocken hade slutat hittas utan att något blev rött.
  // blankComments gör invarianten till en egenskap hos primitiven i stället för
  // hos indatan.
  const kodrader = blankComments(text).split('\n')
  const rårader = text.split('\n')
  const ut = []
  for (let i = 0; i < kodrader.length; i++) {
    const m = /^model\s+(\w+)\s*\{/.exec(kodrader[i])
    if (!m) continue
    // gå bakåt genom det sammanhängande kommentarsblocket ovanför
    const doc = []
    for (let j = i - 1; j >= 0; j--) {
      const rå = rårader[j].trim()
      if (rå === '') {
        if (doc.length) break
        continue
      }
      if (!rå.startsWith('//')) break
      doc.push(rå)
    }
    if (/append[-\s]only/i.test(doc.join('\n'))) ut.push(m[1])
  }
  return [...new Set(ut)].sort()
}

/** Tabeller som har en append_only_*-trigger i någon migration. */
export function triggrarIMigrationer(sqlTexter) {
  const ut = []
  for (const sql of sqlTexter) {
    // SQL-dialekten: `--`-kommentarer bort, strängar intakta. Utan den skulle
    // en trigger som bara NÄMNS i migrationens motivering räknas som byggd.
    const kod = withoutComments(sql, { dialect: 'sql' })
    const re = new RegExp(
      `CREATE\\s+TRIGGER\\s+${TRIGGER_PREFIX}\\w+\\s+BEFORE\\s+UPDATE\\s+ON\\s+"([^"]+)"`,
      'gi',
    )
    let m
    while ((m = re.exec(kod)) !== null) ut.push(m[1])
    // ...och en borttagning räknas bort igen.
    const drop = new RegExp(`DROP\\s+TRIGGER[^;]*?ON\\s+"([^"]+)"`, 'gi')
    while ((m = drop.exec(kod)) !== null) {
      const i = ut.indexOf(m[1])
      if (i !== -1) ut.splice(i, 1)
    }
  }
  return [...new Set(ut)].sort()
}

function migrationsSql() {
  const ut = []
  for (const d of readdirSync(MIGRATIONS)) {
    const p = join(MIGRATIONS, d)
    if (!statSync(p).isDirectory()) continue
    const f = join(p, 'migration.sql')
    try {
      ut.push(readFileSync(f, 'utf8'))
    } catch {
      /* katalog utan migration.sql */
    }
  }
  return ut
}

export function jämför(avsikt, triggrar) {
  const fel = []
  for (const m of avsikt) {
    if (!triggrar.includes(m)) {
      fel.push(
        `${m} — docblocket i schema.prisma säger append-only, men ingen ` +
          `${TRIGGER_PREFIX}-trigger finns i någon migration. Egenskapen bor då bara i ` +
          'vanan: mätt mot riktig Postgres går en sådan rad att UPDATE:a.',
      )
    }
  }
  for (const t of triggrar) {
    if (!avsikt.includes(t)) {
      fel.push(
        `${t} — har en ${TRIGGER_PREFIX}-trigger men inget docblock som säger ` +
          'append-only. Antingen försvann avsikten ur schemat (skriv tillbaka den) ' +
          'eller så spärrades en tabell som inte skulle spärras.',
      )
    }
  }
  return fel
}

function kör() {
  const avsikt = avsiktISchema(readFileSync(SCHEMA, 'utf8'))
  const triggrar = triggrarIMigrationer(migrationsSql())

  // FÖRUTSÄTTNINGSVAKT. Noll avsikter betyder att parsningen slutat läsa, inte
  // att ingen tabell är append-only — ett tomt svep ser ut precis som ett rent.
  if (avsikt.length === 0) {
    console.error(
      '❌ Vakten hittade NOLL append-only-avsikter i schema.prisma. Den mäter inget längre.',
    )
    process.exit(1)
  }

  const fel = jämför(avsikt, triggrar)
  if (fel.length) {
    console.error('❌ Append-only: avsikt och spärr är inte i synk\n')
    for (const f of fel) console.error(`  • ${f}\n`)
    process.exit(1)
  }
  console.error(
    `✅ Append-only: ${avsikt.length} modeller säger det i schemat, och alla ${triggrar.length} ` +
      'har en BEFORE UPDATE-trigger i migrationerna. (DELETE är med flit inte spärrad — ' +
      'organisationsraderingen och retentionen behöver den.)',
  )
}

function självtest() {
  const fel = []
  const t = (namn, villkor, detalj) => {
    if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`)
  }

  // ── KANARIE 0: mängderna jämförs mot ett tal HÄRLETT UR KÄLLAN ─────────────
  const avsikt = avsiktISchema(readFileSync(SCHEMA, 'utf8'))
  const triggrar = triggrarIMigrationer(migrationsSql())
  // Oberoende räkning: hur många migrationsrader skapar en sådan trigger?
  let råttAntal = 0
  for (const sql of migrationsSql()) {
    råttAntal += (sql.match(/^\s*CREATE TRIGGER append_only_/gim) ?? []).length
  }
  t(
    'KANARIE 0 (vakten ser lika många triggrar som en rå sökning)',
    triggrar.length === råttAntal,
    `vakten ${triggrar.length}, rå sökning ${råttAntal}`,
  )
  t(
    'KANARIE 0 (mängden är inte tom)',
    avsikt.length > 0 && triggrar.length > 0,
    `avsikt ${avsikt.length}, triggrar ${triggrar.length}`,
  )
  t(
    'KANARIE 0 (baslinjen är i synk)',
    jämför(avsikt, triggrar).length === 0,
    JSON.stringify(jämför(avsikt, triggrar)),
  )

  // ── R1 åt båda hållen ─────────────────────────────────────────────────────
  t('avsikt utan trigger → 1 fel', jämför(['X'], []).length === 1)
  t('trigger utan avsikt → 1 fel', jämför([], ['X']).length === 1)
  t('paritet → 0 fel', jämför(['X'], ['X']).length === 0)

  // ── KOMMENTARER OCH PROSA FÅR INTE UPPFYLLA REGLERNA ──────────────────────
  //
  // Samma defekt som fällde check-transaction-limits: en regel som frågar
  // råtexten blir grön av en förklaring.
  const sqlMedProsa = `-- CREATE TRIGGER append_only_zz BEFORE UPDATE ON "ZzProsa" — bara nämnd\nSELECT 1;`
  t(
    'KANARIE: en trigger som bara NÄMNS i en SQL-kommentar räknas inte',
    triggrarIMigrationer([sqlMedProsa]).length === 0,
    JSON.stringify(triggrarIMigrationer([sqlMedProsa])),
  )

  const sqlRiktig = `CREATE TRIGGER append_only_zz BEFORE UPDATE ON "ZzRiktig" FOR EACH ROW EXECUTE FUNCTION append_only_guard();`
  t(
    'KANARIE: en riktig trigger räknas',
    triggrarIMigrationer([sqlRiktig]).join() === 'ZzRiktig',
    JSON.stringify(triggrarIMigrationer([sqlRiktig])),
  )

  t(
    'KANARIE: en DROP tar bort den igen',
    triggrarIMigrationer([sqlRiktig, `DROP TRIGGER append_only_zz ON "ZzRiktig";`]).length === 0,
  )

  // En `model`-rad inuti en kommentar får inte uppfinna en modell.
  // SONDNAMNEN ÄR ASCII MED FLIT. Första versionen hette `ZzÄkta`, och `\w` i
  // JS matchar inte `Ä` — kanariefågeln föll då på SIG SJÄLV och såg ut som
  // blindhet i vakten. Prisma-identifierare är ASCII, så begränsningen är
  // ofarlig; det var provet som var fel, inte regeln.
  const schemaProsa = `// exempel:\n// model ZzFalsk {   append-only\n// }\nmodel ZzAkta {\n  id String\n}\n`
  t(
    'KANARIE: en model-rad i en KOMMENTAR uppfinner ingen avsikt',
    !avsiktISchema(schemaProsa).includes('ZzFalsk'),
    JSON.stringify(avsiktISchema(schemaProsa)),
  )

  const schemaAkta = `// append-only tabell.\nmodel ZzAkta {\n  id String\n}\n`
  t(
    'KANARIE: ett riktigt docblock hittas',
    avsiktISchema(schemaAkta).join() === 'ZzAkta',
    JSON.stringify(avsiktISchema(schemaAkta)),
  )

  const schemaUtan = `// en helt vanlig tabell.\nmodel ZzVanlig {\n  id String\n}\n`
  t('KANARIE: en modell UTAN avsikten plockas inte upp', avsiktISchema(schemaUtan).length === 0)

  // KANARIE: en BLOCKkommentar får inte flytta radnumren.
  //
  // Det är det enda fallet där valet av mask spelar roll, och därför det enda
  // som gör valet lastbärande. Mätt: `withoutComments` gör 6 rader till 4 vid en
  // `/* … */`, `blankComments` behåller 6. Byts primitiven tillbaka faller den
  // här raden — inte de andra.
  const schemaBlock = `/* en\n   flerradig\n   notis */\n// append-only tabell.\nmodel ZzBlock {\n  id String\n}\n`
  t(
    'KANARIE: en blockkommentar flyttar inte radnumren',
    avsiktISchema(schemaBlock).join() === 'ZzBlock',
    JSON.stringify(avsiktISchema(schemaBlock)),
  )

  // Den DELADE skannerns egna kanariefåglar.
  for (const f of kanariefåglar()) t(`delad skanner: ${f}`, false)

  if (fel.length) {
    console.error('❌ Självtestet föll:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(
    `✅ Självtest grönt — ${avsikt.length} avsikter, ${triggrar.length} triggrar (lika många som en rå sökning).`,
  )
}

if (process.argv.includes('--self-test')) självtest()
else kör()
