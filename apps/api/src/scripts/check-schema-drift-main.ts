/**
 * CI-ingången för schemadriftsvakten (#512).
 *
 * Kör `prisma migrate diff` mellan migrationshistoriken och `schema.prisma` och
 * lämnar utfallet till den rena logiken i `check-schema-drift.ts`.
 *
 * Kräver en TOM shadow-databas: Prisma spelar upp alla migrationer i den för att
 * veta vad historiken faktiskt ger. Den skrivs aldrig till av oss och innehåller
 * ingen data.
 */

import { execFileSync } from 'child_process'
import { join } from 'path'
import {
  parseDriftStatements,
  evaluateDrift,
  formatVerdict,
  loadAcknowledgements,
} from './check-schema-drift'

const API_ROOT = join(__dirname, '..', '..')
const SCHEMA = join(API_ROOT, 'prisma', 'schema.prisma')
const MIGRATIONS = join(API_ROOT, 'prisma', 'migrations')
const ACK = join(API_ROOT, 'prisma', 'schema-drift-acknowledged.json')

function main(): void {
  const shadow = process.env['SHADOW_DATABASE_URL']
  if (!shadow) {
    // Fail-fast, inte hoppa över: en vakt som tyst skippar sig själv när en
    // variabel saknas är grön för alltid. Precis den defekten den här filen
    // finns för att förhindra.
    console.error('SHADOW_DATABASE_URL saknas — vakten kan inte köra.')
    process.exit(1)
  }

  const sql = execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      MIGRATIONS,
      '--to-schema-datamodel',
      SCHEMA,
      '--shadow-database-url',
      shadow,
      '--script',
    ],
    { cwd: API_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )

  const statements = parseDriftStatements(sql)
  const acknowledged = loadAcknowledgements(ACK)
  const verdict = evaluateDrift(statements, acknowledged)
  const { rapport, fall } = formatVerdict(verdict)

  console.warn(`Satser i diffen: ${statements.length}`)
  console.warn(rapport)
  process.exit(fall ? 1 : 0)
}

main()
