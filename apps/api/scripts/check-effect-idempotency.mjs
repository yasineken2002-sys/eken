#!/usr/bin/env node
/**
 * CI-vakt — effektklassificeringen, och mekanismen som ska bära den.
 *
 * ── VARFÖR EN VAKT ALLS ─────────────────────────────────────────────────────
 *
 * `EFFECT_DECLARATIONS` (apps/api/src/ai/tools/effect-idempotency.ts) säger vad
 * varje bindande verktygs effekt tål vid en omkörning. En deklaration som ingen
 * prövar är en kommentar: den kan säga `IDEMPOTENT` om ett verktyg vars unika
 * index någon tog bort förra månaden, och ingenting blir rött. Felriktningen är
 * asymmetrisk — ett odedupliserbart verktyg som ser ut som klass (i) skickar
 * dubbla brev, medan motsatt fel bara ger en människa onödigt arbete.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 *   R1  OMFÅNG. Varje namn i `ACTION_TOOLS` har en deklaration, och varje
 *       deklaration pekar på ett verktyg som finns. Båda riktningarna: ett nytt
 *       verktyg utan klassificering fäller, och en död deklaration fäller.
 *
 *   R2  FAIL-CLOSED ÄR PÅKOPPLAD. `buildEffectCatalog` måste KASTA vid en
 *       oklassad post. Specen prövar att kastet sker; den här regeln prövar att
 *       koden fortfarande innehåller det, på rätt plats. (Delningen är den från
 *       #571: specen äger mekaniken, vakten äger påkopplingen.)
 *
 *   R3  MEKANISMEN FINNS. Varje `IDEMPOTENT` måste namnge minst en mekanism,
 *       och varje namngiven mekanism prövas mot koden.
 *
 *   R4  POLICY ÄR FAIL-CLOSED. `policyBeslutad: false` tvingar
 *       `KRÄVER_MÄNNISKA`. Annars ser "ingen har tänkt på det här än" ut som
 *       "en människa behövs", och de två är olika saker.
 *
 *   R5  `OKÄND` får aldrig vara `AUTOMATISK`.
 *
 * ── VAD R3 FAKTISKT PRÖVAR, OCH VAD DEN INTE GÖR ────────────────────────────
 *
 * Skrivet här med flit, eftersom en vakt vars räckvidd man TROR är större än den
 * är kostar lika mycket som en som saknas:
 *
 *   • `UNIKT_INDEX` prövas SEMANTISKT mot `schema.prisma`: modellen finns, och
 *     den bär ett unikt index över EXAKT de fälten (ordningsokänsligt). Tas
 *     indexet bort blir vakten röd. Det är den starka regeln.
 *   • `INNEHÅLLSHASH`, `STATUSGRIND`, `REN_UPPDATERING` prövas som
 *     DRIFTDETEKTERING: filen finns och symbolen står kvar i KOD. Det fångar
 *     radering och omdöpning — inte att någon försvagar grinden inifrån.
 *
 * ── TVÅ MASKNINGAR, TVÅ SYFTEN ──────────────────────────────────────────────
 *
 * Icke uppenbart, därför utskrivet:
 *
 *   • Deklarationen LÄSES med `blankComments` — värdena ÄR stränglitteraler
 *     (`'IDEMPOTENT'`), så `codeMask` hade blankat exakt det vi ska läsa. Att
 *     kommentarer blankas räcker: en utkommenterad post får inte räknas.
 *   • Symbolerna PRÖVAS med `codeMask` — varken en kommentar eller en
 *     stränglitteral (`const x = 'aiJournalSourceId'`) får uppfylla en regel.
 *
 * Självtest (kanariefåglar):
 *     node apps/api/scripts/check-effect-idempotency.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blankComments, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROT = join(HERE, '..', '..', '..')
const DEKLARATION = join(HERE, '..', 'src', 'ai', 'tools', 'effect-idempotency.ts')
const DEFINITION = join(HERE, '..', 'src', 'ai', 'tools', 'ai-tools.definition.ts')
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')

/** Matchar den öppnande klammern till `namn` och returnerar kroppen. */
function block(text, från) {
  const start = text.indexOf('{', från)
  if (start === -1) return null
  let djup = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') djup++
    else if (text[i] === '}') {
      djup--
      if (djup === 0) return { kropp: text.slice(start + 1, i), slut: i }
    }
  }
  return null
}

