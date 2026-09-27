/**
 * Fortnox skiva 01 — A01: skivan är OANSLUTEN.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 *   1. Ingen fil i `apps/api/src` utanför `fortnox/` importerar något ur
 *      `fortnox/` (statisk import, export-from, `require`, dynamisk `import()`).
 *      Därmed inte AppModule heller.
 *   2. Ingen fil utanför `fortnox/` refererar identifieraren `FortnoxModule`.
 *   3. Produktkoden i `fortnox/` har ingen transport eller körtidsyta: inget
 *      `fetch`, ingen http-/axios-/undici-import, ingen controller/cron/kö, inget
 *      `process.env`, ingen import av bokföringen.
 *
 * Frågan ställs mot KOD, inte text: källan tolkas med TypeScripts parser, så en
 * kommentar eller en sträng som nämner Fortnox räknas inte. Kanariefåglarna
 * nedan kräver att samma analys ger OLIKA svar för kod och prosa.
 *
 * ── VAD DET INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Runtime. En framtida inkoppling via DI-token utan import, eller via en
 * sträng till `require`, syns inte här. Det ägs av den inkopplingens granskning.
 * Provet kan heller inte se att befintlig bokföring BETER SIG oförändrat — det
 * bärs av att diffen inte rör några befintliga filer utom schemat, och av den
 * befintliga sviten i CI.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'

const SRC = resolve(__dirname, '..')
const FORTNOX = resolve(__dirname)

function tsFiler(dir: string): string[] {
  const ut: string[] = []
  for (const namn of readdirSync(dir)) {
    const p = join(dir, namn)
    if (statSync(p).isDirectory()) {
      if (namn === 'node_modules') continue
      ut.push(...tsFiler(p))
    } else if (/\.tsx?$/.test(namn) && !namn.endsWith('.d.ts')) {
      ut.push(p)
    }
  }
  return ut
}

/** Alla modulspecifikationer en källfil faktiskt laddar — ur syntaxträdet. */
export function specifikationer(källa: string, filnamn = 'x.ts'): string[] {
  const sf = ts.createSourceFile(filnamn, källa, ts.ScriptTarget.ES2022, true)
  const ut: string[] = []
  const besök = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      if (ts.isStringLiteral(n.moduleSpecifier)) ut.push(n.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression
      if (ts.isStringLiteral(e)) ut.push(e.text)
    } else if (ts.isCallExpression(n)) {
      const arg = n.arguments[0]
      const ärRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require'
      const ärImport = n.expression.kind === ts.SyntaxKind.ImportKeyword
      if ((ärRequire || ärImport) && arg && ts.isStringLiteralLike(arg)) ut.push(arg.text)
    }
    ts.forEachChild(n, besök)
  }
  besök(sf)
  return ut
}

/** Identifierare som förekommer som KOD (inte i kommentar eller sträng). */
export function identifierare(källa: string): Set<string> {
  const sf = ts.createSourceFile('x.ts', källa, ts.ScriptTarget.ES2022, true)
  const ut = new Set<string>()
  const besök = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) ut.add(n.text)
    ts.forEachChild(n, besök)
  }
  besök(sf)
  return ut
}

/** Anrop och egenskapsåtkomster som betyder transport eller körtidsyta. */
export function körtidsyta(källa: string): string[] {
  const sf = ts.createSourceFile('x.ts', källa, ts.ScriptTarget.ES2022, true)
  const ut: string[] = []
  const besök = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch')
      ut.push('fetch()')
    if (ts.isDecorator(n)) {
      const e = ts.isCallExpression(n.expression) ? n.expression.expression : n.expression
      if (
        ts.isIdentifier(e) &&
        ['Controller', 'Cron', 'Interval', 'Timeout', 'Processor', 'Process'].includes(e.text)
      ) {
        ut.push(`@${e.text}`)
      }
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'process' &&
      n.name.text === 'env'
    ) {
      ut.push('process.env')
    }
    ts.forEachChild(n, besök)
  }
  besök(sf)
  return ut
}

const FÖRBJUDNA_MODULER = [
  /^(node:)?https?$/,
  /^axios$/,
  /^undici$/,
  /^@nestjs\/(bull|schedule|axios)$/,
  /^bull$/,
  /(^|\/)accounting(\/|$)/,
  /accounting\.(service|module)$/,
]

function pekarInIFortnox(fil: string, spec: string): boolean {
  if (!spec.startsWith('.')) return false
  const mål = resolve(dirname(fil), spec)
  return mål === FORTNOX || mål.startsWith(FORTNOX + sep)
}

