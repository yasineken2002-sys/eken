#!/usr/bin/env node
/**
 * SPRIDD WHERE-SATS SOM TAPPAR SIN ORGANISATION — mönstret bakom #703.
 *
 * ── VARFÖR DEN HÄR VAKTEN FINNS ─────────────────────────────────────────────
 *
 * En where-sats byggd som `{ ...X, ... }` ser identisk ut oavsett vad `X` är.
 * Blir `X` undefined i runtime är `{ ...undefined }` laglig JS och ger `{}` —
 * uppslaget tappar då sin `organizationId` och returnerar första raden med rätt
 * övriga villkor i HELA tabellen, tvärs över organisationsgränsen. Anroparen
 * ser det som ett lyckat svar.
 *
 * TYPSYSTEMET FÅNGAR INTE DET. I #703 var `idempotencyWhere` REDAN obligatorisk
 * i typen; hålet uppstod på vägar som går förbi typen (`as any`, ett
 * params-objekt byggt med spridning, `JSON.parse`). Mätt: `kanVaraUndefined`
 * var `false` för det ställe som bar felet. En vakt är därför det enda
 * instrument som kan se den här klassen.
 *
 * ── VAD DEN MÄTER ───────────────────────────────────────────────────────────
 *
 * Varje `where:` i apps/api/src som är ett objektlitteral med TOPPNIVÅ-spridning,
 * eller ett bart uttryck (`where: X`). Ett sådant ställe fälls om INGET av tre
 * säkerhetsvillkor gäller:
 *
 *   S1  `organizationId` står EXPLICIT som toppnivåfält i samma where.
 *       Förkortad form räknas: kodbasen skriver `{ organizationId, ...X }`.
 *   S2  DEKLARATIONEN av X bär `organizationId: string` — antingen direkt i
 *       annoteringen, eller via ett typalias i samma fil vars kropp gör det.
 *   S3  En THROW-spärr står före stället och kastar om X eller X.organizationId
 *       är null. (Det är formen #703 fick.)
 *
 * Uteslutet, med skäl:
 *
 *   • modeller UTAN organizationId i schemat — ingen tenant-gräns att tappa
 *   • INLINE-byggda uttryck: `(c ? {a} : {})`, `(c && {a})`, objektlitteral.
 *     De byggs på plats och kan inte bli undefined via en anropare.
 *   • X vars deklaration är en FUNKTION — `where: byOrg` i ett konfigobjekt är
 *     en callback som anropas senare, inte en fråga.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * • Bara THROW-spärrar. En tidig `return` skyddar lika bra men känns inte igen;
 *   de fem ställena i `history/gaps.service.ts` skyddas av `if (!villkor)
 *   return` och passerar här på S2, inte på S3.
 * • Bara att ORGANISATIONEN kan falla bort — inte om nyckeln är TILLRÄCKLIGT
 *   unik. En `where` som bär `organizationId` men fel `sourceId` är org-scopad
 *   och ändå fel; det ägs av det unika DB-indexet och av anroparens spec.
 * • Inte vägarna IN i ett typat objekt: `as any`, `JSON.parse`, ett
 *   params-objekt byggt med spridning. Vakten ser deklarationen, inte vad en
 *   anropare faktiskt levererar. Det ägs av runtime-spärren (#703, C0).
 * • Den läser källtext. En runtime-no-op som tömmer villkoret efter
 *   konstruktionen är osynlig här.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'

const HÄR = dirname(fileURLToPath(import.meta.url))
const SRC = join(HÄR, '..', 'src')
const SCHEMA = join(HÄR, '..', 'prisma', 'schema.prisma')

/** Modeller med organizationId — härledda ur schemat, aldrig listade. */
function modellerMedOrg(schemaText) {
  const ut = new Map()
  for (const m of schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm))
    ut.set(m[1][0].toLowerCase() + m[1].slice(1), /^\s*organizationId\s+String/m.test(m[2]))
  return ut
}

function filer(dir, ut = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) filer(p, ut)
    // FORM, inte ordet 'spec': katalogen `inspections/` bär delsträngen.
    else if (/\.ts$/.test(p) && !/\.spec\.ts$/.test(p)) ut.push(p)
  }
  return ut
}

function spann(k, från, ö = '{', s2 = '}') {
  let d = 0
  let j = k.indexOf(ö, från)
  if (j === -1) return null
  const s = j
  for (; j < k.length; j++) {
    if (k[j] === ö) d++
    else if (k[j] === s2) {
      d--
      if (d === 0) return [s, j + 1]
    }
  }
  return null
}