/** ACTION_TOOLS ur definitionsfilen — namnen, inte en andra lista. */
export function parseActionTools(src) {
  const text = blankComments(src)
  const i = text.indexOf('ACTION_TOOLS')
  if (i === -1) return []
  const b = block(text, text.indexOf('new Set(', i))
  const rå = b ? b.kropp : text.slice(i, text.indexOf('])', i))
  return [...rå.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** Deklarationerna, som en lista av poster. */
export function parseDeclarations(src) {
  const text = blankComments(src)
  const i = text.indexOf('EFFECT_DECLARATIONS')
  if (i === -1) return []
  const yttre = block(text, text.indexOf('=', i))
  if (!yttre) return []
  const poster = []
  let rest = yttre.kropp
  let offset = 0
  const nyckel = /(^|\n)\s{2}([a-z0-9_]+):\s*\{/g
  let m
  while ((m = nyckel.exec(rest)) !== null) {
    const b = block(rest, m.index + m[0].length - 1)
    if (!b) continue
    poster.push({ namn: m[2], kropp: b.kropp })
    nyckel.lastIndex = b.slut
    offset = b.slut
  }
  void offset
  return poster.map((p) => ({
    namn: p.namn,
    effectIdempotency: (p.kropp.match(/effectIdempotency:\s*'([A-ZÄÅÖ_]+)'/) ?? [])[1] ?? null,
    idempotencyUnit: (p.kropp.match(/idempotencyUnit:\s*'([A-ZÄÅÖ_]+)'/) ?? [])[1] ?? null,
    plats: (p.kropp.match(/plats:\s*'([A-ZÄÅÖ_]+)'/) ?? [])[1] ?? null,
    resumptionPolicy: (p.kropp.match(/resumptionPolicy:\s*'([A-ZÄÅÖ_]+)'/) ?? [])[1] ?? null,
    policyBeslutad: /policyBeslutad:\s*true/.test(p.kropp),
    mekanismer: [...p.kropp.matchAll(/\{\s*typ:\s*'([A-ZÄÅÖ_]+)'([^}]*)\}/g)].map((mm) => ({
      typ: mm[1],
      modell: (mm[2].match(/modell:\s*'([A-Za-z]+)'/) ?? [])[1] ?? null,
      falt: [...mm[2].matchAll(/'([a-zA-Z]+)'/g)]
        .map((f) => f[1])
        .filter((f) => mm[2].includes('falt') && f !== (mm[2].match(/modell:\s*'([A-Za-z]+)'/) ?? [])[1]),
      fil: (mm[2].match(/fil:\s*'([^']+)'/) ?? [])[1] ?? null,
      symbol: (mm[2].match(/symbol:\s*'([^']+)'/) ?? [])[1] ?? null,
    })),
  }))
}

/** Bär `modell` ett unikt index över exakt `falt`? Läst ur schemat, som KOD. */
export function harUniktIndex(schemaSrc, modell, falt) {
  const text = codeMask(schemaSrc)
  const m = new RegExp(`(^|\\n)model\\s+${modell}\\s*\\{`).exec(text)
  if (!m) return false
  const b = block(text, m.index + m[0].length - 1)
  if (!b) return false
  const vill = [...falt].sort().join(',')
  // Sammansatt: @@unique([a, b])
  for (const u of b.kropp.matchAll(/@@unique\(\s*\[([^\]]*)\]/g)) {
    const har = u[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
      .join(',')
    if (har === vill) return true
  }
  // Enkolumn: `falt  Typ  @unique`
  if (falt.length === 1) {
    const rad = new RegExp(`(^|\\n)\\s*${falt[0]}\\s+\\S+[^\\n]*@unique`)
    if (rad.test(b.kropp)) return true
  }
  return false
}

/** Står symbolen kvar i filen, i KOD (inte i prosa, inte i en sträng)? */
function symbolFinns(absFil, symbol) {
  if (!existsSync(absFil)) return false
  const kod = codeMask(readFileSync(absFil, 'utf8'))
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(kod)
}

/**
 * Kärnan, matbar med SYNTETISK indata så kanariefåglarna kan pröva former som
 * inte finns i repot.
 */
export function granska({ deklarationSrc, definitionSrc, schemaSrc, filFinns }) {
  const fel = []
  const verktyg = parseActionTools(definitionSrc)
  const poster = parseDeclarations(deklarationSrc)

  // R1 — OMFÅNG, båda riktningarna. Tom mängd är ett FEL, inte "inget att göra".
  if (verktyg.length === 0) fel.push('R1 ACTION_TOOLS läste till TOM mängd — vakten mäter ingenting')
  if (poster.length === 0) fel.push('R1 EFFECT_DECLARATIONS läste till TOM mängd — vakten mäter ingenting')
  const deklarerade = new Set(poster.map((p) => p.namn))
  for (const v of verktyg) {
    if (!deklarerade.has(v)) {
      fel.push(
        `R1 verktyget "${v}" står i ACTION_TOOLS men saknar effektklassificering — ` +
          'ett oklassat verktyg får inte vara återupptagbart',
      )
    }
  }
  const finns = new Set(verktyg)
  for (const p of poster) {
    if (!finns.has(p.namn)) fel.push(`R1 död deklaration "${p.namn}" — verktyget finns inte i ACTION_TOOLS`)
  }

  // R2 — fail-closed är PÅKOPPLAD i katalogbyggaren.
  const kod = codeMask(deklarationSrc)
  const byggare = kod.indexOf('function buildEffectCatalog')
  if (byggare === -1) fel.push('R2 buildEffectCatalog saknas')
  else {
    const b = block(kod, byggare)
    if (!b || !/\bthrow\s+new\s+Error\b/.test(b.kropp)) {
      fel.push('R2 buildEffectCatalog kastar inte vid oklassad post — fail-closed är bortkopplad')
    }
  }

  for (const p of poster) {
    // R3 — mekanismen finns.
    if (p.effectIdempotency === 'IDEMPOTENT' && p.mekanismer.length === 0) {
      fel.push(`R3 "${p.namn}" påstår IDEMPOTENT utan att namnge någon mekanism`)
    }
    for (const m of p.mekanismer) {
      if (m.typ === 'INGEN_EFFEKT') continue
      if (m.typ === 'UNIKT_INDEX') {
        if (!harUniktIndex(schemaSrc, m.modell, m.falt)) {
          fel.push(
            `R3 "${p.namn}" påstår IDEMPOTENT via unikt index ${m.modell}(${m.falt.join(', ')}) ` +
              '— något sådant index finns inte i schema.prisma',
          )
        }
        continue
      }
      if (!m.fil || !m.symbol) {
        fel.push(`R3 "${p.namn}" har en ${m.typ}-mekanism utan fil eller symbol`)
        continue
      }
      if (!filFinns(m.fil, m.symbol)) {
        fel.push(
          `R3 "${p.namn}" påstår IDEMPOTENT via ${m.typ} "${m.symbol}" i ${m.fil} — ` +
            'symbolen finns inte i kod där (raderad, omdöpt, eller bara i prosa)',
        )
      }
    }

    // R4 — policy fail-closed.
    if (!p.policyBeslutad && p.resumptionPolicy !== 'KRÄVER_MÄNNISKA') {
      fel.push(
        `R4 "${p.namn}" har policyBeslutad: false men resumptionPolicy: ${p.resumptionPolicy} — ` +
          'ett obeslutat verktyg måste stå KRÄVER_MÄNNISKA',
      )
    }

    // R5 — OKÄND är aldrig automatisk.
    if (p.effectIdempotency === 'OKÄND' && p.resumptionPolicy === 'AUTOMATISK') {
      fel.push(`R5 "${p.namn}" är OKÄND och ändå AUTOMATISK — OKÄND betyder aldrig "antagligen okej"`)
    }
  }

  return { fel, antalVerktyg: verktyg.length, antalPoster: poster.length }
}

function läs(p) {
  return readFileSync(p, 'utf8')
}

function kör() {
  const { fel, antalVerktyg, antalPoster } = granska({
    deklarationSrc: läs(DEKLARATION),
    definitionSrc: läs(DEFINITION),
    schemaSrc: läs(SCHEMA),
    filFinns: (rel, symbol) => symbolFinns(join(ROT, rel), symbol),
  })
  if (fel.length) {
    console.error('❌ Effektklassificeringen håller inte:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(
    `✅ Effektklassificeringen håller: ${antalPoster} deklarationer för ${antalVerktyg} bindande verktyg.`,
  )
}

function självtest() {
  const fel = []
  const t = (namn, ok, extra = '') => {
    if (!ok) fel.push(`${namn}${extra ? ` — ${extra}` : ''}`)
  }

  const ÄKTA_DEF = läs(DEFINITION)
  const ÄKTA_DEK = läs(DEKLARATION)
  const ÄKTA_SCHEMA = läs(SCHEMA)
  const allaFinns = () => true
  const bas = { deklarationSrc: ÄKTA_DEK, definitionSrc: ÄKTA_DEF, schemaSrc: ÄKTA_SCHEMA, filFinns: allaFinns }

  // KANARIE 0 — extraktionen ser lika många poster som en rå räkning.
  const råttAntal = (blankComments(ÄKTA_DEK).match(/(^|\n) {2}[a-z0-9_]+: \{/g) ?? []).length
  const sedda = parseDeclarations(ÄKTA_DEK).length
  t('KANARIE 0 (extraktionen ser lika många poster som en rå räkning)', sedda === råttAntal,
    `extraherade ${sedda}, rå räkning ${råttAntal}`)
  t('KANARIE 0 (antalet är inte noll)', sedda > 0, 'extraktionen hittar inga poster alls')
  t('KANARIE 0 (ACTION_TOOLS läses)', parseActionTools(ÄKTA_DEF).length > 0)

  // KANARIE OMFÅNG — tom mängd FÄLLER, i båda riktningarna.
  t('KANARIE omfång (tom ACTION_TOOLS → fäller)',
    granska({ ...bas, definitionSrc: 'export const ACTION_TOOLS = new Set([])' }).fel.some((f) =>
      f.includes('TOM mängd')),
    'en tom verktygsmängd gjorde vakten grön')
  t('KANARIE omfång (tom deklaration → fäller)',
    granska({ ...bas, deklarationSrc: 'export const EFFECT_DECLARATIONS = {}' }).fel.some((f) =>
      f.includes('TOM mängd')),
    'en tom deklarationsmängd gjorde vakten grön')

  // KANARIE REGEL — ett NYTT verktyg utan klassificering fäller, exakt en gång.
  const medNytt = ÄKTA_DEF.replace(
    "export const ACTION_TOOLS = new Set([",
    "export const ACTION_TOOLS = new Set([\n  'skicka_ovanligt_brev',",
  )
  const r1 = granska({ ...bas, definitionSrc: medNytt }).fel.filter((f) =>
    f.includes('skicka_ovanligt_brev'))
  t('KANARIE regel (nytt verktyg utan klassificering → exakt 1 brott)', r1.length === 1,
    JSON.stringify(r1))

  // KANARIE R3 — DEN VIKTIGA. IDEMPOTENT med ett index som inte finns.
  const falsktIndex = `
export const ACTION_TOOLS = new Set(['x'])`
  const dekFalsk = `
export const EFFECT_DECLARATIONS = {
  x: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_INDEX', livslangd: 'a' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [{ typ: 'UNIKT_INDEX', modell: 'Faktura', falt: ['finnsInte'] }],
  },
}
export function buildEffectCatalog() { throw new Error('x') }`
  const r3 = granska({ deklarationSrc: dekFalsk, definitionSrc: falsktIndex, schemaSrc: ÄKTA_SCHEMA, filFinns: allaFinns })
  t('KANARIE R3 (IDEMPOTENT via index som inte finns → fäller)',
    r3.fel.some((f) => f.includes('finns inte i schema.prisma')),
    JSON.stringify(r3.fel))

  // ... och samma deklaration mot ett index som FINNS ska INTE fälla på R3.
  const dekSann = dekFalsk.replace(
    "modell: 'Faktura', falt: ['finnsInte']",
    "modell: 'Unit', falt: ['propertyId', 'unitNumber']",
  )
  const r3ok = granska({ deklarationSrc: dekSann, definitionSrc: falsktIndex, schemaSrc: ÄKTA_SCHEMA, filFinns: allaFinns })
  t('KANARIE R3 (IDEMPOTENT via index som FINNS → fäller inte)',
    !r3ok.fel.some((f) => f.includes('R3')), JSON.stringify(r3ok.fel))

  // KANARIE R3 — symbolen som bara står i PROSA får inte uppfylla regeln.
  const baraKommentar = codeMask('// aiJournalSourceId nämns bara i en kommentar här\nconst x = 1')
  t('KANARIE R3 (symbol i kommentar uppfyller INTE regeln)',
    !/\baiJournalSourceId\b/.test(baraKommentar),
    'en kommentar som nämner symbolen skulle ha gjort vakten grön')
  const baraSträng = codeMask("const namn = 'aiJournalSourceId'\n")
  t('KANARIE R3 (symbol i stränglitteral uppfyller INTE regeln)',
    !/\baiJournalSourceId\b/.test(baraSträng),
    'en sträng som nämner symbolen skulle ha gjort vakten grön')

  // KANARIE R2 — fail-closed bortkopplad fäller.
  const utanKast = ÄKTA_DEK.replace(/throw new Error\(\s*`Verktyget/, 'return null as never; (`Verktyget')
  t('KANARIE R2 (buildEffectCatalog utan kast → fäller)',
    granska({ ...bas, deklarationSrc: utanKast }).fel.some((f) => f.startsWith('R2')),
    'en bortkopplad fail-closed gjorde vakten grön')

  // KANARIE R4 — obeslutad policy som ändå är AUTOMATISK fäller.
  const r4 = granska({
    deklarationSrc: dekSann.replace("resumptionPolicy: 'KRÄVER_MÄNNISKA'", "resumptionPolicy: 'AUTOMATISK'"),
    definitionSrc: falsktIndex,
    schemaSrc: ÄKTA_SCHEMA,
    filFinns: allaFinns,
  })
  t('KANARIE R4 (policyBeslutad: false + AUTOMATISK → fäller)',
    r4.fel.some((f) => f.startsWith('R4')), JSON.stringify(r4.fel))

  // KANARIE R5 — OKÄND + AUTOMATISK fäller.
  const r5 = granska({
    deklarationSrc: dekSann
      .replace("effectIdempotency: 'IDEMPOTENT'", "effectIdempotency: 'OKÄND'")
      .replace("resumptionPolicy: 'KRÄVER_MÄNNISKA'", "resumptionPolicy: 'AUTOMATISK'")
      .replace("policyBeslutad: false", "policyBeslutad: true"),
    definitionSrc: falsktIndex,
    schemaSrc: ÄKTA_SCHEMA,
    filFinns: allaFinns,
  })
  t('KANARIE R5 (OKÄND + AUTOMATISK → fäller)', r5.fel.some((f) => f.startsWith('R5')), JSON.stringify(r5.fel))

  // KANARIE — ett @@unique som står i en KOMMENTAR i schemat uppfyller inte R3.
  const schemaKommenterat = `model Zzz {\n  a String\n  b String\n  // @@unique([a, b])\n}`
  t('KANARIE R3 (@@unique i kommentar → räknas inte)',
    !harUniktIndex(schemaKommenterat, 'Zzz', ['a', 'b']),
    'ett utkommenterat index gjorde vakten grön')
  t('KANARIE R3 (@@unique i kod → räknas)',
    harUniktIndex(`model Zzz {\n  a String\n  b String\n  @@unique([a, b])\n}`, 'Zzz', ['a', 'b']))

  // Den DELADE skannerns egna kanariefåglar.
  for (const f of kanariefåglar()) fel.push(`delad skanner: ${f}`)

  if (fel.length) {
    console.error('❌ Självtestet föll:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(`✅ Självtest grönt (${sedda} deklarationer sedda, lika många som en rå räkning).`)
}

if (process.argv.includes('--self-test')) självtest()
else kör()
