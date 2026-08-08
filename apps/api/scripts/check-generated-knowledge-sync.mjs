#!/usr/bin/env node
/**
 * CI-grind (#382, PR2): är `src/ai/knowledge/generated/` i synk med
 * sanningskällan `.claude/knowledge/lagar/*.md`?
 *
 * VARFÖR: `knowledge:generate` körs FÖR HAND. Inget fångade att den glömts.
 * Konsekvensen är tyst och allvarlig: `.claude/` följer inte med i prod-imagen,
 * så det är `generated/` som faktiskt körs i drift. Glöms generatorn kör
 * produktionen en ÄLDRE lydelse än den lagtext en människa verifierade och
 * committade — och citat-integriteten stämplar den gamla texten med den nya
 * filens `verifieradPer`. Samma felklass som #382, med omvänt tecken: där
 * citerades en upphävd lag som gällande, här skulle en gällande ändring inte
 * nå fram.
 *
 * HUR: läs av generated/, kör den RIKTIGA generatorn, jämför, återställ. Grinden
 * reimplementerar ingenting — generatorn förblir enda sanningen om hur en modul
 * ska se ut. Jämförelsen går på filinnehåll, inte på `git status`: en grind som
 * kräver rent arbetsträd hade fällt med fel besked ("committa först") i just det
 * läge den finns för — en människa som redigerat en lagtext och inte hunnit köra
 * generatorn. Den ska då få veta att generatorn ska köras.
 *
 * ICKE-MUTERANDE: originalinnehållet skrivs tillbaka, så grinden kan köras när
 * som helst utan att röra arbetsträdet.
 *
 * ANVÄNDNING:
 *   node apps/api/scripts/check-generated-knowledge-sync.mjs
 *   node apps/api/scripts/check-generated-knowledge-sync.mjs --self-test
 *
 * Självtestet bevisar att grinden har tänder: det stör en lagtextfil UTAN att
 * köra generatorn och kräver att grinden fäller med exit 1. En grind som aldrig
 * setts falla är ingen grind.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = join(dirname(SELF), '..', '..', '..')
const GEN_DIR = join(REPO, 'apps/api/src/ai/knowledge/generated')
const PROBE_FILE = join(REPO, '.claude/knowledge/lagar/ranteslagen.md')
const PROBE_MARKER = '\n## 9999 §\n\nTillfällig paragraf — självtest av synk-grinden.\n'

/** filnamn → innehåll för allt generatorn äger. */
function snapshot() {
  const out = new Map()
  for (const f of readdirSync(GEN_DIR).filter((f) => f.endsWith('.ts'))) {
    out.set(f, readFileSync(join(GEN_DIR, f), 'utf8'))
  }
  return out
}

function restore(snap) {
  for (const f of readdirSync(GEN_DIR).filter((f) => f.endsWith('.ts'))) {
    if (!snap.has(f)) unlinkSync(join(GEN_DIR, f))
  }
  for (const [f, content] of snap) {
    const p = join(GEN_DIR, f)
    if (!existsSync(p) || readFileSync(p, 'utf8') !== content) writeFileSync(p, content)
  }
}

function runGenerator() {
  execFileSync('pnpm', ['--filter', '@eken/api', 'knowledge:generate'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function check() {
  const before = snapshot()
  runGenerator()
  const after = snapshot()

  const diffs = []
  for (const [f, content] of after) {
    if (!before.has(f)) diffs.push(`  SAKNAS i repot (generatorn skapar den):   ${f}`)
    else if (before.get(f) !== content) diffs.push(`  INNEHÅLLET skiljer sig:                  ${f}`)
  }
  for (const f of before.keys()) {
    if (!after.has(f)) diffs.push(`  FÖRÄLDRALÖS (ingen källfil finns):        ${f}`)
  }

  restore(before)

  if (diffs.length > 0) {
    console.error(
      'GENERERAD LAGTEXT ÄR UR SYNK MED KÄLLAN.\n\n' +
        'Att köra `knowledge:generate` gav ett annat resultat än det som ligger i repot,\n' +
        'alltså speglar generated/ inte .claude/knowledge/lagar/. Eftersom .claude/ inte\n' +
        'följer med i prod-imagen är det generated/ som körs i drift — produktionen\n' +
        'skulle köra en annan lydelse än den som verifierades och committades.\n\n' +
        diffs.join('\n') +
        '\n\nÅTGÄRD: kör `pnpm --filter @eken/api knowledge:generate` och committa resultatet.\n' +
        'Redigera ALDRIG generated/*.ts för hand — de är derivat.',
    )
    process.exit(1)
  }

  console.warn('[knowledge-sync] generated/ är i synk med .claude/knowledge/lagar/ ✓')
}

/**
 * Bevisar att grinden fäller verklig drift. check() avslutar processen, så den
 * körs i en underprocess vars exitkod går att observera.
 */
function selfTest() {
  const genBefore = snapshot()
  const original = readFileSync(PROBE_FILE, 'utf8')
  let exitCode = null
  try {
    // Ändra källan UTAN att köra generatorn — exakt det en människa gör när hon
    // uppdaterar en lagtext och glömmer generatorsteget.
    writeFileSync(PROBE_FILE, original + PROBE_MARKER)
    try {
      execFileSync('node', [SELF], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
      exitCode = 0
    } catch (err) {
      exitCode = err.status ?? -1
    }
  } finally {
    writeFileSync(PROBE_FILE, original)
    restore(genBefore)
  }

  if (exitCode !== 1) {
    console.error(
      `SJÄLVTESTET MISSLYCKADES: en ändrad lagtextfil utan omkörd generator gav exit ${exitCode},\n` +
        'förväntade 1. Grinden har inga tänder — den skulle släppa igenom verklig drift.',
    )
    process.exit(1)
  }

  // Grinden lovar att vara icke-muterande. Bevisa det.
  const genAfter = snapshot()
  const changed = [...genAfter].filter(([f, c]) => genBefore.get(f) !== c).map(([f]) => f)
  const vanished = [...genBefore.keys()].filter((f) => !genAfter.has(f))
  if (changed.length > 0 || vanished.length > 0) {
    console.error(
      'SJÄLVTESTET LÄMNADE SPÅR i generated/:\n' +
        [...changed, ...vanished].map((f) => `  ${f}`).join('\n'),
    )
    process.exit(1)
  }
  if (readFileSync(PROBE_FILE, 'utf8') !== original) {
    console.error(`SJÄLVTESTET ÅTERSTÄLLDE INTE källfilen: ${PROBE_FILE}`)
    process.exit(1)
  }

  console.warn('[knowledge-sync] självtest ✓ — grinden fäller en källändring utan omkörd generator')
}

if (process.argv.includes('--self-test')) selfTest()
else check()
