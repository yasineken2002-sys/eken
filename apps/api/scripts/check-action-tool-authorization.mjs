#!/usr/bin/env node
/**
 * CI-guard — ett BINDANDE verktyg får aldrig kunna utföras utan bevis.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * `create_invoice`, `create_journal_entry`, `mark_invoice_paid` rör pengar. Att
 * de inte kan utföras utan en människas bekräftelse vilade på att TRE loopar var
 * för sig kom ihåg att kolla `actionBlock` innan de anropade `executeTool`:
 *
 *   ai-assistant.service.ts    ai-assistant.controller.ts    tenant-ai.service.ts
 *
 * Tre kopior av samma kontroll är en VANA. En fjärde anropsväg — och ett
 * agentiskt bygge är precis en sådan — når `executeTool` direkt, och då står
 * ingenting mellan modellen och en verifikationspost.
 *
 * Invarianten bor nu i `assertActionToolAuthorized`, som BÅDA exekverarna måste
 * anropa först av allt. Guarden håller den där.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Grindmodulen finns, och `assertActionToolAuthorized` prövar FAKTISKT
 *     beviset (`claimed`) — inte bara verktygsnamnet.
 * R2  VARJE exekverare med ett `executeTool` anropar grinden. En ny exekverare
 *     som inte gör det är en ny väg förbi människans bekräftelse.
 * R3  Grinden anropas FÖRST i metoden — före körningen, före kollektorn. En
 *     kontroll som ligger efter sidoeffekterna kontrollerar ingenting.
 * R4  Grinden släpper igenom LÄSVERKTYG. En spärr som fäller allt är en spärr
 *     mot riktigt arbete, och skulle sannolikt mjukas upp bort igen.
 * R5  Beviset produceras BARA av de atomära anspråksvägarna. En `claimed: true`
 *     skriven för hand någon annanstans är ett kringgående i förklädnad.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN. Den mäter att grinden finns, anropas, ligger
 * först och inte fäller läsverktyg. Att anspråket faktiskt är atomiskt — att två
 * samtidiga bekräftelser ger exakt EN vinnare — är en egenskap hos databasen och
 * mäts i `action-idempotency.spec.ts` mot riktig Postgres.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-action-tool-authorization.mjs
 * Självtest:   node apps/api/scripts/check-action-tool-authorization.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, '..', 'src', 'ai', 'tools')
const GATE_FILE = join(TOOLS, 'action-authorization.ts')

const GATE = 'assertActionToolAuthorized'
const PROOF = 'claimed'

/** Exekverarna. Uppräkningen är medveten — R2 kräver att BÅDA anropar grinden. */
export const EXECUTORS = ['tool-executor.service.ts', 'tenant-tool-executor.service.ts']

/** Källtext utan kommentarer. Ett omnämnande i prosa är inte ett anrop. */
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
export { withoutComments }

