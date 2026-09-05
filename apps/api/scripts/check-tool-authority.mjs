#!/usr/bin/env node
/**
 * CI-VAKT — AUKTORITETSFÄLTEN ÄR FÖRENLIGA MED DET SOM REDAN ÄR MÄTT.
 *
 * ── DEFEKTEN DEN FINNS FÖR ──────────────────────────────────────────────────
 *
 * `agentAllowlist`, `authorityScope` och `supportsUndo` är DEKLARATIONER. En
 * deklaration utan vakt är ett påstående, och den här kodbasen har mätt vad det
 * kostar: `externalHandle` fanns i ett år utan att prövas mot koden, och när
 * vakt 7 äntligen ställde frågan stod två verktyg som klass A trots att de köar
 * ett välkomstmejl till hyresgästen.
 *
 * Fälten är dessutom den farligaste sorten: `agentAllowlist: true` är ett
 * tillstånd att låta en maskin handla obevakat. Ett fel där syns inte i något
 * test — det syns hos en hyresgäst.
 *
 * ── REGLERNA, ALLA MOT MÄNGDER SOM REDAN MÄTS ───────────────────────────────
 *
 * Ingen av reglerna nedan bygger en ny lista. Var och en korsar de nya fälten
 * mot något som redan finns och redan vaktas — det är hela poängen: en ny
 * uppräkning hade blivit fel första gången någon lade till ett verktyg.
 *
 * R1  `agentAllowlist: true` kräver FYRA härledda villkor:
 *       (a) `authorityScope === 'EGEN_ORG'`
 *       (b) inga utåtriktade sänkor i vakt 7:s manifest
 *           (`tool-outward-capabilities.json`)
 *       (c) `supportsUndo.kind !== 'IRREVERSIBEL'` — obevakat handlande utan
 *           ångerväg är inte automation, det är en satsning
 *       (d) verktyget står inte i `ACCOUNTING_ONLY_ACTIONS`
 *     Fail-closed: `false` kräver ingenting.
 *
 * R2  `authorityScope: 'MOT_TREDJE_PART'` kräver `externalHandle !== 'EJ_TILLÄMPLIG'`.
 *     Når man en tredje part finns ett handtag — annars är det ingen tredje part
 *     man nått, utan en anteckning om att man tänkt göra det.
 *     Regeln flyttade en riktig post: `mark_sent_to_collection` HETER som en
 *     handling mot inkasso, saknar handtag, och är därför `MOT_HYRESGAST`.
 *
 * R3  Ett verktyg som BOKFÖR eller SKICKAR får inte ha
 *     `supportsUndo: IRREVERSIBEL` med ett skäl kortare än `MIN_REASON` tecken.
 *
 * R4  `supportsUndo: { kind: 'VÄG', fil, symbol }` — symbolen ska finnas i KOD i
 *     just den filen. Läst genom `codeMask` och avgränsad med `\p{L}`, aldrig
 *     `\b`: kodbasen namnger på svenska, och `\b` är ASCII-definierat.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Två saker, båda verkliga, och båda ägs av etapp 7:
 *
 *   1. ATT ÅNGERVÄGEN FAKTISKT ÅTERSTÄLLER ALLT. R4 mäter att symbolen FINNS,
 *      inte vad den gör. `invoices.service.ts:remove` kan mycket väl lämna en
 *      journalpost kvar. Det är en beteendefråga och hör hemma i ett prov mot
 *      riktig Postgres, inte i en källskanning — samma gräns som
 *      `check-effect-idempotency.mjs` drar för sina INNEHÅLLSHASH-mekanismer.
 *   2. ATT EN DELEGATION EXISTERAR. `agentAllowlist: true` säger att verktyget
 *      FÅR delegeras, inte att någon delegerat det. Delegationerna är etapp 7,
 *      och tills de finns är fältet en förberedelse — ingen kodväg läser det för
 *      att släppa igenom något.
 *
 * En tredje, mindre: R3:s "bokför" härleds ur `ACCOUNTING_ONLY_ACTIONS`, som är
 * en ROLLGRIND använd som proxy. Den missar `create_invoice` och
 * `mark_invoice_paid`, som rör pengar utan att stå där. Proxyn är vald därför
 * att den är MÄTT och underhålls av någon annan; en egen lista hade varit den
 * uppräkning regeln finns för att slippa.
 *
 * Lokalt:    node apps/api/scripts/check-tool-authority.mjs
 * Självtest: node apps/api/scripts/check-tool-authority.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const DEKLARATIONER = join(SRC, 'ai', 'tools', 'effect-idempotency.ts')
const VERKTYG = join(SRC, 'ai', 'tools', 'ai-tools.definition.ts')
const MANIFEST = join(HERE, 'tool-outward-capabilities.json')

/**
 * Minsta skäl för `IRREVERSIBEL` på något som bokför eller skickar.
 *
 * ⚠️ MED FLIT INTE `MIN_REASON` FRÅN `check-ai-display-masking.mjs` (som är 30).
 * Att importera den hade gjort två gränser till en, och de ska kunna ändras var
 * för sig: där handlar det om att kvittera en maskeringsyta, här om att förklara
 * varför en effekt mot en människa inte går att ta tillbaka. Samma familj som
 * `ATERUPPTAGNING_TAK_MS = PENDING_ACTION_TTL_MS`, som CLAUDE.md pekar ut som
 * samma defekt i talform.
 *
 * 80 och inte 30: trettio tecken rymmer "går inte att ångra", vilket är
 * påståendet som ska motiveras — inte motiveringen.
 */
