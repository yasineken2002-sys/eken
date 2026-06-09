/**
 * Generator: kompilerar de människoverifierade lagtext-`.md`-filerna i
 * `.claude/knowledge/lagar/` till TypeScript-strängmoduler under
 * `apps/api/src/ai/knowledge/generated/`.
 *
 * VARFÖR: `.claude/` följer inte med i prod-imagen (Dockerfilens runtime-steg
 * kopierar bara `dist`, `node_modules`, `packages`, `prisma`, `scripts`), och
 * TS-bygget kopierar inte `.md` till `dist`. Genom att bädda in lagtexten som
 * `.ts` rider den med in i `dist`-bundlen automatiskt och överlever Docker utan
 * specialhantering. De genererade filerna committas som artefakter.
 *
 * SANNINGSKÄLLA: `.md`-filerna (redigerbara, lästa av .claude-agenterna).
 * DERIVAT: `generated/*.ts` (rör aldrig för hand — kör om generatorn istället).
 *
 * Kör: `pnpm --filter @eken/api knowledge:generate`
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'

const SRC_DIR = join(__dirname, '../../../.claude/knowledge/lagar')
const OUT_DIR = join(__dirname, '../src/ai/knowledge/generated')

interface ParsedDoc {
  id: string
  titel: string
  sfs: string
  verifieradPer: string
  kalla: string
  innehall: string
  /** Källfilens namn, t.ex. "hyreslagen.md" — för spårbarhets-headern. */
  srcFile: string
}

const REQUIRED_KEYS = ['id', 'titel', 'sfs', 'verifierad_per', 'kalla'] as const

function parseFrontmatter(srcFile: string, raw: string): ParsedDoc {
  const file = srcFile
  if (!raw.startsWith('---\n')) {
    throw new Error(`[${file}] saknar frontmatter (måste börja med "---")`)
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) throw new Error(`[${file}] frontmatter avslutas aldrig med "---"`)

  const fm: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    if (!line.trim()) continue
    const sep = line.indexOf(':')
    if (sep === -1) throw new Error(`[${file}] ogiltig frontmatter-rad: "${line}"`)
    const key = line.slice(0, sep).trim()
    // Strippa omslutande citattecken, både " och ' (prettier normaliserar
    // frontmatter-värden till enkla citattecken vid commit).
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
    fm[key] = value
  }
  for (const k of REQUIRED_KEYS) {
    if (!fm[k]) throw new Error(`[${file}] saknar obligatoriskt frontmatter-fält "${k}"`)
  }
  // Lagtexten = allt efter frontmattern, med inledande blankrader trimmade så
  // body börjar på H1 (= exakt originalfilens innehåll, byte-för-byte).
  const innehall = raw.slice(end + 5).replace(/^\n+/, '')

  return {
    id: fm['id']!,
    titel: fm['titel']!,
    sfs: fm['sfs']!,
    verifieradPer: fm['verifierad_per']!,
    kalla: fm['kalla']!,
    innehall,
    srcFile,
  }
}

const HEADER = (src: string) =>
  `// AUTO-GENERERAD — REDIGERA INTE FÖR HAND.\n` +
  `// Källa: .claude/knowledge/lagar/${src}\n` +
  `// Kör om: pnpm --filter @eken/api knowledge:generate\n`

function moduleSource(doc: ParsedDoc): string {
  return (
    HEADER(doc.srcFile) +
    `import type { LegalKnowledgeDocument } from '../legal-knowledge.types'\n\n` +
    `export const ${doc.id}: LegalKnowledgeDocument = {\n` +
    `  id: ${JSON.stringify(doc.id)},\n` +
    `  titel: ${JSON.stringify(doc.titel)},\n` +
    `  sfs: ${JSON.stringify(doc.sfs)},\n` +
    `  verifieradPer: ${JSON.stringify(doc.verifieradPer)},\n` +
    `  kalla: ${JSON.stringify(doc.kalla)},\n` +
    `  innehall: ${JSON.stringify(doc.innehall)},\n` +
    `}\n`
  )
}

function indexSource(docs: ParsedDoc[]): string {
  const imports = docs.map((d) => `import { ${d.id} } from './${d.id}.generated'`).join('\n')
  const list = docs.map((d) => `  ${d.id},`).join('\n')
  return (
    `// AUTO-GENERERAD — REDIGERA INTE FÖR HAND.\n` +
    `// Aggregat av alla genererade lagtext-moduler.\n` +
    `// Kör om: pnpm --filter @eken/api knowledge:generate\n` +
    `import type { LegalKnowledgeDocument } from '../legal-knowledge.types'\n` +
    `${imports}\n\n` +
    `export const GENERATED_LEGAL_DOCUMENTS: LegalKnowledgeDocument[] = [\n${list}\n]\n`
  )
}

function main(): void {
  const files = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()

  const docs: ParsedDoc[] = []
  for (const file of files) {
    const raw = readFileSync(join(SRC_DIR, file), 'utf8')
    docs.push(parseFrontmatter(file, raw))
  }
  docs.sort((a, b) => a.id.localeCompare(b.id))

  mkdirSync(OUT_DIR, { recursive: true })
  for (const doc of docs) {
    writeFileSync(join(OUT_DIR, `${doc.id}.generated.ts`), moduleSource(doc))
  }
  writeFileSync(join(OUT_DIR, 'index.generated.ts'), indexSource(docs))

  console.warn(
    `[knowledge] genererade ${docs.length} lagtext-moduler → ${OUT_DIR}\n` +
      docs.map((d) => `  • ${d.id} (${d.sfs}, verifierad ${d.verifieradPer})`).join('\n'),
  )
}

main()