/** Kroppen för `async executeTool(` fram till nästa metod på samma nivå. */
export function executeToolBody(text) {
  const i = text.indexOf('async executeTool(')
  if (i === -1) return null
  const efter = text.slice(i + 10)
  const nästa = efter.search(/\n  (?:private |public )?(?:async )?\w+\s*\(/)
  return nästa === -1 ? efter : efter.slice(0, nästa)
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ gateText, executors, otherFiles = [] }) {
  const problem = []

  // ── R1 — grinden finns och prövar beviset ─────────────────────────────────
  if (!gateText.includes(`export function ${GATE}`)) {
    problem.push({ rule: `${GATE} saknas`, detail: 'Invarianten finns inte.' })
    return problem
  }
  const kropp = gateText.slice(gateText.indexOf(`export function ${GATE}`))
  const slut = kropp.indexOf('\n}')
  const grindkropp = withoutComments(slut === -1 ? kropp : kropp.slice(0, slut))
  if (!grindkropp.includes(PROOF)) {
    problem.push({
      rule: `${GATE} prövar inte beviset (\`${PROOF}\`)`,
      detail:
        'Grinden avgör då på något annat än om en bekräftelse faktiskt konsumerats — ' +
        'och en kontroll som inte läser beviset är dekoration.',
    })
  }
  // R4 — läsverktyg måste släppas igenom.
  if (!/if\s*\(!\s*isActionTool\(/.test(grindkropp)) {
    problem.push({
      rule: `${GATE} släpper inte igenom läsverktyg`,
      detail:
        'En spärr som fäller ALLA verktyg är en spärr mot riktigt arbete. Den skulle ' +
        'mjukas upp bort igen, och då är den borta även för de bindande.',
    })
  }

  // ── R2 + R3 — varje exekverare anropar grinden, och gör det FÖRST ─────────
  if (executors.length === 0) {
    problem.push({ rule: 'NOLL exekverare lästes', detail: 'Skanningen har gått blind.' })
    return problem
  }
  for (const { fil, text } of executors) {
    const ren = withoutComments(text)
    if (!ren.includes(`${GATE}(`)) {
      problem.push({
        fil,
        rule: 'exekveraren anropar inte grinden',
        detail:
          'En väg där ett bindande verktyg kan utföras utan människans bekräftelse. ' +
          `Anropa ${GATE}(toolName, auditContext?.actionProof) först i executeTool.`,
      })
      continue
    }
    const body = executeToolBody(ren)
    if (body === null) {
      problem.push({ fil, rule: 'executeTool hittades inte', detail: 'Skanningen har gått blind.' })
      continue
    }
    if (!body.includes(`${GATE}(`)) {
      problem.push({
        fil,
        rule: 'grinden anropas utanför executeTool',
        detail:
          'Den måste ligga i den metod ALLA vägar går genom. Ligger den i en hjälpare ' +
          'kan en ny anropare nå executeTool utan att passera den.',
      })
      continue
    }
    // R3 — FÖRST. Inget sidoeffektsanrop får ligga före grinden.
    const iGate = body.indexOf(`${GATE}(`)
    for (const före of ['executeToolUnsafe(', 'runWithEffectCollector(', 'logToolExecution(']) {
      const i = body.indexOf(före)
      if (i !== -1 && i < iGate) {
        problem.push({
          fil,
          rule: `\`${före.replace('(', '')}\` ligger FÖRE grinden`,
          detail:
            'En kontroll efter sidoeffekterna kontrollerar ingenting. Grinden ska vara ' +
            'det första som händer i executeTool.',
        })
      }
    }
  }

  // ── R5 — beviset produceras bara av anspråksvägarna ───────────────────────
  for (const { fil, text } of otherFiles) {
    const ren = withoutComments(text)
    if (!/\bclaimed:\s*true\b/.test(ren)) continue
    // Måste ligga i samma fil som ett atomärt anspråk (`updateMany` + count).
    if (!/updateMany\(/.test(ren) || !/count\s*[!=]==?\s*1/.test(ren)) {
      problem.push({
        fil,
        rule: 'skapar ett bevis (`claimed: true`) utan ett atomärt anspråk',
        detail:
          'Beviset ska bara kunna uppstå ur ett lyckat engångsanspråk (updateMany på ' +
          'en icke-konsumerad rad, count === 1). En handskriven flagga är ett ' +
          'kringgående i förklädnad.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const GATE_OK = `
export function isActionTool(n) { return true }
export function ${GATE}(toolName, proof) {
  if (!isActionTool(toolName)) return
  if (proof?.${PROOF} === true) return
  throw new ForbiddenException('nej')
}
`
const EXEC_OK = [
  {
    fil: 'tool-executor.service.ts',
    text: `
  async executeTool(a, b, c) {
    ${GATE}(toolName, auditContext?.actionProof)
    return runWithEffectCollector(() => this.executeToolWithAudit(a))
  }
  private async executeToolWithAudit(a) {
    const r = await this.executeToolUnsafe(a)
    void this.audit.logToolExecution({})
  }`,
  },
  {
    fil: 'tenant-tool-executor.service.ts',
    text: `
  async executeTool(a) {
    ${GATE}(toolName, auditContext?.actionProof)
    const r = await this.executeToolUnsafe(a)
  }`,
  },
]
const OTHER_OK = [
  {
    fil: 'ai-assistant.service.ts',
    text: `const claim = await this.prisma.x.updateMany({}); if (claim.count !== 1) return
    return { status: 'claimed', proof: { claimed: true } }`,
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
  const bas = { gateText: GATE_OK, executors: EXEC_OK, otherFiles: OTHER_OK }

  // ── KANARIEFÅGEL 1: kroppsläsningen måste ge utslag ──────────────────────
  const b = executeToolBody(EXEC_OK[0].text)
  if (!b || !b.includes(GATE) || b.includes('executeToolWithAudit(a) {')) {
    fail(`kanariefågel: kroppsläsningen gav ${JSON.stringify(b)?.slice(0, 80)}`)
  } else console.log('✅ kanariefågel: kroppsläsningen avgränsar executeTool i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ──────────────────────────────
  const riktiga = EXECUTORS.map((f) => ({ fil: f, text: readFileSync(join(TOOLS, f), 'utf8') }))
  const medGrind = riktiga.filter((r) => withoutComments(r.text).includes(`${GATE}(`))
  if (medGrind.length !== EXECUTORS.length) {
    fail(`kanariefågel: bara ${medGrind.length}/${EXECUTORS.length} riktiga exekverare anropar grinden`)
  } else console.log(`✅ kanariefågel: båda de riktiga exekverarna anropar grinden`)

  grön('paritet', evaluate(bas))

  // ── R2 — EN EXEKVERARE UTAN GRIND (guardens kärna) ──────────────────────
  röd(
    'en exekverare anropar inte grinden',
    evaluate({ ...bas, executors: [EXEC_OK[0], { fil: 'ny-executor.ts', text: 'async executeTool(a) { return this.executeToolUnsafe(a) }' }] }),
    'anropar inte grinden',
  )

  // ── R3 — GRINDEN EFTER SIDOEFFEKTERNA ───────────────────────────────────
  röd(
    'körningen ligger före grinden',
    evaluate({
      ...bas,
      executors: [
        {
          fil: 'tool-executor.service.ts',
          text: `
  async executeTool(a) {
    const r = await this.executeToolUnsafe(a)
    ${GATE}(toolName, auditContext?.actionProof)
  }`,
        },
      ],
    }),
    'FÖRE grinden',
  )
  röd(
    'kollektorn ligger före grinden',
    evaluate({
      ...bas,
      executors: [
        {
          fil: 'tool-executor.service.ts',
          text: `
  async executeTool(a) {
    return runWithEffectCollector(() => { ${GATE}(t, p); return this.executeToolWithAudit(a) })
  }`,
        },
      ],
    }),
    'FÖRE grinden',
  )

  // ── R1 + R4 — grinden uppmjukad ─────────────────────────────────────────
  röd(
    'grinden prövar inte beviset',
    evaluate({ ...bas, gateText: GATE_OK.replace(`proof?.${PROOF} === true`, 'true') }),
    'prövar inte beviset',
  )
  röd(
    'grinden fäller ALLA verktyg (även läsande)',
    evaluate({ ...bas, gateText: GATE_OK.replace('if (!isActionTool(toolName)) return\n', '') }),
    'släpper inte igenom läsverktyg',
  )
  röd('grinden saknas helt', evaluate({ ...bas, gateText: 'const x = 1' }), `${GATE} saknas`)

  // ── R5 — bevis utan anspråk ─────────────────────────────────────────────
  röd(
    'ett bevis skrivs för hand utan atomärt anspråk',
    evaluate({ ...bas, otherFiles: [{ fil: 'genvag.ts', text: 'const p = { claimed: true }' }] }),
    'utan ett atomärt anspråk',
  )
  grön(
    'bevis bredvid ett riktigt anspråk',
    evaluate({ ...bas, otherFiles: OTHER_OK }),
  )

  röd('inga exekverare alls (blind skanning)', evaluate({ ...bas, executors: [] }), 'NOLL exekverare')


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

  const AI = join(TOOLS, '..')
  const problem = evaluate({
    gateText: readFileSync(GATE_FILE, 'utf8'),
    executors: EXECUTORS.map((f) => ({ fil: f, text: readFileSync(join(TOOLS, f), 'utf8') })),
    otherFiles: ['ai-assistant.service.ts', 'tenant-ai.service.ts'].map((f) => ({
      fil: f,
      text: readFileSync(join(AI, f), 'utf8'),
    })),
  })

  if (problem.length > 0) {
    console.error('\n=== BINDANDE VERKTYG KAN UTFÖRAS UTAN BEKRÄFTELSE (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.fil ? `src/ai/tools/${p.fil}` : 'action-authorization.ts'}\n   ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: maskinen FÖRESLÅR och människan BEKRÄFTAR det bindande. Se\n' +
        'apps/api/src/ai/tools/action-authorization.ts.\n',
    )
    process.exit(1)
  }

  console.log(
    `✅ båda exekverarna grindar bindande verktyg först av allt; läsverktyg passerar fritt.`,
  )
}

main()
