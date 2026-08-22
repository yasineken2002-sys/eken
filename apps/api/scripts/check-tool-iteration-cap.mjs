#!/usr/bin/env node
/**
 * CI-guard — turtaket ska vara ETT värde, och det ska ALDRIG kunna nås tyst.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * Taket låg som `= 3` på tre ställen. När det nåddes föll loopen ur, sista
 * textblocket skrevs ut, inget fel kastades och ingen markering gjordes. AI:n
 * kunde alltså SE UT att ha utfört en uppgift när den stannade halvvägs. I ett
 * system som rör pengar är det den värsta felmoden som finns — den ser ut som
 * framgång, så ingen letar efter den.
 *
 * De tre konstanterna hade dessutom redan glidit isär i BETYDELSE, trots samma
 * värde: SSE-loopen anropade modellen först i varvet, så den sista omgångens
 * verktygsresultat skickades aldrig till modellen. Ett tal som betyder olika
 * saker på olika vägar är inte ett gemensamt tak.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Ingen fil utanför `tool-iteration-cap.ts` får deklarera en egen
 *     turtakskonstant. En fjärde konstant är hur de tre uppstod.
 * R2  Varje fil med en verktygsloop måste läsa `MAX_TOOL_ROUNDS` ur modulen.
 * R3  PARNINGEN: en fil som DETEKTERAR taket (`reachedToolIterationCap`) måste
 *     också MARKERA det (`TOOL_ITERATION_CAP_NOTICE`) — och tvärtom. Att
 *     detektera utan att markera är exakt den tysta defekten; att markera utan
 *     att detektera är ett larm utan orsak.
 * R4  `reachedToolIterationCap` måste väga BÅDA villkoren. Mjukas den upp till
 *     enbart räknaren larmar den på ett FULLSTÄNDIGT svar som råkade bli klart
 *     på sista varvet — det vanligaste fallet av alla. Ett larm som alltid
 *     larmar läses snart inte alls. Mjukas den upp till enbart `stop_reason`
 *     larmar den innan budgeten är slut.
 * R5  Markeringen måste vara omissförstålig: den ska påstå att uppgiften INTE
 *     slutfördes och att svaret är ofullständigt, utan hedge-ord.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN. Den mäter att detektion och markering hänger
 * ihop i KODEN. Att markeringen faktiskt når fram till klienten mäts
 * beteendemässigt i `tool-iteration-cap.spec.ts` grupp 2, som kör den riktiga
 * controllern och läser de riktiga SSE-skrivningarna.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-tool-iteration-cap.mjs
 * Självtest:   node apps/api/scripts/check-tool-iteration-cap.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeImports, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const AI_DIR = join(HERE, '..', 'src', 'ai')
const CAP_FILE = join(AI_DIR, 'tool-iteration-cap.ts')

const CAP = 'MAX_TOOL_ROUNDS'
const NOTICE = 'TOOL_ITERATION_CAP_NOTICE'
const DETECT = 'reachedToolIterationCap'
const WANTS = 'wantsAnotherToolRound'

/** Filerna som HAR en verktygsloop. Uppräkningen är medveten, inte ett svep. */
export const LOOP_FILES = [
  'ai-assistant.service.ts',
  'ai-assistant.controller.ts',
  'tenant-ai.service.ts',
]

/**
 * En egen turtakskonstant: `const <NÅGOT MED ITERATION/ROUND> = <tal>`.
 *
 * FORMEN fälls, inte en uppräkning av namn. En uppräkning hade missat det
 * fjärde namnet — vilket är precis det fall guarden finns för.
 */
export function findOwnCapConstants(text) {
  const re =
    /(?:const|let|var)\s+(\w*(?:ITERATION|Iteration|ROUND|Round)\w*)\s*(?::\s*number\s*)?=\s*(\d+)/g
  return [...text.matchAll(re)].map((m) => ({
    namn: m[1],
    värde: m[2],
    line: text.slice(0, m.index).split('\n').length,
  }))
}