describe('A01 · kanariefåglar — analysen skiljer kod från prosa', () => {
  const FIL = join(SRC, 'app.module.ts')

  it('en riktig import in i fortnox/ hittas; samma rad i en kommentar gör det inte', () => {
    const kod = `import { FortnoxModule } from './fortnox/fortnox.module'\n`
    const prosa = `// import { FortnoxModule } from './fortnox/fortnox.module'\nconst s = "./fortnox/fortnox.module"\n`
    expect(specifikationer(kod).some((s) => pekarInIFortnox(FIL, s))).toBe(true)
    expect(specifikationer(prosa).some((s) => pekarInIFortnox(FIL, s))).toBe(false)
  })

  it('require, dynamisk import och export-from hittas', () => {
    for (const kod of [
      `const m = require('./fortnox/fortnox.module')`,
      `async function f() { await import('./fortnox/fortnox.module') }`,
      `export { FortnoxModule } from './fortnox/fortnox.module'`,
    ]) {
      expect(specifikationer(kod).some((s) => pekarInIFortnox(FIL, s))).toBe(true)
    }
  })

  it('en syskonkatalog med liknande namn räknas inte som fortnox/', () => {
    expect(pekarInIFortnox(FIL, './fortnox-legacy/x')).toBe(false)
  })

  it('identifierare i kod hittas, i kommentar/sträng inte', () => {
    expect(identifierare('imports: [FortnoxModule]').has('FortnoxModule')).toBe(true)
    expect(identifierare('// FortnoxModule\nconst a = "FortnoxModule"').has('FortnoxModule')).toBe(
      false,
    )
  })

  it('fetch/dekoratorer/process.env hittas i kod, inte i prosa', () => {
    expect(körtidsyta(`fetch('https://x')`)).toEqual(['fetch()'])
    expect(körtidsyta(`// fetch('https://x')\nconst s = 'process.env'`)).toEqual([])
    expect(körtidsyta(`@Cron('* * * * *') class A {}`)).toEqual(['@Cron'])
    expect(körtidsyta(`const k = process.env.X`)).toEqual(['process.env'])
  })
})

describe('A01 · Fortnox-skivan är oansluten i dagens kod', () => {
  const alla = tsFiler(SRC)
  const utanför = alla.filter((f) => !(f === FORTNOX || f.startsWith(FORTNOX + sep)))
  const innanför = alla.filter((f) => f.startsWith(FORTNOX + sep) && !/\.spec\.ts$/.test(f))

  it('mängderna är inte tomma (annars mäter provet ingenting)', () => {
    expect(utanför.length).toBeGreaterThan(500)
    expect(innanför.map((f) => relative(FORTNOX, f)).sort()).toEqual(
      expect.arrayContaining([
        'fortnox-mapping.ts',
        'fortnox-outbox.service.ts',
        'fortnox.module.ts',
        'fortnox.types.ts',
        join('providers', 'mock-fortnox.provider.ts'),
        join('providers', 'stub-fortnox.provider.ts'),
      ]),
    )
    expect(utanför).toContain(join(SRC, 'app.module.ts'))
  })

  it('ingen fil utanför fortnox/ importerar fortnox/', () => {
    const träffar = utanför.flatMap((f) =>
      specifikationer(readFileSync(f, 'utf8'), f)
        .filter((s) => pekarInIFortnox(f, s))
        .map((s) => `${relative(SRC, f)} → ${s}`),
    )
    expect(träffar).toEqual([])
  })

  it('ingen fil utanför fortnox/ refererar FortnoxModule/FortnoxOutboxService', () => {
    const träffar = utanför.filter((f) => {
      const id = identifierare(readFileSync(f, 'utf8'))
      return id.has('FortnoxModule') || id.has('FortnoxOutboxService')
    })
    expect(träffar.map((f) => relative(SRC, f))).toEqual([])
  })

  it('produktkoden i fortnox/ har ingen transport, controller, cron, kö, env eller bokföringsimport', () => {
    const träffar = innanför.flatMap((f) => {
      const källa = readFileSync(f, 'utf8')
      const moduler = specifikationer(källa, f)
        .filter((s) => FÖRBJUDNA_MODULER.some((re) => re.test(s)))
        .map((s) => `import ${s}`)
      return [...moduler, ...körtidsyta(källa)].map((t) => `${relative(FORTNOX, f)}: ${t}`)
    })
    expect(träffar).toEqual([])
  })
})
