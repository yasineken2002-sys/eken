#!/usr/bin/env node
/**
 * CI-guard — varje AI-verktygskörning ska gå att spåra till sitt UTFALL.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * `AiToolExecution` lagrade vad AI:n FÖRSÖKTE, aldrig vad den ORSAKADE. Ingen
 * kunde svara på "vad gjorde AI:n i tisdags, och hur tar jag tillbaka det". För
 * en assistent går det an; för ett agentiskt bygge är det diskvalificerande — en
 * åtgärd som inte går att spåra till sitt utfall går heller inte att granska,
 * verifiera eller backa.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * MEKANISMEN (R1–R4) — kopplingen ska produceras av skrivvägen, inte av att
 * varje verktygsförfattare kommer ihåg den. En konvention som ska följas är en
 * VANA; det här gör den till en invariant.
 *
 *   R1  Extensionen finns och är PÅKOPPLAD på PrismaService — och returvärdet
 *       från `$extends` tas till vara. `this.$extends(x)` utan tilldelning
 *       kompilerar, kör och gör ingenting.
 *   R2  `executeTool` omsluter HELA kroppen med `runWithEffectCollector`.
 *       Låg den bara runt verktygskörningen anropades `drainEffects()` utanför
 *       AsyncLocalStorage-scopet och gav alltid tom lista. (Uppmätt defekt.)
 *   R3  Effekterna når auditskrivningen i BÅDA grenarna — även vid FEL. Ett
 *       verktyg som hann skapa två rader innan det kastade har orsakat två rader.
 *   R4  Extensionen undantar revisionstabellerna (annars bokför den sig själv).
 *
 * ROSTRET (R5–R6) — den tvingande frågan.
 *
 *   R5  `EFFECT_PRODUCING_TOOLS` ∪ `effectFree` måste vara EXAKT lika med
 *       `ACTION_TOOLS`. Ett trettionde verktyg står i ingendera → rött.
 *   R6  Kvitteringsfilen fäller ÅT BÅDA HÅLL: en kvittering vars verktyg inte
 *       längre finns i ACTION_TOOLS är rött, och varje skäl måste vara minst
 *       30 tecken. Ett verktyg får inte stå i BÅDA listorna.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN. Den mäter att mekanismen är intakt och att
 * rostret är fullständigt — inte att varje enskilt verktyg empiriskt skriver
 * något. Att mekanismen faktiskt bokför rätt rad mäts mot en RIKTIG databas i
 * `ai-effect-extension.spec.ts`, som är där defekten i R2 hittades.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-ai-tool-effects.mjs
 * Självtest:   node apps/api/scripts/check-ai-tool-effects.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const DEF_FILE = join(SRC, 'ai', 'tools', 'ai-tools.definition.ts')
const EXEC_FILE = join(SRC, 'ai', 'tools', 'tool-executor.service.ts')
const PRISMA_FILE = join(SRC, 'common', 'prisma', 'prisma.service.ts')
const EXT_FILE = join(SRC, 'common', 'prisma', 'ai-effect-extension.ts')
const ACK_FILE = join(HERE, 'ai-tool-effects.ack.json')

const MIN_SKAL = 30

/**
 * Källtext utan kommentarer.
 *
 * ── VARFÖR (guarden fällde sig själv på det här) ─────────────────────────────
 *
 * R2 frågade om `executeTool`s kropp innehåller `drainEffects(`. Metodens EGEN
 * doc-kommentar förklarar defekten och nämner därför namnet i prosa — guarden
 * fällde alltså korrekt kod på grund av en kommentar om felaktig kod.
 *
 * Samma familj som när en annan guard räknade ett namn i en IMPORT som
 * användning: ett omnämnande är inte en anrop. Kod ska prövas mot kod.
 */
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
export { withoutComments }

/**
 * `executeTool`s kropp — fram till nästa metod på samma indentnivå.
 *
 * Behövs för att skilja VAR kollektorn öppnas, inte bara ATT den nämns. Se R2.
 */