/**
 * Källtexten UTAN import-satser.
 *
 * ── VARFÖR DEN BEHÖVS (självtestet fällde guarden) ───────────────────────────
 *
 * R3 frågade `text.includes(NOTICE)`. Markeringen står i import-satsen, så en
 * loop som IMPORTERAR markeringen men aldrig ANVÄNDER den passerade — alltså
 * exakt den tysta defekten guarden finns för. Ett namn i en import bevisar att
 * något är tillgängligt, aldrig att det används.
 *
 * (`reachedToolIterationCap` drabbades inte: den prövas som `DETECT(` med
 * parentes, och en import har ingen. Skillnaden var slumpmässig, inte medveten —
 * därför strippas importerna för BÅDA.)
 */
export const withoutImports = (text) => removeImports(text)

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ capText, loopTexts }) {
  const problem = []

  if (!new RegExp(`export const ${CAP}\\s*=\\s*\\d+`).test(capText)) {
    problem.push({ rule: `${CAP} saknas i tool-iteration-cap.ts`, detail: 'Utan taket mäter inget nedan något.' })
  }
  if (!capText.includes(`export const ${NOTICE}`)) {
    problem.push({ rule: `${NOTICE} saknas`, detail: 'Utan markering kan taket nås tyst — hela defekten.' })
  }
  if (!capText.includes(`export function ${DETECT}`)) {
    problem.push({ rule: `${DETECT} saknas`, detail: 'Ingen delad definition av "taket nåddes".' })
  }
  if (problem.length > 0) return problem

  // R4 — predikatet måste väga BÅDA villkoren.
  const kropp = capText.slice(capText.indexOf(`export function ${DETECT}`))
  const slut = kropp.indexOf('\n}')
  const predikat = kropp.slice(0, slut === -1 ? kropp.length : slut)
  if (!predikat.includes(WANTS)) {
    problem.push({
      rule: `${DETECT} väger inte in ${WANTS}`,
      detail:
        'Grindas taket enbart på räknaren larmar det på ett FULLSTÄNDIGT svar som ' +
        'blev klart på sista varvet — det vanligaste fallet. Ett larm som alltid ' +
        'larmar läses snart inte alls.',
    })
  }
  if (!predikat.includes(CAP)) {
    problem.push({
      rule: `${DETECT} väger inte in ${CAP}`,
      detail:
        'Grindas taket enbart på stop_reason larmar det så snart modellen vill ha ' +
        'ett verktyg till, alltså långt innan budgeten är slut.',
    })
  }

  // R5 — markeringen måste vara omissförstålig.
  const notisRad = capText.slice(capText.indexOf(`export const ${NOTICE}`))
  const brytIdx = notisRad.indexOf('\n\n')
  const notis = notisRad.slice(0, brytIdx === -1 ? 600 : brytIdx)
  for (const krav of ['slutfördes inte', 'ofullständigt']) {
    if (!notis.includes(krav)) {
      problem.push({
        rule: `markeringen saknar "${krav}"`,
        detail:
          'Den ska inte gå att läsa som ett vanligt svar. Utan ett uttryckligt ' +
          'påstående om att uppgiften inte slutfördes glider den ihop med prosan.',
      })
    }
  }
  for (const hedge of ['kanske', 'möjligen', 'eventuellt']) {
    if (notis.toLowerCase().includes(hedge)) {
      problem.push({
        rule: `markeringen är uppmjukad med "${hedge}"`,
        detail: 'Ett avbrutet arbete är ett faktum, inte en möjlighet.',
      })
    }
  }

  if (loopTexts.length === 0) {
    problem.push({
      rule: 'NOLL loopfiler lästes',
      detail: 'Skanningen har gått blind — en guard utan mätobjekt mäter ingenting.',
    })
    return problem
  }

  for (const { fil, text } of loopTexts) {
    for (const k of findOwnCapConstants(text)) {
      problem.push({
        fil,
        line: k.line,
        rule: `egen turtakskonstant \`${k.namn} = ${k.värde}\``,
        detail:
          'Taket bor i tool-iteration-cap.ts. Tre spridda konstanter var utgångsläget, ' +
          'och de hade redan glidit isär i BETYDELSE trots samma värde.',
      })
    }
    if (!text.includes("from './tool-iteration-cap'")) {
      problem.push({
        fil,
        rule: 'importerar inte tool-iteration-cap',
        detail: 'Filen har en verktygsloop men läser inte det delade taket.',
      })
      continue
    }
    if (!text.includes(CAP)) {
      problem.push({ fil, rule: `använder inte ${CAP}`, detail: 'Loopen grindas på något annat.' })
    }
    // Importerna strippas: ett namn i en import bevisar tillgänglighet, aldrig
    // ANVÄNDNING. Se withoutImports() — självtestet fällde guarden på just det.
    const kropp = withoutImports(text)
    const detekterar = kropp.includes(`${DETECT}(`)
    const markerar = kropp.includes(NOTICE)
    if (detekterar && !markerar) {
      problem.push({
        fil,
        rule: 'DETEKTERAR taket men MARKERAR det inte',
        detail:
          'Exakt den tysta defekten: loopen vet att arbetet avbröts och säger det ' +
          `inte. Lägg till ${NOTICE} i svaret.`,
      })
    }
    if (markerar && !detekterar) {
      problem.push({
        fil,
        rule: 'MARKERAR taket men DETEKTERAR det inte',
        detail: `Ett larm utan orsak. Markeringen måste grindas på ${DETECT}().`,
      })
    }
    if (!detekterar && !markerar) {
      problem.push({
        fil,
        rule: 'varken detekterar eller markerar turtaket',
        detail: 'Loopen kan nå taket tyst — svaret ser då fullständigt ut fast det inte är det.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const CAP_OK = `
export const ${CAP} = 3
export const ${NOTICE} = '⚠️ Uppgiften slutfördes inte. Svaret är ofullständigt.'
export function ${WANTS}(s) { return s === 'tool_use' }
export function ${DETECT}(s, n) {
  return ${WANTS}(s) && n >= ${CAP}
}
`
const LOOP_OK = [
  {
    fil: 'a.ts',
    text: `import { ${CAP}, ${DETECT}, ${NOTICE} } from './tool-iteration-cap'
while (x && i < ${CAP}) { i++ }
const c = ${DETECT}(r.stop_reason, i)
const reply = c ? text + ${NOTICE} : text`,
  },
]

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

  const sonder = [
    'const MAX_TOOL_ITERATIONS = 3',
    'const STREAM_MAX_TOOL_ITERATIONS = 3',
    'const TENANT_MAX_TOOL_ITERATIONS = 3',
    'const NAGOT_HELT_NYTT_ROUNDS = 7',
  ]
  const hittade = sonder.filter((s) => findOwnCapConstants(s).length === 1)
  if (hittade.length !== sonder.length) {
    fail(`kanariefågel: konstantskanningen såg ${hittade.length}/${sonder.length} kända former`)
  } else console.log(`✅ kanariefågel: konstantskanningen fäller alla ${sonder.length} formerna`)
  if (findOwnCapConstants('const MAX_TOKENS = 4096').length !== 0) {
    fail('kanariefågel: konstantskanningen fäller ett orelaterat tal (falsklarm)')
  } else console.log('✅ kanariefågel: orelaterade konstanter fälls inte')

  const riktiga = LOOP_FILES.map((f) => ({ fil: f, text: readFileSync(join(AI_DIR, f), 'utf8') }))
  const medLoop = riktiga.filter((r) => r.text.includes(CAP))
  if (medLoop.length !== LOOP_FILES.length) {
    fail(`kanariefågel: bara ${medLoop.length}/${LOOP_FILES.length} riktiga loopfiler använder ${CAP}`)
  } else console.log(`✅ kanariefågel: alla ${LOOP_FILES.length} riktiga loopfiler läser det delade taket`)

  grön('paritet', evaluate({ capText: CAP_OK, loopTexts: LOOP_OK }))

  röd(
    'loopen detekterar taket men markerar det inte (den tysta defekten)',
    evaluate({
      capText: CAP_OK,
      loopTexts: [{ fil: 'a.ts', text: LOOP_OK[0].text.replace(`text + ${NOTICE}`, 'text') }],
    }),
    'MARKERAR det inte',
  )
  röd(
    'loopen markerar utan att detektera (larm utan orsak)',
    evaluate({
      capText: CAP_OK,
      loopTexts: [
        {
          fil: 'a.ts',
          text: `import { ${CAP}, ${NOTICE} } from './tool-iteration-cap'\nwhile (i < ${CAP}) {}\nconst r = t + ${NOTICE}`,
        },
      ],
    }),
    'DETEKTERAR det inte',
  )
  röd(
    'loopen varken detekterar eller markerar',
    evaluate({
      capText: CAP_OK,
      loopTexts: [
        { fil: 'a.ts', text: `import { ${CAP} } from './tool-iteration-cap'\nwhile (i < ${CAP}) {}` },
      ],
    }),
    'varken detekterar eller markerar',
  )
  röd(
    'en fjärde egen turtakskonstant införs',
    evaluate({
      capText: CAP_OK,
      loopTexts: [{ fil: 'a.ts', text: LOOP_OK[0].text + '\nconst NYTT_MAX_TOOL_ITERATIONS = 5' }],
    }),
    'egen turtakskonstant',
  )
  röd(
    'predikatet grindar ENBART på räknaren (larmar på ett fullständigt svar)',
    evaluate({
      capText: CAP_OK.replace(`return ${WANTS}(s) && n >= ${CAP}`, `return n >= ${CAP}`),
      loopTexts: LOOP_OK,
    }),
    `väger inte in ${WANTS}`,
  )
  röd(
    'predikatet grindar ENBART på stop_reason (larmar innan budgeten är slut)',
    evaluate({
      capText: CAP_OK.replace(`return ${WANTS}(s) && n >= ${CAP}`, `return ${WANTS}(s)`),
      loopTexts: LOOP_OK,
    }),
    `väger inte in ${CAP}`,
  )
  röd(
    'markeringen mjukas upp med ett hedge-ord',
    evaluate({ capText: CAP_OK.replace('slutfördes inte', 'slutfördes kanske inte'), loopTexts: LOOP_OK }),
    'uppmjukad',
  )
  röd(
    'markeringen slutar påstå att svaret är ofullständigt',
    evaluate({ capText: CAP_OK.replace('Svaret är ofullständigt.', 'Hör av dig igen.'), loopTexts: LOOP_OK }),
    'ofullständigt',
  )
  röd(
    'loopfil utan import av det delade taket',
    evaluate({ capText: CAP_OK, loopTexts: [{ fil: 'a.ts', text: 'while (i < 3) {}' }] }),
    'importerar inte',
  )
  röd('inga loopfiler alls (blind skanning)', evaluate({ capText: CAP_OK, loopTexts: [] }), 'NOLL loopfiler')
  röd(
    'markeringen borttagen ur modulen',
    evaluate({ capText: CAP_OK.replace(`export const ${NOTICE}`, 'const annat'), loopTexts: LOOP_OK }),
    `${NOTICE} saknas`,
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

function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const problem = evaluate({
    capText: readFileSync(CAP_FILE, 'utf8'),
    loopTexts: LOOP_FILES.map((f) => ({ fil: f, text: readFileSync(join(AI_DIR, f), 'utf8') })),
  })

  if (problem.length > 0) {
    console.error('\n=== TURTAKET KAN NÅS TYST, ELLER HAR DELATS IGEN (CI-guard) ===\n')
    for (const p of problem) {
      const var_ = p.fil ? `src/ai/${p.fil}${p.line ? `:${p.line}` : ''}` : 'src/ai/tool-iteration-cap.ts'
      console.error(`❌ ${var_}\n   ${p.rule}\n   ${p.detail}`)
    }
    console.error(
      '\nRegeln: ett avbrutet arbete får ALDRIG se ut som ett färdigt svar, och taket\n' +
        'ska vara ETT värde. Se apps/api/src/ai/tool-iteration-cap.ts.\n',
    )
    process.exit(1)
  }

  console.log(
    `✅ turtaket är ett värde (${CAP}), delat av ${LOOP_FILES.length} loopar — ` +
      'och kan inte nås utan markering.',
  )
}

main()
