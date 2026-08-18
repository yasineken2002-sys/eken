/**
 * VAKT MOT DESTRUKTIV SCHEMADRIFT (#512).
 *
 * ── PROBLEMET ──────────────────────────────────────────────────────────────
 *
 * `prisma migrate diff` mellan migrationshistoriken och `schema.prisma` ger i dag
 * satser som ingen bett om, och EN AV DEM ÄR DESTRUKTIV:
 *
 *   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
 *
 * Indexet läggs som rå SQL i en migration eftersom kolumnen är
 * `Unsupported("vector(1024)")` och Prisma inte kan uttrycka `@@index` på den.
 * Schemat känner därför inte till indexet och drar slutsatsen att det inte ska
 * finnas. Åker satsen med i en genererad migration försvinner indexet vid nästa
 * `migrate deploy`, och den semantiska juridik-retrievalen faller tillbaka på
 * sekventiell skanning — en TYST prestandaregression, inga fel, inga larm.
 *
 * `prisma migrate dev` är dessutom interaktiv och fungerar inte i den här miljön,
 * så `migrate diff` är den naturliga vägen — och den vägen bär driften.
 *
 * ── VARFÖR KVITTERINGSFILEN MÅSTE FÄLLA ÅT BÅDA HÅLL ───────────────────────
 *
 * En lista över kända undantag är en uppräkning, och en uppräkning överlever sin
 * egen sanning: posten står kvar långt efter att driften den beskriver är löst,
 * och ingen märker något eftersom listan bara används för att TYSTA saker.
 *
 * Därför fäller vakten åt båda hållen:
 *
 *   destruktiv sats som INTE är kvitterad   → rött  (nytt problem)
 *   kvittering som INTE motsvarar drift     → rött  (stale post)
 *
 * Den andra halvan är den som gör filen självstädande. Utan den hade den blivit
 * ännu en lista som ser ut att betyda något.
 */

import { readFileSync } from 'fs'

/** En sats ur diffen, normaliserad. */
export interface DriftStatement {
  /** Normaliserad SQL: en rad, kollapsad blankrad, utan avslutande semikolon. */
  sql: string
  destructive: boolean
}

export interface Acknowledgement {
  /** Måste matcha `DriftStatement.sql` exakt (normaliserad form). */
  sql: string
  /** Varför den här driften inte går att lösa. Läses av människor. */
  reason: string
}

/**
 * Satser som kan förstöra data eller tappa en struktur någon byggt med flit.
 *
 * `DROP DEFAULT` och `DROP NOT NULL` står medvetet INTE här — de lättar en
 * begränsning och tappar ingenting.
 */
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bDROP\s+TYPE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bTRUNCATE\b/i,
  // Typbyte kan tappa data (text→int, numeric-precision). Prisma genererar det
  // som `ALTER COLUMN "x" SET DATA TYPE y` eller `ALTER COLUMN "x" TYPE y`.
  /\bALTER\s+COLUMN\b[\s\S]*\b(SET\s+DATA\s+)?TYPE\b/i,
]

/**
 * Delar diffens SQL i normaliserade satser.
 *
 * KOMMENTARER STRIPPAS FÖRST, och det är inte kosmetik: `migrate diff` skriver
 * `-- DropIndex` som rubrik ovanför varje sats. Utan strippningen hade varje
 * diff sett destruktiv ut, vakten alltid varit röd, och därmed värdelös.
 */
export function parseDriftStatements(sql: string): DriftStatement[] {
  const utanKommentarer = sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')

  return utanKommentarer
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .map((s) => ({ sql: s, destructive: DESTRUCTIVE.some((re) => re.test(s)) }))
}

export interface DriftVerdict {
  /** Destruktiva satser utan kvittering. Rött. */
  okvitterade: DriftStatement[]
  /** Kvitteringar som inte längre motsvarar någon drift. Också rött. */
  stale: Acknowledgement[]
  /** Icke-destruktiv drift. Loggas, fäller inte. */
  ickeDestruktiv: DriftStatement[]
  /** Destruktiv drift som är kvitterad. Loggas, fäller inte. */
  kvitterad: DriftStatement[]
}

