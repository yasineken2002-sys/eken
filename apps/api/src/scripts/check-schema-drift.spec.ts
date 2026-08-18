/**
 * Vakten mot destruktiv schemadrift (#512) — dess egna kontroller.
 *
 * Den LEVANDE kontrollen (kör `migrate diff` mot en shadow-databas) sitter i
 * CI-jobbet `schema-drift-guard`, eftersom den kräver Postgres. Här testas den
 * rena logiken och kvitteringsfilens form — det som går att pröva utan DB.
 */

import { join } from 'path'
import {
  parseDriftStatements,
  evaluateDrift,
  formatVerdict,
  loadAcknowledgements,
} from './check-schema-drift'

const ACK_PATH = join(__dirname, '..', '..', 'prisma', 'schema-drift-acknowledged.json')

describe('parsern', () => {
  it('KANARIEFÅGEL: strippar kommentarer — annars är varje diff destruktiv', () => {
    // `migrate diff` skriver "-- DropIndex" som RUBRIK ovanför varje sats. Utan
    // strippningen hade rubriken räknats som en destruktiv sats, vakten varit
    // röd på varje körning, och därmed lärt folk att ignorera den.
    const s = parseDriftStatements('-- DropIndex\nCREATE INDEX "x" ON "y"("z");')
    expect(s).toHaveLength(1)
    expect(s[0]!.destructive).toBe(false)
  })

  it('normaliserar blanksteg och semikolon så kvitteringar kan matchas exakt', () => {
    const s = parseDriftStatements('DROP   INDEX\n  "a_idx";\n')
    expect(s[0]!.sql).toBe('DROP INDEX "a_idx"')
  })

  it.each([
    ['DROP INDEX "a"', true],
    ['DROP TABLE "a"', true],
    ['ALTER TABLE "a" DROP COLUMN "b"', true],
    ['ALTER TABLE "a" DROP CONSTRAINT "c"', true],
    ['DROP TYPE "E"', true],
    ['TRUNCATE "a"', true],
    ['ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE INTEGER', true],
    ['CREATE INDEX "a" ON "b"("c")', false],
    ['CREATE TABLE "a" ("id" TEXT NOT NULL)', false],
    ['ALTER TABLE "a" ADD COLUMN "b" TEXT', false],
    ['CREATE EXTENSION IF NOT EXISTS "vector"', false],
    // Lättar en begränsning, tappar ingenting.
    ['ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL', false],
    ['ALTER TABLE "a" ALTER COLUMN "b" DROP DEFAULT', false],
  ])('klassificerar %s → destruktiv=%s', (sql, destruktiv) => {
    expect(parseDriftStatements(`${sql};`)[0]!.destructive).toBe(destruktiv)
  })
})

describe('vakten fäller åt BÅDA hållen', () => {
  const ACK = { sql: 'DROP INDEX "känt_idx"', reason: 'x'.repeat(40) }

  it('KANARIEFÅGEL: okvitterad destruktiv drift FÄLLER', () => {
    const v = evaluateDrift(parseDriftStatements('DROP INDEX "ny_okänd_idx";'), [])
    expect(v.okvitterade.map((s) => s.sql)).toEqual(['DROP INDEX "ny_okänd_idx"'])
    expect(formatVerdict(v).fall).toBe(true)
  })

  it('KANARIEFÅGEL: en STALE kvittering FÄLLER — filen får inte ruttna', () => {
    // Driften är löst men raden står kvar. Utan den här halvan blir
    // kvitteringsfilen en uppräkning som överlever sin egen sanning.
    const v = evaluateDrift(parseDriftStatements('CREATE INDEX "a" ON "b"("c");'), [ACK])
    expect(v.stale.map((a) => a.sql)).toEqual(['DROP INDEX "känt_idx"'])
    expect(formatVerdict(v).fall).toBe(true)
  })

  it('kvitterad destruktiv drift fäller INTE', () => {
    const v = evaluateDrift(parseDriftStatements('DROP INDEX "känt_idx";'), [ACK])
    expect(v.okvitterade).toEqual([])
    expect(v.stale).toEqual([])
    expect(v.kvitterad.map((s) => s.sql)).toEqual(['DROP INDEX "känt_idx"'])
    expect(formatVerdict(v).fall).toBe(false)
  })

  it('icke-destruktiv drift loggas men fäller INTE', () => {
    const v = evaluateDrift(parseDriftStatements('CREATE INDEX "a" ON "b"("c");'), [])
    expect(v.ickeDestruktiv).toHaveLength(1)
    expect(formatVerdict(v).fall).toBe(false)
  })

  it('en kvittering som bytt FORM räknas som stale, inte som täckt', () => {
    // Samma index men annan formulering är en NY sats. Den ska läsas och
    // kvitteras på nytt, inte glida igenom på en gammal motivering.
    const v = evaluateDrift(parseDriftStatements('DROP INDEX IF EXISTS "känt_idx";'), [ACK])
    expect(v.okvitterade).toHaveLength(1)
    expect(v.stale).toHaveLength(1)
    expect(formatVerdict(v).fall).toBe(true)
  })

  it('ingen drift alls + inga kvitteringar = grönt', () => {
    expect(formatVerdict(evaluateDrift([], [])).fall).toBe(false)
  })
})

describe('kvitteringsfilen', () => {
  it('går att läsa och har en motivering per rad', () => {
    const acks = loadAcknowledgements(ACK_PATH)
    expect(acks.length).toBeGreaterThan(0)
    for (const a of acks) {
      expect(a.sql.length).toBeGreaterThan(0)
      // En tom eller innehållslös motivering gör posten till en tystnadsknapp.
      expect(a.reason.trim().length).toBeGreaterThanOrEqual(30)
    }
  })

  it('hnsw-indexet är kvitterat, och skälet nämner varför det inte går att lösa', () => {
    const acks = loadAcknowledgements(ACK_PATH)
    const hnsw = acks.find((a) => a.sql.includes('hnsw'))
    expect(hnsw).toBeDefined()
    expect(hnsw!.reason).toMatch(/Unsupported/)
  })

  it('KANARIEFÅGEL: en kvittering utan motivering avvisas', () => {
    const tmp = join(__dirname, '__ack-sond.json')
    const fs = jest.requireActual('fs') as typeof import('fs')
    fs.writeFileSync(tmp, JSON.stringify([{ sql: 'DROP INDEX "x"', reason: 'kort' }]))
    try {
      expect(() => loadAcknowledgements(tmp)).toThrow(/för kort motivering/)
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})
