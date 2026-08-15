#!/usr/bin/env node
/**
 * SYNLIGGÖR VARJE MIGRATION SOM EN PR LÄGGER TILL.
 *
 * Bakgrunden är #256/#257. #257 var stackad ovanpå #256:s gren, så dess squash
 * bar med sig HELA #256 — inklusive en oåterkallelig `DROP COLUMN` på
 * personnummer-klartexten — under titeln "larm + väntegolv när själva köandet
 * fallerar". Ingen ljög: #257:s PR-text var korrekt för sitt eget arbete.
 * Informationen fanns bara ingenstans.
 *
 * En regel hade inte hjälpt, eftersom ingen bröt mot någon. Det som saknades var
 * SYNLIGHET: en granskare som sett raden "lägger till migration:
 * drop_personal_number_cleartext" hade frågat varför.
 *
 * Vakten är ICKE-BLOCKERANDE med flit. Den påstår ingenting om att en migration
 * är fel — den påstår bara att den finns. Att fälla en PR för att den innehåller
 * en migration vore fel; att låta den passera osynlig var det som hände.
 *
 * TYSTNAD ÄR ETT UTFALL, INTE FRÅNVARO AV UTFALL. Noll tillagda migrationer
 * skrivs ut explicit — annars går "inga migrationer" inte att skilja från "steget
 * kördes aldrig", vilket är den vanligaste defekten i en grön kontroll.
 *
 * Användning:
 *   node annotate-added-migrations.mjs <bas-ref>     — härleder listan ur git
 *   node annotate-added-migrations.mjs --stdin       — läser filnamn från stdin
 *                                                      (självtestets väg)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'

const MIGRATIONS_PREFIX = 'apps/api/prisma/migrations/'

/**
 * DDL som inte går att ångra genom att köra en ny migration. `DROP TABLE` och
 * `DROP COLUMN` förstör data; resten ändrar bara form. Listan är avsiktligt kort
 * — den ska peka på det som förtjänar en fråga, inte flagga varje migration.
 */
const DESTRUKTIV = [
  { mönster: /\bDROP\s+TABLE\b/i, vad: 'DROP TABLE' },
  { mönster: /\bDROP\s+COLUMN\b/i, vad: 'DROP COLUMN' },
  { mönster: /\bTRUNCATE\b/i, vad: 'TRUNCATE' },
  { mönster: /\bDROP\s+CONSTRAINT\b/i, vad: 'DROP CONSTRAINT' },
]

/** Filnamn → migrationens katalognamn (det en granskare känner igen). */
export function migrationName(file) {
  const rest = file.slice(MIGRATIONS_PREFIX.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

/** Behåll bara filer som ligger under migrations-katalogen. */
export function filterMigrationFiles(files) {
  return files.map((f) => f.trim()).filter((f) => f.startsWith(MIGRATIONS_PREFIX))
}

/** Vilka destruktiva satser finns i SQL:en? Tom lista = inga. */
export function destructiveStatements(sql) {
  // Blockkommentarer och radkommentarer bort först — en migration som FÖRKLARAR
  // varför den inte droppar något ska inte flaggas för ordet.
  const utanKommentarer = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  return DESTRUKTIV.filter((d) => d.mönster.test(utanKommentarer)).map((d) => d.vad)
}

function addedFilesFromGit(baseRef) {
  const ut = execFileSync(
    'git',
    ['diff', '--diff-filter=A', '--name-only', `${baseRef}...HEAD`, '--', MIGRATIONS_PREFIX],
    { encoding: 'utf8' },
  )
  return ut.split('\n').filter(Boolean)
}

function main() {
  const args = process.argv.slice(2)
  const rader = []

  const filer = args[0] === '--stdin'
    ? filterMigrationFiles(readFileSync(0, 'utf8').split('\n'))
    : filterMigrationFiles(addedFilesFromGit(args[0] ?? 'origin/main'))

  const perMigration = new Map()
  for (const f of filer) {
    const namn = migrationName(f)
    if (!perMigration.has(namn)) perMigration.set(namn, [])
    perMigration.get(namn).push(f)
  }

  if (perMigration.size === 0) {
    console.log('::notice title=Migrationer::Denna PR lägger inte till någon migration.')
    rader.push('Denna PR lägger **inte** till någon migration.')
  } else {
    rader.push(`Denna PR lägger till **${perMigration.size}** migration(er):`, '')
    for (const [namn, files] of perMigration) {
      const sqlFil = files.find((f) => f.endsWith('.sql'))
      const sql = sqlFil && existsSync(sqlFil) ? readFileSync(sqlFil, 'utf8') : ''
      const destruktiva = destructiveStatements(sql)
      const suffix = destruktiva.length ? ` — innehåller ${destruktiva.join(', ')}` : ''

      console.log(
        `::notice file=${sqlFil ?? files[0]},title=Migration tillagd::${namn}${suffix}`,
      )
      rader.push(
        destruktiva.length
          ? `- \`${namn}\` — ⚠ **${destruktiva.join(', ')}** (oåterkalleligt — stäm av att det är avsikten med PR:ens titel)`
          : `- \`${namn}\``,
      )
    }
    rader.push(
      '',
      'Stackade PR:er bär hela stacken under den beroende PR:ens titel (#256/#257). ' +
        'Stämmer listan inte med vad PR:en säger sig göra — fråga.',
    )
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Migrationer\n\n${rader.join('\n')}\n`)
  }
  for (const r of rader) console.log(r.replace(/\*\*/g, ''))
}

if (process.argv[1] && process.argv[1].endsWith('annotate-added-migrations.mjs')) main()