export function evaluateDrift(
  statements: DriftStatement[],
  acknowledged: readonly Acknowledgement[],
): DriftVerdict {
  const ackSql = new Set(acknowledged.map((a) => a.sql))
  const driftSql = new Set(statements.map((s) => s.sql))

  return {
    okvitterade: statements.filter((s) => s.destructive && !ackSql.has(s.sql)),
    // En kvittering vars sats inte längre finns i diffen är stale. Det gäller
    // ÄVEN om driften bara ändrat form — en omformulerad sats är en ny sats och
    // ska kvitteras på nytt, med ett skäl någon läst igenom.
    stale: acknowledged.filter((a) => !driftSql.has(a.sql)),
    ickeDestruktiv: statements.filter((s) => !s.destructive),
    kvitterad: statements.filter((s) => s.destructive && ackSql.has(s.sql)),
  }
}

export function loadAcknowledgements(path: string): Acknowledgement[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error('Kvitteringsfilen måste vara en JSON-array')
  return raw.map((r, i) => {
    const o = r as Record<string, unknown>
    if (typeof o['sql'] !== 'string' || typeof o['reason'] !== 'string') {
      throw new Error(`Kvittering ${i} saknar sql eller reason`)
    }
    // En tom motivering är samma sak som ingen — då är posten en tystnadsknapp.
    if ((o['reason'] as string).trim().length < 30) {
      throw new Error(`Kvittering ${i} har för kort motivering: "${String(o['reason'])}"`)
    }
    return { sql: o['sql'] as string, reason: o['reason'] as string }
  })
}

/** Människoläsbar rapport. Returnerar true om vakten ska FÄLLA. */
export function formatVerdict(v: DriftVerdict): { rapport: string; fall: boolean } {
  const rader: string[] = []

  if (v.ickeDestruktiv.length > 0) {
    rader.push(`ICKE-DESTRUKTIV DRIFT (${v.ickeDestruktiv.length}) — loggas, fäller inte:`)
    for (const s of v.ickeDestruktiv) rader.push(`  ~ ${s.sql}`)
    rader.push('')
  }
  if (v.kvitterad.length > 0) {
    rader.push(`KVITTERAD DESTRUKTIV DRIFT (${v.kvitterad.length}):`)
    for (const s of v.kvitterad) rader.push(`  ✓ ${s.sql}`)
    rader.push('')
  }
  if (v.okvitterade.length > 0) {
    rader.push(`OKVITTERAD DESTRUKTIV DRIFT (${v.okvitterade.length}) — FÄLLER:`)
    for (const s of v.okvitterade) rader.push(`  ✗ ${s.sql}`)
    rader.push('')
    rader.push('  En genererad migration skulle ta med den här satsen. Antingen är')
    rader.push('  driften ett fel som ska lösas, eller så ska den kvitteras med ett')
    rader.push('  skäl i prisma/schema-drift-acknowledged.json.')
    rader.push('')
  }
  if (v.stale.length > 0) {
    rader.push(`STALE KVITTERINGAR (${v.stale.length}) — FÄLLER:`)
    for (const a of v.stale) rader.push(`  ✗ ${a.sql}`)
    rader.push('')
    rader.push('  Kvitteringen motsvarar ingen faktisk drift längre. Antingen är')
    rader.push('  problemet löst — ta bort raden — eller så har satsen bytt form och')
    rader.push('  ska kvitteras på nytt. En kvittering som står kvar utan drift gör')
    rader.push('  filen till en uppräkning som överlever sin egen sanning.')
    rader.push('')
  }
  if (v.okvitterade.length === 0 && v.stale.length === 0) {
    rader.push('Ingen okvitterad destruktiv drift, inga stale kvitteringar.')
  }

  return { rapport: rader.join('\n'), fall: v.okvitterade.length > 0 || v.stale.length > 0 }
}