export function executeToolBody(text) {
  const i = text.indexOf('async executeTool(')
  if (i === -1) return null
  const efter = text.slice(i + 10)
  const nästa = efter.search(/\n  (?:private |public )?(?:async )?\w+\s*\(/)
  return nästa === -1 ? efter : efter.slice(0, nästa)
}

/** Läs `export const X = new Set([...])`. */
export function parseSet(text, name) {
  const m = new RegExp(`export const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(text)
  if (!m) return null
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ defText, execText, prismaText, extText, ack }) {
  const problem = []

  // ── R1 — extensionen finns OCH är påkopplad, med returvärdet taget ────────
  if (!extText.includes('export const aiEffectExtension')) {
    problem.push({ rule: 'aiEffectExtension saknas', detail: 'Mekanismen finns inte.' })
  }
  if (!prismaText.includes('aiEffectExtension')) {
    problem.push({
      rule: 'PrismaService kopplar inte på aiEffectExtension',
      detail: 'Utan påkoppling bokförs ingenting, och varje test mot en attrapp är ändå grönt.',
    })
  } else if (!/return\s+this\.\$extends\(|=\s*this\.\$extends\(/.test(prismaText)) {
    problem.push({
      rule: '$extends-resultatet tas inte till vara',
      detail:
        '`$extends` returnerar en NY klient i stället för att mutera. Ett anrop vars ' +
        'returvärde kastas kompilerar, kör och gör INGENTING.',
    })
  }
  // R4 — revisionstabellerna undantas.
  for (const tabell of ['AiToolExecution', 'AiToolEffect']) {
    if (!extText.includes(`'${tabell}'`)) {
      problem.push({
        rule: `extensionen undantar inte ${tabell}`,
        detail: 'Utan undantaget bokför revisionsspåret sig självt — cirkulärt och oändligt brus.',
      })
    }
  }

  // ── R2 — kollektorn omsluter hela kroppen ────────────────────────────────
  if (!execText.includes('runWithEffectCollector')) {
    problem.push({
      rule: 'executeTool öppnar ingen effektkollektor',
      detail: 'Ingen körning bokförs. Kopplingen är bortkopplad vid källan.',
    })
  } else {
    // ── FORMEN, INTE FÖREKOMSTEN ──────────────────────────────────────────
    //
    // Att `runWithEffectCollector` NÄMNS i filen räcker inte: den defekta formen
    // nämner den också, bara runt fel sak. Det som skiljer dem är att `executeTool`
    // i den KORREKTA formen inte gör något annat än att öppna kollektorn och
    // delegera — dränerandet sker i den inre metoden, alltså inne i scopet.
    //
    // Låg drainEffects() i SAMMA kropp som ett icke-returnerat collector-anrop
    // vore den uppmätta defekten: tömningen körs efter att scopet lämnats, store
    // är undefined, och listan är alltid tom.
    const kropp = executeToolBody(withoutComments(execText))
    if (kropp === null) {
      problem.push({ rule: 'executeTool hittades inte', detail: 'Skanningen har gått blind.' })
    } else {
      if (!/return\s+runWithEffectCollector\(/.test(kropp)) {
        problem.push({
          rule: 'executeTool RETURNERAR inte runWithEffectCollector(...)',
          detail:
            'Kollektorn måste omsluta HELA kroppen. Ligger den bara runt verktygskörningen ' +
            'anropas `drainEffects()` utanför AsyncLocalStorage-scopet och ger alltid tom lista.',
        })
      }
      if (kropp.includes('drainEffects(')) {
        problem.push({
          rule: 'drainEffects() ligger i samma kropp som kollektoröppningen',
          detail:
            'Då körs tömningen efter att scopet lämnats. Den hör hemma i den inre ' +
            'metoden, som körs INNE i kollektorn.',
        })
      }
    }
  }

  // ── R3 — effekterna når BÅDA auditgrenarna ───────────────────────────────
  const antalDrain = (execText.match(/effects:\s*drainEffects\(\)/g) ?? []).length
  const antalLogg = (execText.match(/this\.audit\.logToolExecution\(/g) ?? []).length
  if (antalLogg === 0) {
    problem.push({ rule: 'logToolExecution anropas aldrig', detail: 'Skanningen har gått blind.' })
  } else if (antalDrain < antalLogg) {
    problem.push({
      rule: `${antalDrain} av ${antalLogg} auditskrivningar bär effekterna`,
      detail:
        'BÅDA grenarna måste göra det — även felgrenen. Ett verktyg som hann skapa två ' +
        'rader innan det kastade har orsakat två rader, och just de fallen är svårast ' +
        'att städa utan spår.',
    })
  }

  // ── R5 + R6 — rostret och kvitteringarna ─────────────────────────────────
  const action = parseSet(defText, 'ACTION_TOOLS')
  const producing = parseSet(defText, 'EFFECT_PRODUCING_TOOLS')
  if (!action || action.length === 0) {
    problem.push({ rule: 'ACTION_TOOLS saknas eller är tom', detail: 'Utan mätobjekt mäter R5 ingenting.' })
    return problem
  }
  if (!producing) {
    problem.push({ rule: 'EFFECT_PRODUCING_TOOLS saknas', detail: 'Den tvingande frågan finns inte.' })
    return problem
  }
  const fria = Object.keys(ack.effectFree ?? {})

  for (const t of action) {
    const iRoster = producing.includes(t)
    const iAck = fria.includes(t)
    if (!iRoster && !iAck) {
      problem.push({
        rule: `ACTION_TOOL \`${t}\` saknar ställningstagande`,
        detail:
          'Lägg det i EFFECT_PRODUCING_TOOLS (det skapar/ändrar något — mekanismen ger ' +
          'kopplingen automatiskt) eller kvittera det i ai-tool-effects.ack.json med skäl.',
      })
    }
    if (iRoster && iAck) {
      problem.push({
        rule: `\`${t}\` står i BÅDA listorna`,
        detail: 'Ett verktyg producerar effekter eller gör det inte. Båda kan inte vara sant.',
      })
    }
  }
  // ÅT ANDRA HÅLLET.
  for (const t of producing) {
    if (!action.includes(t)) {
      problem.push({
        rule: `EFFECT_PRODUCING_TOOLS listar \`${t}\`, som inte är ett ACTION_TOOL`,
        detail: 'Rostret har blivit stale — verktyget är borttaget eller omdöpt.',
      })
    }
  }
  for (const t of fria) {
    if (!action.includes(t)) {
      problem.push({
        rule: `kvittering för \`${t}\`, som inte är ett ACTION_TOOL`,
        detail:
          'Kvitteringen motsvarar inget verktyg längre. En lista som överlever sin egen ' +
          'sanning slutar vara en kontroll och blir en ursäkt.',
      })
    }
    const skal = String(ack.effectFree[t] ?? '')
    if (skal.trim().length < MIN_SKAL) {
      problem.push({
        rule: `kvitteringen för \`${t}\` har för kort skäl (${skal.trim().length} < ${MIN_SKAL})`,
        detail: 'Ett skäl som inte går att pröva är ingen kvittering.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const DEF_OK = `
export const ACTION_TOOLS = new Set(['a_tool', 'b_tool'])
export const EFFECT_PRODUCING_TOOLS = new Set(['a_tool', 'b_tool'])
`
const EXEC_OK = `
  async executeTool(x) {
    return runWithEffectCollector(() => this.executeToolWithAudit(x))
  }
  private async executeToolWithAudit(x) {
    try {
      result = await runAsAi(id, () => this.executeToolUnsafe(x))
    } catch (e) {
      void this.audit.logToolExecution({ effects: drainEffects() })
      throw e
    }
    void this.audit.logToolExecution({ effects: drainEffects() })
    return result
  }
`
const PRISMA_OK = `return this.$extends(aiEffectExtension) as unknown as this`
const EXT_OK = `export const aiEffectExtension = {}
const SJALVA_SPARET = new Set(['AiToolExecution', 'AiToolEffect'])`
const ACK_OK = { effectFree: {} }

function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.length === 0 ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r[0].rule}`)
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }
  const bas = { defText: DEF_OK, execText: EXEC_OK, prismaText: PRISMA_OK, extText: EXT_OK, ack: ACK_OK }

  // ── KANARIEFÅGEL 1: set-läsningen måste ge utslag på känd indata ──────────
  const a = parseSet(DEF_OK, 'ACTION_TOOLS')
  const p = parseSet(DEF_OK, 'EFFECT_PRODUCING_TOOLS')
  if (!a || a.length !== 2 || !p || p.length !== 2) {
    fail(`kanariefågel: set-läsningen gav ${JSON.stringify(a)} / ${JSON.stringify(p)}, väntade två + två`)
  } else console.log('✅ kanariefågel: set-läsningen hittar båda listorna i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ───────────────────────────────
  const riktigDef = readFileSync(DEF_FILE, 'utf8')
  const rAction = parseSet(riktigDef, 'ACTION_TOOLS')
  const rProd = parseSet(riktigDef, 'EFFECT_PRODUCING_TOOLS')
  if (!rAction || rAction.length === 0) fail('kanariefågel: NOLL ACTION_TOOLS i den riktiga källan')
  else if (!rProd || rProd.length === 0) fail('kanariefågel: NOLL EFFECT_PRODUCING_TOOLS i den riktiga källan')
  else console.log(`✅ kanariefågel: ${rAction.length} ACTION_TOOLS och ${rProd.length} i rostret, riktig källa`)

  grön('paritet', evaluate(bas))

  // ── R5 — ETT NYTT VERKTYG UTAN STÄLLNINGSTAGANDE (guardens kärna) ────────
  röd(
    'nytt ACTION_TOOL som varken står i rostret eller är kvitterat',
    evaluate({ ...bas, defText: DEF_OK.replace("'a_tool', 'b_tool'])\n", "'a_tool', 'b_tool', 'c_tool'])\n") }),
    'saknar ställningstagande',
  )

  // ── R6 — KVITTERING UTAN MOTSVARIGHET, båda hållen ───────────────────────
  röd(
    'kvittering för ett verktyg som inte finns',
    evaluate({ ...bas, ack: { effectFree: { borttaget_verktyg: 'Skickar bara ett mejl och rör ingen entitet alls.' } } }),
    'som inte är ett ACTION_TOOL',
  )
  röd(
    'rostret listar ett verktyg som inte finns',
    evaluate({ ...bas, defText: DEF_OK.replace("EFFECT_PRODUCING_TOOLS = new Set(['a_tool', 'b_tool'])", "EFFECT_PRODUCING_TOOLS = new Set(['a_tool', 'b_tool', 'spoke'])") }),
    'som inte är ett ACTION_TOOL',
  )
  röd(
    'kvittering med för kort skäl',
    evaluate({
      ...bas,
      defText: DEF_OK.replace("EFFECT_PRODUCING_TOOLS = new Set(['a_tool', 'b_tool'])", "EFFECT_PRODUCING_TOOLS = new Set(['a_tool'])"),
      ack: { effectFree: { b_tool: 'behövs inte' } },
    }),
    'för kort skäl',
  )
  röd(
    'verktyg i BÅDA listorna',
    evaluate({ ...bas, ack: { effectFree: { a_tool: 'Ett tillräckligt långt skäl som ändå är fel här.' } } }),
    'står i BÅDA listorna',
  )
  grön(
    'kvitterat verktyg med giltigt skäl utanför rostret',
    evaluate({
      ...bas,
      defText: DEF_OK.replace("EFFECT_PRODUCING_TOOLS = new Set(['a_tool', 'b_tool'])", "EFFECT_PRODUCING_TOOLS = new Set(['a_tool'])"),
      ack: { effectFree: { b_tool: 'Skickar bara ett mejl via kön och rör ingen entitet alls.' } },
    }),
  )

  // ── R1 — mekanismen bortkopplad ──────────────────────────────────────────
  röd('extensionen inte påkopplad', evaluate({ ...bas, prismaText: 'class PrismaService {}' }), 'kopplar inte på')
  röd(
    '$extends-resultatet kastas bort (kompilerar, kör, gör ingenting)',
    evaluate({ ...bas, prismaText: 'this.$extends(aiEffectExtension)' }),
    'tas inte till vara',
  )
  röd('extensionen saknas helt', evaluate({ ...bas, extText: 'const annat = {}' }), 'aiEffectExtension saknas')
  röd(
    'revisionstabellerna undantas inte (cirkularitet)',
    evaluate({ ...bas, extText: "export const aiEffectExtension = {}\nconst S = new Set(['AiToolExecution'])" }),
    'undantar inte AiToolEffect',
  )

  // ── R2 — kollektorn på fel plats (den UPPMÄTTA defekten) ─────────────────
  röd(
    'kollektorn ligger runt verktygskörningen i stället för hela kroppen',
    evaluate({
      ...bas,
      execText: `
  async executeTool(x) {
    const result = await runWithEffectCollector(() => runAsAi(id, () => this.executeToolUnsafe(x)))
    void this.audit.logToolExecution({ effects: drainEffects() })
    return result
  }
  private async annat(x) {
    void this.audit.logToolExecution({ effects: drainEffects() })
  }`,
    }),
    'RETURNERAR inte runWithEffectCollector',
  )
  röd(
    'ingen kollektor alls',
    evaluate({ ...bas, execText: EXEC_OK.replace(/runWithEffectCollector/g, 'nagotAnnat') }),
    'öppnar ingen effektkollektor',
  )

  // ── R3 — bara en gren bär effekterna ─────────────────────────────────────
  röd(
    'felgrenen tappar effekterna',
    evaluate({
      ...bas,
      execText: EXEC_OK.replace('void this.audit.logToolExecution({ effects: drainEffects() })\n      throw e', 'void this.audit.logToolExecution({})\n      throw e'),
    }),
    'auditskrivningar bär effekterna',
  )


  // Den DELADE skannerns kanariefåglar. Går scripts/lib/source-scan.mjs sönder
  // blir DEN HÄR vakten röd — inte bara skannerns egen körning. Det är hela
  // poängen med en delad mekanism: bryts den blir varje konsument röd (#463).
  for (const f of kanariefåglar()) {
    ok = false
    console.error(`❌ delad källskanner: ${f}`)
  }

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const problem = evaluate({
    defText: readFileSync(DEF_FILE, 'utf8'),
    execText: readFileSync(EXEC_FILE, 'utf8'),
    prismaText: readFileSync(PRISMA_FILE, 'utf8'),
    extText: readFileSync(EXT_FILE, 'utf8'),
    ack: JSON.parse(readFileSync(ACK_FILE, 'utf8')),
  })

  if (problem.length > 0) {
    console.error('\n=== UTFALLSKOPPLINGEN BRUTEN ELLER OSTÄLLD (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: en åtgärd som inte går att spåra till sitt utfall går heller inte att\n' +
        'granska, verifiera eller backa. Se apps/api/src/common/ai-effects/ai-effects.context.ts.\n',
    )
    process.exit(1)
  }

  const def = readFileSync(DEF_FILE, 'utf8')
  const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
  console.log(
    `✅ utfallskopplingen är påkopplad; ${parseSet(def, 'ACTION_TOOLS').length} ACTION_TOOLS ` +
      `ställningstagna (${parseSet(def, 'EFFECT_PRODUCING_TOOLS').length} producerar effekter, ` +
      `${Object.keys(ack.effectFree ?? {}).length} kvitterade).`,
  )
}

main()