/** Toppnivåfält och spridningar. Förkortad egenskap räknas som fält. */
function toppniva(kropp) {
  const falt = []
  const spridningar = []
  let d = 0
  for (let k = 0; k < kropp.length; k++) {
    const c = kropp[k]
    if (c === '{' || c === '[' || c === '(') {
      d++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      d--
      continue
    }
    if (d !== 1) continue
    if (kropp.startsWith('...', k)) {
      let j = k + 3
      let dd = 0
      while (j < kropp.length) {
        const ch = kropp[j]
        if (ch === '(' || ch === '[' || ch === '{') dd++
        else if (ch === ')' || ch === ']' || ch === '}') {
          if (dd === 0) break
          dd--
        } else if (ch === ',' && dd === 0) break
        j++
      }
      spridningar.push(kropp.slice(k + 3, j).trim())
      k = j - 1
      continue
    }
    const m = /^([A-Za-z_$][\w$]*)\s*([:,}])/.exec(kropp.slice(k))
    if (m && !/[\w$]/.test(kropp[k - 1] ?? '')) {
      falt.push(m[1])
      k += m[1].length
    }
  }
  return { falt, spridningar }
}

const INLINE = (u) => /^[([]/.test(u) || /^\{/.test(u) || /\?|&&|\|\|/.test(u)

/**
 * Står `where:` i ett OBJEKTLITTERAL eller i en PARAMETERLISTA?
 *
 * `\bwhere\s*:` matchar också en annotering — `(where: Prisma.XWhereInput) =>`
 * och `where: string,` i en signatur är inga frågor. Närmaste OSTÄNGDA
 * klammer/parentes bakåt avgör: `{` är ett objekt, `(` är en parameterlista.
 */
function iObjektlitteral(kod, idx) {
  let d = 0
  for (let i = idx - 1; i >= 0; i--) {
    const c = kod[i]
    if (c === ')' || c === '}' || c === ']') d++
    else if (c === '(' || c === '{' || c === '[') {
      if (d === 0) return c === '{'
      d--
    }
  }
  return false
}

/** Modellen frågan går mot: närmaste `.<accessor>.<metod>(` bakåt. */
function modellFor(kod, idx) {
  let bäst = null
  for (const m of kod
    .slice(Math.max(0, idx - 400), idx)
    .matchAll(
      /\.(\w+)\s*\.\s*(?:findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|findMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g,
    ))
    bäst = m[1]
  return bäst
}

/**
 * S2 — bär DEKLARATIONEN av X en obligatorisk organizationId?
 * Löses i samma fil: annoteringen direkt, eller ett typalias vars kropp gör det.
 */
function deklarationBärOrg(kod, uttryck) {
  const rot = uttryck
    .replace(/^this\./, '')
    .replace(/\(.*$/s, '')
    .split('.')[0]
  if (!rot) return { bärOrg: false, ärFunktion: false }
  const esc = rot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alias = new Map()
  for (const m of kod.matchAll(
    /\btype\s+([A-Za-z_$][\w$]*)\s*=([^\n]*(?:\n(?!\s*(?:type|const|let|export|\/\/))[^\n]*)*)/g,
  ))
    alias.set(m[1], m[2])
  const bärOrgText = (t) => {
    if (/organizationId\s*:\s*string/.test(t)) return true
    for (const [namn, kropp] of alias)
      if (
        new RegExp(`(?<![\\p{L}\\p{N}_$])${namn}(?![\\p{L}\\p{N}_$])`, 'u').test(t) &&
        /organizationId\s*:\s*string/.test(kropp)
      )
        return true
    return false
  }
  // metod: `private namn(...): ReturnTyp {`   ·   variabel: `const namn: Typ =`
  const metod = new RegExp(`\\b${esc}\\s*\\([^)]*\\)\\s*:\\s*([^{]+)\\{`, 's').exec(kod)
  if (metod) return { bärOrg: bärOrgText(metod[1]), ärFunktion: false }
  const variabel = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*:\\s*([^=]+)=`, 's').exec(kod)
  if (variabel) return { bärOrg: bärOrgText(variabel[1]), ärFunktion: false }
  // `const villkor = this.inspektionsVillkor(...)` — ingen annotering. Följ
  // anropet till metodens DEKLARERADE returtyp; annars ser en hjälpare som
  // bevisligen bär org ut som ett oskyddat värde.
  const viaAnrop = new RegExp(
    `\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:await\\s+)?(?:this\\.)?([A-Za-z_$][\\w$]*)\\s*\\(`,
    's',
  ).exec(kod)
  if (viaAnrop) {
    const m2 = new RegExp(`\\b${viaAnrop[1]}\\s*\\([^)]*\\)\\s*:\\s*([^{]+)\\{`, 's').exec(kod)
    if (m2) return { bärOrg: bärOrgText(m2[1]), ärFunktion: false }
  }
  const arrow = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?[(<]`, 's').test(
    kod,
  )
  return { bärOrg: false, ärFunktion: arrow }
}

/** S3 — throw-spärr på X och X.organizationId före stället. */
function throwSpärrad(kod, uttryck, idx) {
  const esc = uttryck.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const före = kod.slice(Math.max(0, idx - 8000), idx)
  const p = (suffix) =>
    new RegExp(
      `if\\s*\\(\\s*(?:!\\s*)?${esc}${suffix}\\s*(?:[=!]==?\\s*(?:null|undefined))?\\s*\\)[^]{0,400}?throw`,
      'm',
    ).test(före)
  return p('') && p('\\.organizationId')
}

/** Kärnan. Returnerar de ställen som FÄLLS. */
export function granska(rå, filnamn, medOrg) {
  const kod = codeMask(rå)
  const fällda = []
  for (const m of kod.matchAll(/\bwhere\s*:/g)) {
    let j = m.index + m[0].length
    while (j < kod.length && /\s/.test(kod[j])) j++
    if (!iObjektlitteral(kod, m.index)) continue
    const rad = rå.slice(0, m.index).split('\n').length
    const accessor = modellFor(kod, m.index)
    // ingen tenant-gräns att tappa
    if (accessor && medOrg.has(accessor) && medOrg.get(accessor) === false) continue

    let uttryck = null
    let orgExplicit = false
    if (kod[j] === '{') {
      const sp = spann(kod, j)
      if (!sp) continue
      const { falt, spridningar } = toppniva(kod.slice(sp[0], sp[1]))
      if (spridningar.length === 0) continue
      orgExplicit = falt.includes('organizationId')
      for (const u of spridningar) {
        if (orgExplicit) continue // S1
        if (INLINE(u)) continue
        const d = deklarationBärOrg(kod, u)
        if (d.ärFunktion || d.bärOrg) continue // S2
        if (throwSpärrad(kod, u, m.index)) continue // S3
        fällda.push({
          fil: filnamn,
          rad,
          form: 'spridning',
          uttryck: u.replace(/\s+/g, ' ').slice(0, 70),
          modell: accessor,
        })
      }
      continue
    }
    const m2 = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,}\)]/.exec(kod.slice(j))
    if (!m2) continue
    uttryck = m2[1]
    const d = deklarationBärOrg(kod, uttryck)
    if (d.ärFunktion || d.bärOrg) continue
    if (throwSpärrad(kod, uttryck, m.index)) continue
    fällda.push({ fil: filnamn, rad, form: 'bar', uttryck, modell: accessor })
  }
  return fällda
}

// ═══════════════════════════════════════════════════════════════════════════
function selfTest() {
  let ok = true
  const kräv = (namn, villkor, detalj) => {
    console.error(`${villkor ? '✅' : '❌'} ${namn}${detalj && !villkor ? ` — ${detalj}` : ''}`)
    if (!villkor) ok = false
  }

  // Den delade skannerns EGNA kanariefåglar. Hela vakten läser via codeMask;
  // går masken sönder mäter vakten sin egen tolkning och inte källan.
  const fallna = kanariefåglar()
  kräv(
    `delade skannerns kanariefåglar (${KANARIEFÅGEL_LÄGEN.length} lägen + 3 incidenter)`,
    fallna.length === 0,
    fallna.join(' | '),
  )

  const medOrg = new Map([
    ['journalEntry', true],
    ['property', true],
    ['refreshToken', false],
  ])
  const kör = (kod) => granska(kod, '<fixtur>', medOrg)

  // 1. #703 FÖRE fixen — spridning av ett params-fält, ingen explicit org,
  //    ingen spärr. MÅSTE fällas.
  const före = `
    async function f(params: { idempotencyWhere: Prisma.JournalEntryWhereInput; source: string }) {
      const existing = await tx.journalEntry.findFirst({
        where: { ...params.idempotencyWhere, source: params.source },
      })
    }`
  kräv('#703 FÖRE fixen fälls', kör(före).length === 1, `fick ${kör(före).length}`)

  // 2. #703 EFTER fixen — samma rad, men med C0-spärren före. MÅSTE passera.
  const efter = `
    async function f(params: { idempotencyWhere: Prisma.JournalEntryWhereInput; source: string }) {
      if (params.idempotencyWhere == null) {
        throw new InternalServerErrorException('utan idempotencyWhere')
      }
      if (params.idempotencyWhere.organizationId == null) {
        throw new InternalServerErrorException('saknar organizationId')
      }
      const existing = await tx.journalEntry.findFirst({
        where: { ...params.idempotencyWhere, source: params.source },
      })
    }`
  kräv('#703 EFTER fixen passerar', kör(efter).length === 0, JSON.stringify(kör(efter)))

  // 3. Förkortad egenskap `{ organizationId, ...X }` — S1. MÅSTE passera.
  //    Skrivs regeln som `organizationId:` med kolon missas varenda en.
  const förkortat = `
    async function f(organizationId: string, extra: unknown) {
      await prisma.property.findMany({ where: { organizationId, ...extra } })
    }`
  kräv(
    'förkortad { organizationId, ...X } passerar',
    kör(förkortat).length === 0,
    JSON.stringify(kör(förkortat)),
  )

  // 4. Inline-byggd ternär — kan aldrig bli undefined via en anropare.
  const inline = `
    async function f(status?: string) {
      await prisma.property.findMany({ where: { ...(status ? { status } : {}) } })
    }`
  kräv('inline (c ? {a} : {}) passerar', kör(inline).length === 0, JSON.stringify(kör(inline)))

  // 5. KANARIEFÅGEL MOT ATT VAKTEN GÅTT BLIND: en kommentar som NÄMNER
  //    organizationId får inte räknas som att fältet finns.
  const iKommentar = `
    async function f(extra: unknown) {
      await prisma.property.findMany({
        // organizationId sätts någon annanstans
        where: { ...extra },
      })
    }`
  kräv(
    'organizationId i en KOMMENTAR räcker inte',
    kör(iKommentar).length === 1,
    `fick ${kör(iKommentar).length}`,
  )

  // 6. Deklarerad typ som bär org — S2. MÅSTE passera.
  const typad = `
    type OrgScopadWhere = { organizationId: string } & Record<string, unknown>
    class C {
      private villkor(organizationId: string): OrgScopadWhere {
        return { organizationId }
      }
      async f() {
        await prisma.property.findMany({ where: { ...this.villkor('o') } })
      }
    }`
  kräv('deklarerad typ som bär org passerar', kör(typad).length === 0, JSON.stringify(kör(typad)))

  // 7. `where:` i en PARAMETERLISTA är en annotering, inte en fråga.
  const parameter = `
    const balancesFor = async (where: Prisma.JournalEntryLineWhereInput) => {
      return prisma.journalEntryLine.groupBy({ by: ['accountId'], where })
    }`
  kräv(
    'where: i en parameterlista ignoreras',
    kör(parameter).length === 0,
    JSON.stringify(kör(parameter)),
  )

  // 8. S2 via ANROP: `const v = this.helper()` utan annotering ska följa
  //    helperns returtyp. Utan det fälls fyra äkta säkra ställen.
  const viaAnrop = `
    type OrgScopadWhere = { organizationId: string } & Record<string, unknown>
    class C {
      private helper(organizationId: string): OrgScopadWhere { return { organizationId } }
      async f() {
        const villkor = this.helper('o')
        await prisma.property.count({ where: villkor })
      }
    }`
  kräv(
    'const v = this.helper() följer returtypen',
    kör(viaAnrop).length === 0,
    JSON.stringify(kör(viaAnrop)),
  )

  // 9. …men en helper UTAN org i returtypen ska fortfarande fällas — annars är
  //    regel 8 bara ett sätt att tysta vakten.
  const viaAnropUtanOrg = `
    class C {
      private helper(): Record<string, unknown> { return {} }
      async f() {
        const villkor = this.helper()
        await prisma.property.count({ where: villkor })
      }
    }`
  kräv(
    'helper UTAN org i returtypen fälls ändå',
    kör(viaAnropUtanOrg).length === 1,
    `fick ${kör(viaAnropUtanOrg).length}`,
  )

  return ok
}

if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1)

const medOrg = modellerMedOrg(readFileSync(SCHEMA, 'utf8'))
const F = filer(SRC)
const fällda = []
for (const f of F) fällda.push(...granska(readFileSync(f, 'utf8'), f.slice(SRC.length + 1), medOrg))

console.warn(
  `skannade ${F.length} filer · ${medOrg.size} modeller, ${[...medOrg.values()].filter(Boolean).length} med organizationId`,
)
if (fällda.length === 0) {
  console.warn('✅ inga where-satser där organizationId kan falla bort tyst')
  process.exit(0)
}
console.error(`\n❌ ${fällda.length} where-sats(er) där organizationId kan falla bort tyst:\n`)
for (const t of fällda)
  console.error(
    `   ${t.fil}:${t.rad}  ${t.form}  X = ${t.uttryck}${t.modell ? `  → ${t.modell}` : ''}`,
  )
console.error(`
Gör ETT av tre:
  S1  skriv organizationId explicit i samma where
  S2  ge X:s deklaration en typ som KRÄVER organizationId
      (t.ex. \`{ organizationId: string } & Record<string, unknown>\`)
  S3  kasta före stället om X eller X.organizationId är null

Bakgrund: #703 — { ...undefined } ger {}, och uppslaget korsar då org-gränsen.`)
process.exit(1)
