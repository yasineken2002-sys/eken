#!/usr/bin/env node
/**
 * SJÄLVTEST för annotate-added-migrations.mjs.
 *
 * En annoteringsvakt som slutar hitta något blir tyst — och tystnad ser exakt ut
 * som "inga migrationer i den här PR:en". Det är den defekt vakten själv finns
 * för att stänga, en nivå upp. Självtestet är därför kanariefågeln: det matar in
 * något som MÅSTE ge utslag och kräver att det gör det.
 */
import {
  migrationName,
  filterMigrationFiles,
  destructiveStatements,
} from './annotate-added-migrations.mjs'

let fel = 0
const rad = (ok, text) => {
  if (!ok) fel++
  console.log(`${ok ? '✓' : '✗ MISSLYCKADES'}  ${text}`)
}

// ── KANARIEFÅGEL: den verkliga #257-filen måste plockas upp ──────────────────
const VERKLIG = 'apps/api/prisma/migrations/20260728000000_drop_personal_number_cleartext/migration.sql'
rad(filterMigrationFiles([VERKLIG]).length === 1, 'den verkliga #257-migrationen passerar filtret')
rad(
  migrationName(VERKLIG) === '20260728000000_drop_personal_number_cleartext',
  'katalognamnet härleds rätt',
)

// ── Filtret släpper inte igenom annat ───────────────────────────────────────
rad(
  filterMigrationFiles(['apps/api/src/main.ts', 'README.md', 'prisma/migrations/x/y.sql'])
    .length === 0,
  'filer utanför apps/api/prisma/migrations/ filtreras bort',
)

// ── Destruktiv DDL upptäcks ─────────────────────────────────────────────────
rad(
  destructiveStatements('ALTER TABLE "Tenant" DROP COLUMN "personalNumber";').includes(
    'DROP COLUMN',
  ),
  'DROP COLUMN upptäcks',
)
rad(destructiveStatements('DROP TABLE "Foo";').includes('DROP TABLE'), 'DROP TABLE upptäcks')
rad(destructiveStatements('TRUNCATE "Foo";').includes('TRUNCATE'), 'TRUNCATE upptäcks')
rad(
  destructiveStatements('ALTER TABLE "A" DROP CONSTRAINT "a_fkey";').includes('DROP CONSTRAINT'),
  'DROP CONSTRAINT upptäcks',
)

// ── DISKRIMINERANDE: additiv DDL flaggas INTE ───────────────────────────────
// Utan det här vore alla kontroller ovan gröna även av en funktion som svarar
// "destruktiv" på allt.
rad(
  destructiveStatements('ALTER TABLE "Tenant" ADD COLUMN "personalNumberEnc" TEXT;').length === 0,
  'ADD COLUMN flaggas INTE',
)
rad(
  destructiveStatements('CREATE INDEX "x" ON "Tenant"("id");').length === 0,
  'CREATE INDEX flaggas INTE',
)

// ── Kommentarer ska inte kunna trigga flaggan ───────────────────────────────
rad(
  destructiveStatements('-- vi gör INTE DROP COLUMN här\nADD COLUMN "a" TEXT;').length === 0,
  'ordet i en radkommentar flaggas inte',
)
rad(
  destructiveStatements('/* ingen DROP TABLE */ ALTER TABLE "A" ADD COLUMN "b" TEXT;').length === 0,
  'ordet i en blockkommentar flaggas inte',
)

console.log(fel === 0 ? '\nSJÄLVTESTET PASSERADE' : `\n${fel} KONTROLL(ER) MISSLYCKADES`)
process.exit(fel === 0 ? 0 : 1)