export const MIN_REASON = 80

// ── läsning ─────────────────────────────────────────────────────────────────

/** Balanserad klammermatchning från index `i`, där `{` står. */
export function block(text, i) {
  if (text[i] !== '{') return null
  let d = 0
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') d++
    else if (text[j] === '}') {
      d--
      if (d === 0) return [i, j + 1]
    }
  }
  return null
}

/**
 * Deklarationerna, med de fält reglerna behöver.
 *
 * `blankComments` och inte `codeMask`: fälten är STRÄNGVÄRDEN (`'EGEN_ORG'`,
 * `fil: '…'`, skältexten), och `codeMask` blankar just stränginnehåll. En vy
 * per fråga — det som bor i en sträng läses inte med kodmasken.
 */
export function parseDeklarationer(rå) {
  const text = blankComments(rå)
  const i = text.indexOf('EFFECT_DECLARATIONS')
  if (i === -1) return new Map()
  const yttre = block(text, text.indexOf('{', i))
  if (!yttre) return new Map()
  const kropp = text.slice(yttre[0], yttre[1])
  const ut = new Map()
  const nyckel = /(^|\n)\s{2}([\p{Ll}\p{N}_]+):\s*\{/gu
  let m
  while ((m = nyckel.exec(kropp)) !== null) {
    const b = block(kropp, m.index + m[0].length - 1)
    if (!b) continue
    const p = kropp.slice(b[0], b[1])
    const undoM = /supportsUndo:\s*\{([\s\S]*?)\n\s{4}\}|supportsUndo:\s*\{([^}]*)\}/u.exec(p)
    const undo = (undoM?.[1] ?? undoM?.[2] ?? '').trim()
    ut.set(m[2], {
      externalHandle: (p.match(/externalHandle:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
      agentAllowlist: /agentAllowlist:\s*true/.test(p)
        ? true
        : /agentAllowlist:\s*false/.test(p)
          ? false
          : null,
      authorityScope: (p.match(/authorityScope:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
      undo: undo
        ? {
            kind: (undo.match(/kind:\s*'([\p{Lu}_ÄÖÅ]+)'/u) ?? [])[1] ?? null,
            fil: (undo.match(/fil:\s*'([^']+)'/) ?? [])[1] ?? null,
            symbol: (undo.match(/symbol:\s*'([^']+)'/) ?? [])[1] ?? null,
            skäl: (undo.match(/skäl:\s*'([^']*)'/u) ?? [])[1] ?? null,
          }
        : null,
    })
  }
  return ut
}

/** En namngiven `new Set([...])` ur definitionen — namnen ur RÅTEXTEN. */
export function parseSet(rå, namn) {
  const kod = codeMask(rå)
  const i = kod.indexOf(namn)
  if (i === -1) return new Set()
  const start = kod.indexOf('[', i)
  const slut = kod.indexOf(']', start)
  if (start === -1 || slut === -1) return new Set()
  return new Set([...rå.slice(start, slut).matchAll(/'([\p{Ll}\p{N}_]+)'/gu)].map((m) => m[1]))
}

/**
 * Finns symbolen i filen, som KOD?
 *
 * `\p{L}`-avgränsning och inte `\b`: `\b` är ASCII-definierat i JavaScript, så
 * ett svenskt metodnamn (`ångraAvi`) hade aldrig matchat — och utfallet vore ett
 * FALSKT LARM om en symbol som finns. Se check-identifier-regex.mjs.
 */
export function symbolFinns(kod, symbol) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u').test(kod)
}

// ── kärnan ──────────────────────────────────────────────────────────────────

export function evaluate({ deklarationer, actionTools, manifest, accountingOnly, läsFil }) {
  const problem = []

  // OMFÅNGSKANARIEFÅGLARNA — en tom mängd är grön för alltid.
  if (deklarationer.size === 0)
    problem.push({
      regel: 'OMFÅNG',
      detalj: 'NOLL deklarationer lästes ur effect-idempotency.ts. Svepet har gått blint.',
    })
  if (actionTools.size === 0)
    problem.push({ regel: 'OMFÅNG', detalj: 'NOLL ACTION_TOOLS lästes — reglerna prövar ingenting.' })
  if (accountingOnly.size === 0)
    problem.push({
      regel: 'OMFÅNG',
      detalj: 'NOLL poster i ACCOUNTING_ONLY_ACTIONS. R3:s bokföringshalva mäter då ingenting.',
    })

  for (const verktyg of [...actionTools].sort()) {
    const d = deklarationer.get(verktyg)
    if (!d) continue // ägs av buildEffectCatalog och check-effect-idempotency
    const sänkor = Object.keys(manifest.verktyg?.[verktyg] ?? {})

    // ── R1 ────────────────────────────────────────────────────────────────
    if (d.agentAllowlist === null)
      problem.push({
        regel: 'R1',
        detalj: `\`${verktyg}\` saknar agentAllowlist. Frånvaro är inget svar — true eller false.`,
      })
    if (d.agentAllowlist === true) {
      if (d.authorityScope !== 'EGEN_ORG')
        problem.push({
          regel: 'R1',
          detalj:
            `\`${verktyg}\` har agentAllowlist: true med authorityScope: ${d.authorityScope}. ` +
            'En agent får handla obevakat bara i hyresvärdens EGNA register — allt som rör ' +
            'en hyresgäst eller en tredje part kräver ett ja per handling tills etapp 7 ' +
            'ger delegationen en egen auktoritetsgräns.',
        })
      if (sänkor.length > 0)
        problem.push({
          regel: 'R1',
          detalj:
            `\`${verktyg}\` har agentAllowlist: true men når ${sänkor.join(', ')} enligt ` +
            'tool-outward-capabilities.json. Ett verktyg som skickar något utåt kan inte ' +
            'vara obevakat — vakt 7 mäter förmågan, den här regeln följer den.',
        })
      if (d.undo?.kind === 'IRREVERSIBEL')
        problem.push({
          regel: 'R1',
          detalj:
            `\`${verktyg}\` har agentAllowlist: true men supportsUndo: IRREVERSIBEL. ` +
            'Obevakat handlande utan ångerväg är inte automation, det är en satsning.',
        })
      if (accountingOnly.has(verktyg))
        problem.push({
          regel: 'R1',
          detalj:
            `\`${verktyg}\` har agentAllowlist: true men står i ACCOUNTING_ONLY_ACTIONS. ` +
            'Det som bokför kräver en människa; BFL:s verifikationskedja är inte en ' +
            'automatiseringsfråga.',
        })
    }

    // ── R2 ────────────────────────────────────────────────────────────────
    if (!d.authorityScope)
      problem.push({ regel: 'R2', detalj: `\`${verktyg}\` saknar authorityScope.` })
    else if (d.authorityScope === 'MOT_TREDJE_PART' && d.externalHandle === 'EJ_TILLÄMPLIG')
      problem.push({
        regel: 'R2',
        detalj:
          `\`${verktyg}\` säger MOT_TREDJE_PART men har externalHandle: EJ_TILLÄMPLIG. ` +
          'Når man en tredje part finns ett handtag att fråga med efteråt. Utan handtag ' +
          'är det ingen tredje part man nått, utan en anteckning om att man tänkt göra det.',
      })

    // ── R3 ────────────────────────────────────────────────────────────────
    if (!d.undo?.kind) {
      problem.push({
        regel: 'R3',
        detalj: `\`${verktyg}\` saknar supportsUndo. Ange VÄG med fil+symbol, eller IRREVERSIBEL med skäl.`,
      })
    } else if (d.undo.kind === 'IRREVERSIBEL') {
      const bokför = accountingOnly.has(verktyg)
      const skickar = sänkor.length > 0
      const skäl = (d.undo.skäl ?? '').trim()
      if ((bokför || skickar) && skäl.length < MIN_REASON)
        problem.push({
          regel: 'R3',
          detalj:
            `\`${verktyg}\` ${bokför ? 'bokför' : ''}${bokför && skickar ? ' och ' : ''}` +
            `${skickar ? `skickar (${sänkor.join(', ')})` : ''} och är IRREVERSIBEL med ` +
            `${skäl.length} teckens skäl. Tröskeln är ${MIN_REASON}: "går inte att ångra" ` +
            'är påståendet som ska motiveras, inte motiveringen.',
        })
    } else if (d.undo.kind === 'VÄG') {
      // ── R4 ──────────────────────────────────────────────────────────────
      if (!d.undo.fil || !d.undo.symbol) {
        problem.push({
          regel: 'R4',
          detalj: `\`${verktyg}\` har supportsUndo: VÄG utan fil eller symbol. En väg utan adress är ingen väg.`,
        })
      } else {
        const kod = läsFil(d.undo.fil)
        if (kod === null)
          problem.push({
            regel: 'R4',
            detalj: `\`${verktyg}\` pekar på filen \`${d.undo.fil}\`, som inte finns under src/.`,
          })
        else if (!symbolFinns(codeMask(kod), d.undo.symbol))
          problem.push({
            regel: 'R4',
            detalj:
              `\`${verktyg}\`: ångervägen \`${d.undo.symbol}\` finns inte som KOD i ` +
              `\`${d.undo.fil}\`. En omdöpt metod lämnar en deklaration som ser ut att ` +
              'peka på något.',
          })
      }
    } else if (d.undo.kind === 'INGEN_EFFEKT') {
      // Tillåtet bara där idempotensmekanismen också säger INGEN_EFFEKT —
      // annars vore det en bekväm väg förbi både VÄG och IRREVERSIBEL.
      if (sänkor.length > 0 || accountingOnly.has(verktyg))
        problem.push({
          regel: 'R3',
          detalj:
            `\`${verktyg}\` säger supportsUndo: INGEN_EFFEKT men ${
              sänkor.length > 0 ? `når ${sänkor.join(', ')}` : 'bokför'
            }. "Ingenting hände" är då inte sant.`,
        })
    }
  }

  return problem
}

// ── körning ─────────────────────────────────────────────────────────────────

function läsAllt() {
  const defRå = readFileSync(VERKTYG, 'utf8')
  return {
    deklarationer: parseDeklarationer(readFileSync(DEKLARATIONER, 'utf8')),
    actionTools: parseSet(defRå, 'ACTION_TOOLS'),
    accountingOnly: parseSet(defRå, 'ACCOUNTING_ONLY_ACTIONS'),
    manifest: JSON.parse(readFileSync(MANIFEST, 'utf8')),
    läsFil: (rel) => {
      const p = join(SRC, rel)
      return existsSync(p) ? readFileSync(p, 'utf8') : null
    },
  }
}

function kör() {
  const indata = läsAllt()
  const problem = evaluate(indata)

  if (problem.length > 0) {
    console.error('\n=== AUKTORITETSFÄLTEN STÄMMER INTE (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.regel}\n   ${p.detalj}\n`)
    console.error(
      '`agentAllowlist: true` är ett tillstånd att låta en maskin handla obevakat.\n' +
        'Ett fel där syns inte i ett test — det syns hos en hyresgäst.\n',
    )
    process.exit(1)
  }

  const d = indata.deklarationer
  const allow = [...d].filter(([, v]) => v.agentAllowlist === true).map(([n]) => n)
  const per = (s) => [...d].filter(([, v]) => v.authorityScope === s).length
  console.warn(
    `✅ ${d.size} verktyg: agentAllowlist true för ${allow.length} — ${allow.sort().join(', ')}.\n` +
      `   authorityScope: ${per('EGEN_ORG')} EGEN_ORG · ${per('MOT_HYRESGAST')} MOT_HYRESGAST · ` +
      `${per('MOT_TREDJE_PART')} MOT_TREDJE_PART. Tröskel för IRREVERSIBEL-skäl: ${MIN_REASON} tecken.`,
  )
}

// ── självtest ───────────────────────────────────────────────────────────────

const FIXTUR = `export const EFFECT_DECLARATIONS = {
  ren_anteckning: {
    externalHandle: 'EJ_TILLÄMPLIG',
    agentAllowlist: true,
    authorityScope: 'EGEN_ORG',
    supportsUndo: { kind: 'VÄG', fil: 'x/x.service.ts', symbol: 'raderaAnteckning' },
  },
  bokforare: {
    externalHandle: 'EJ_TILLÄMPLIG',
    agentAllowlist: false,
    authorityScope: 'EGEN_ORG',
    supportsUndo: { kind: 'VÄG', fil: 'x/x.service.ts', symbol: 'raderaAnteckning' },
  },
  mejlare: {
    externalHandle: 'INGET',
    agentAllowlist: false,
    authorityScope: 'MOT_HYRESGAST',
    supportsUndo: {
      kind: 'IRREVERSIBEL',
      skäl: 'Ett avsänt mejl går inte att kalla tillbaka; mottagaren har läst det och ingen radering i systemet ändrar den saken.',
    },
  },
}
`

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }

  const bas = (över = {}) => ({
    deklarationer: parseDeklarationer(FIXTUR),
    actionTools: new Set(['ren_anteckning', 'bokforare', 'mejlare']),
    accountingOnly: new Set(['bokforare']),
    manifest: { verktyg: { mejlare: { MAIL: ['mailService.sendCustomEmail'] } } },
    läsFil: () => 'export class X { async raderaAnteckning() {} }',
    ...över,
  })

  // ── PARSNINGEN ────────────────────────────────────────────────────────────
  {
    const d = parseDeklarationer(FIXTUR)
    t('parsern läser alla tre posterna', d.size === 3, `${d.size}`)
    t('agentAllowlist läses som boolean, inte som sträng',
      d.get('ren_anteckning').agentAllowlist === true && d.get('mejlare').agentAllowlist === false,
      JSON.stringify([d.get('ren_anteckning').agentAllowlist, d.get('mejlare').agentAllowlist]))
    t('supportsUndo: VÄG läses med fil och symbol',
      d.get('bokforare').undo?.fil === 'x/x.service.ts' && d.get('bokforare').undo?.symbol === 'raderaAnteckning',
      JSON.stringify(d.get('bokforare').undo))
    t('supportsUndo: IRREVERSIBEL läser skältexten',
      (d.get('mejlare').undo?.skäl ?? '').length > MIN_REASON, `${(d.get('mejlare').undo?.skäl ?? '').length} tecken`)
  }

  t('baslinjen (fixturen är förenlig) → 0 fynd', evaluate(bas()).length === 0, JSON.stringify(evaluate(bas())))

  // ── R1, alla fyra klausulerna var för sig ────────────────────────────────
  {
    const byt = (från, till) => parseDeklarationer(FIXTUR.replace(från, till))

    const a = evaluate(bas({ deklarationer: byt("authorityScope: 'EGEN_ORG',\n    supportsUndo: { kind: 'VÄG', fil: 'x/x.service.ts', symbol: 'raderaAnteckning' },\n  },\n  bokforare", "authorityScope: 'MOT_HYRESGAST',\n    supportsUndo: { kind: 'VÄG', fil: 'x/x.service.ts', symbol: 'raderaAnteckning' },\n  },\n  bokforare") }))
    t('R1(a): true + MOT_HYRESGAST → RÖTT',
      a.some((p) => p.regel === 'R1' && p.detalj.includes('ren_anteckning') && p.detalj.includes('MOT_HYRESGAST')),
      JSON.stringify(a.map((p) => p.regel)))

    const b = evaluate(bas({ manifest: { verktyg: { ren_anteckning: { MAIL: ['x.y'] } } } }))
    t('R1(b): true + en sänka i vakt 7:s manifest → RÖTT',
      b.some((p) => p.regel === 'R1' && p.detalj.includes('ren_anteckning') && p.detalj.includes('MAIL')),
      JSON.stringify(b.map((p) => p.detalj.slice(0, 30))))

    const c = evaluate(bas({
      deklarationer: byt(
        "supportsUndo: { kind: 'VÄG', fil: 'x/x.service.ts', symbol: 'raderaAnteckning' },\n  },\n  bokforare",
        "supportsUndo: { kind: 'IRREVERSIBEL', skäl: 'Det här skälet är gott och väl över åttio tecken långt, så R3 kan aldrig vara det som fäller här.' },\n  },\n  bokforare",
      ),
    }))
    t('R1(c): true + IRREVERSIBEL → RÖTT',
      c.some((p) => p.regel === 'R1' && p.detalj.includes('satsning')),
      JSON.stringify(c.map((p) => p.detalj.slice(0, 30))))

    const dd = evaluate(bas({ accountingOnly: new Set(['ren_anteckning', 'bokforare']) }))
    t('R1(d): true + ACCOUNTING_ONLY_ACTIONS → RÖTT',
      dd.some((p) => p.regel === 'R1' && p.detalj.includes('BFL')),
      JSON.stringify(dd.map((p) => p.detalj.slice(0, 30))))
  }

  // ── R2 ────────────────────────────────────────────────────────────────────
  {
    const r = evaluate(bas({
      deklarationer: parseDeklarationer(FIXTUR.replace("authorityScope: 'MOT_HYRESGAST'", "authorityScope: 'MOT_TREDJE_PART'").replace("externalHandle: 'INGET'", "externalHandle: 'EJ_TILLÄMPLIG'")),
    }))
    t('R2: MOT_TREDJE_PART utan externt handtag → RÖTT',
      r.some((p) => p.regel === 'R2' && p.detalj.includes('mejlare')),
      JSON.stringify(r.map((p) => p.regel)))
    // MOTPROV: med ett handtag är samma post tyst.
    const ok = evaluate(bas({
      deklarationer: parseDeklarationer(FIXTUR.replace("authorityScope: 'MOT_HYRESGAST'", "authorityScope: 'MOT_TREDJE_PART'")),
    }))
    t('R2 MOTPROV: MOT_TREDJE_PART MED handtag → tyst',
      !ok.some((p) => p.regel === 'R2'), JSON.stringify(ok.map((p) => p.regel)))
  }

  // ── R3, och tröskeln prövas MOT sin egen gräns ───────────────────────────
  {
    const kort = 'Går inte att ångra.'
    t('R3-sonden är svagare än tröskeln — annars mäter provet inget',
      kort.length < MIN_REASON, `sond=${kort.length} tröskel=${MIN_REASON}`)
    const r = evaluate(bas({
      deklarationer: parseDeklarationer(FIXTUR.replace(/skäl:\s*'[^']*'/u, `skäl: '${kort}'`)),
    }))
    t('R3: IRREVERSIBEL med för kort skäl på något som SKICKAR → RÖTT',
      r.some((p) => p.regel === 'R3' && p.detalj.includes('mejlare') && p.detalj.includes('skickar')),
      JSON.stringify(r.map((p) => p.detalj.slice(0, 40))))

    // MOTPROV: samma korta skäl på något som VARKEN bokför eller skickar → tyst.
    const tyst = evaluate(bas({
      deklarationer: parseDeklarationer(FIXTUR.replace(/skäl:\s*'[^']*'/u, `skäl: '${kort}'`)),
      manifest: { verktyg: {} },
      accountingOnly: new Set(['bokforare']),
    }))
    t('R3 MOTPROV: kort skäl utan bokföring och utan sändning → tyst',
      !tyst.some((p) => p.regel === 'R3'), JSON.stringify(tyst.map((p) => p.detalj.slice(0, 40))))
  }

  // ── R4 ────────────────────────────────────────────────────────────────────
  {
    const r = evaluate(bas({ läsFil: () => 'export class X { async någotHeltAnnat() {} }' }))
    t('R4: symbolen finns inte i filen → RÖTT',
      r.some((p) => p.regel === 'R4' && p.detalj.includes('raderaAnteckning')),
      JSON.stringify(r.map((p) => p.regel)))

    const saknad = evaluate(bas({ läsFil: () => null }))
    t('R4: filen finns inte → RÖTT',
      saknad.some((p) => p.regel === 'R4' && p.detalj.includes('som inte finns')),
      JSON.stringify(saknad.map((p) => p.detalj.slice(0, 30))))

    // KOD, INTE PROSA: symbolen bara i en kommentar duger inte.
    const bara_prosa = evaluate(bas({ läsFil: () => '// raderaAnteckning fanns här förr\nexport class X {}' }))
    t('R4 KOMMENTARKANARIE: symbolen bara i en KOMMENTAR → fortfarande RÖTT',
      bara_prosa.some((p) => p.regel === 'R4'), JSON.stringify(bara_prosa.map((p) => p.regel)))

    // SVENSK INITIAL: `\b` hade aldrig matchat, och utfallet vore ett FALSKT larm.
    t('R4 #668: en symbol med svensk initial hittas',
      symbolFinns(codeMask('export class X { async ångraAvi() {} }'), 'ångraAvi'))
    t('R4 #668 MOTPROV: en DELSTRÄNG matchar inte',
      !symbolFinns(codeMask('export class X { async xxångraAviyy() {} }'), 'ångraAvi'))
  }

  // ── OMFÅNGSKANARIEFÅGLARNA ───────────────────────────────────────────────
  {
    t('OMFÅNG: tom deklarationsmängd → RÖTT',
      evaluate(bas({ deklarationer: new Map() })).some((p) => p.regel === 'OMFÅNG'))
    t('OMFÅNG: tom ACTION_TOOLS → RÖTT',
      evaluate(bas({ actionTools: new Set() })).some((p) => p.regel === 'OMFÅNG'))
    t('OMFÅNG: tom ACCOUNTING_ONLY_ACTIONS → RÖTT',
      evaluate(bas({ accountingOnly: new Set() })).some((p) => p.regel === 'OMFÅNG'))
  }

  // ── DEN DELADE KÄLLSKANNERNS EGNA KANARIEFÅGLAR ──────────────────────────
  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn('\n✅ Självtest grönt — R1(a-d), R2, R3, R4 och omfångskanariefåglarna fäller alla.\n')
}

// ── main ────────────────────────────────────────────────────────────────────
const ÄR_PROGRAM = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (ÄR_PROGRAM) {
  if (process.argv.includes('--self-test')) selfTest()
  else kör()
}
