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
 *     Prövas i SAMMA FUNKTION som beviset (etapp 2b), över ett HÄRLETT omfång
 *     — inte över en lista med två filnamn, som fram till 2026-08-30. Mängden
 *     bär en egen kanariefågel: är den tom blir vakten röd.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN. Den mäter att grinden finns, anropas, ligger
 * först och inte fäller läsverktyg. R5:s gräns står vid
 * `omslutandeFunktionskropp`: ett anspråk som görs via en HJÄLPARE ligger i en
 * annan funktion och syns inte härifrån. Att följa anropskedjan skulle kräva
 * en typgraf, och en statisk vakt som behöver en typgraf är inte längre
 * statisk. Svagheten är känd, inte förbisedd. Att anspråket faktiskt är atomiskt — att två
 * samtidiga bekräftelser ger exakt EN vinnare — är en egenskap hos databasen och
 * mäts i `action-idempotency.spec.ts` mot riktig Postgres.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-action-tool-authorization.mjs
 * Självtest:   node apps/api/scripts/check-action-tool-authorization.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, '..', 'src', 'ai', 'tools')
const GATE_FILE = join(TOOLS, 'action-authorization.ts')

const GATE = 'assertActionToolAuthorized'
const PROOF = 'claimed'

/** Exekverarna. Uppräkningen är medveten — R2 kräver att BÅDA anropar grinden. */
export const EXECUTORS = ['tool-executor.service.ts', 'tenant-tool-executor.service.ts']

/** Källtext utan kommentarer. Ett omnämnande i prosa är inte ett anrop. */
import { withoutComments, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
export { withoutComments }

/** Kroppen för `async executeTool(` fram till nästa metod på samma nivå. */
export function executeToolBody(text) {
  const i = text.indexOf('async executeTool(')
  if (i === -1) return null
  const efter = text.slice(i + 10)
  const nästa = efter.search(/\n  (?:private |public )?(?:async )?[\p{L}\p{N}_$]+\s*\(/u)
  return nästa === -1 ? efter : efter.slice(0, nästa)
}

/**
 * ── R5:S OMFÅNG: ETT SVEP, INTE EN LISTA (etapp 2b) ─────────────────────────
 *
 * FRAM TILL 2026-08-30 var det här en hårdkodad lista om TVÅ filer, och den
 * blindheten är mätt, inte befarad:
 *
 *     sond `AiDelegationService` lagd på disk  →  vakten GRÖN, exit 0
 *     samma innehåll inmatat i evaluate()      →  1 brott
 *
 * Regeln fungerade. Mängden var tom för allt utom två filer. En vakt vars
 * parameter defaultar till `[]` mäter ingenting och är grön för alltid.
 *
 * ── HUR MÄNGDEN HÄRLEDS NU ──────────────────────────────────────────────────
 *
 * Alla `.ts` under `apps/api/src` och `packages/shared/src` som RÖR
 * BEVISMEKANISMEN, alltså nämner något av:
 *
 *     ActionProof                    typen
 *     actionProof                    fält-/parameternamnet
 *     assertActionToolAuthorized     grinden som tar emot beviset
 *
 * Det är inte en filnamnslista utan tre signaler som ÄR mekanismens egna namn.
 * Döps någon av dem om faller R1 (grinden prövar inte beviset) först, så
 * omdöpningen kan inte tyst tömma mängden.
 *
 * ── VARFÖR INTE BARA "ALLA FILER MED claimed: true" ─────────────────────────
 *
 * Mätt: 31 träffar på `claimed: true` i repot, och en av dem är
 * `invoices.service.ts:1366` — `return { claimed: true, invoiceNumber }`, ett
 * HELT ANNAT `claimed` (fakturans betalningsanspråk). Ett svep utan
 * mekanismfilter hade fällt den varje gång och blivit avstängt inom en vecka.
 * En vakt som larmar på rätt saker OCH fel saker slutar man lita på.
 *
 * Specfiler utesluts på FORMEN `\.spec\.ts$` — inte på ordet "spec", som
 * också matchar katalogen `in[spec]tions/`. De konstruerar bevis som fixturer,
 * vilket är hela poängen med dem.
 */
const PROOF_SIGNALS = [/\bActionProof\b/, /\bactionProof\b/, new RegExp(`(?<![\\p{L}\\p{N}_$])${GATE}(?![\\p{L}\\p{N}_$])`, 'u')]

/** Alla .ts-filer under en katalog, rekursivt. Spec-filer på formen utesluts. */
export function samlaKällfiler(rot, ut = []) {
  for (const namn of readdirSync(rot)) {
    const full = join(rot, namn)
    if (statSync(full).isDirectory()) {
      if (namn === 'node_modules' || namn === 'dist' || namn.startsWith('.')) continue
      samlaKällfiler(full, ut)
    } else if (/\.ts$/.test(namn) && !/\.spec\.ts$/.test(namn)) {
      ut.push(full)
    }
  }
  return ut
}

/** Filer som rör bevismekanismen — R5:s härledda omfång. */
export function härledProofFiler(filer, läs) {
  const ut = []
  for (const full of filer) {
    const text = läs(full)
    const kod = withoutComments(text)
    if (PROOF_SIGNALS.some((re) => re.test(kod))) ut.push({ fil: full, text })
  }
  return ut
}

/**
 * Kroppen för funktionen som omsluter `index` i `kod`.
 *
 * ── VARFÖR FUNKTIONSNIVÅ OCH INTE FILNIVÅ ───────────────────────────────────
 *
 * R5 var en FILNIVÅ-SAMFÖREKOMST: en fil som av egna skäl gjorde `updateMany`
 * med `count === 1` någon annanstans passerade, även om beviset skapades
 * utan anspråk. Mätt att skärpningen håller för de riktiga producenterna:
 * både `consumePendingAction` (ai-assistant.service.ts) och
 * tenant-vägen har `updateMany`, `count !== 1` och beviset i SAMMA funktion.
 *
 * ── DEN KVARVARANDE SVAGHETEN, UTSKRIVEN ────────────────────────────────────
 *
 * Skärpningen når inte hela vägen: gör en funktion sitt anspråk genom en
 * HJÄLPARE (`const ok = await this.claimIt()`) ligger `updateMany` i en annan
 * funktion och R5 fäller — ett falskt larm — eller, om hjälparen inlineas
 * senare, tvärtom. Det är känt och inte förbisett. Att följa anropskedjan
 * skulle kräva en typgraf, och en vakt som behöver en typgraf för att uttala
 * sig är inte längre en statisk kontroll. Larmar den fel: flytta anspråket in
 * i funktionen eller skriv om R5, men lägg INTE till ett undantag per fil —
 * det var precis den formen som gjorde mängden blind.
 */
/**
 * Ligger `index` inuti en TYPDEKLARATION (`interface X { … }` / `type X = { … }`)?
 *
 * `ActionProof` deklarerar självt `claimed: true` — det är typens definition,
 * inte ett producerat bevis. Utan den här skillnaden fäller svepet på filen
 * som DEFINIERAR mekanismen, vilket är det mest meningslösa larm en vakt kan
 * ge. Skillnaden görs på FORMEN (blocket föregås av `interface`/`type`), inte
 * genom att undanta filen vid namn — ett filnamnsundantag hade blivit början
 * på en ny lista, och det var listan som gjorde mängden blind.
 */
export function ärTypdeklaration(kod, index) {
  let djup = 0
  for (let i = index - 1; i >= 0; i--) {
    const c = kod[i]
    if (c === '}') djup++
    else if (c === '{') {
      if (djup === 0) {
        const före = kod.slice(Math.max(0, i - 200), i)
        return /(?<![\p{L}\p{N}_$])(interface|type)\s+[\p{L}\p{N}_$][\p{L}\p{N}_$<>,\s]*=?\s*$/u.test(före)
      }
      djup--
    }
  }
  return false
}

export function omslutandeFunktionskropp(kod, index) {
  // Gå bakåt tills vi hittar ett `{` som inte är stängt — det är närmaste
  // omslutande block. Upprepa utåt tills blocket föregås av en
  // funktionssignatur (slutar på `)` eller `): Typ`).
  let sök = index
  for (let nivå = 0; nivå < 8; nivå++) {
    let djup = 0
    let öppen = -1
    for (let i = sök - 1; i >= 0; i--) {
      const c = kod[i]
      if (c === '}') djup++
      else if (c === '{') {
        if (djup === 0) {
          öppen = i
          break
        }
        djup--
      }
    }
    if (öppen === -1) return null // top-level, ingen omslutande funktion
    const före = kod.slice(Math.max(0, öppen - 200), öppen)
    if (/\)\s*(:\s*[^{;=]{0,80})?\s*$/.test(före) || /=>\s*$/.test(före)) {
      // Hittat funktionskroppen. Ta fram till matchande `}`.
      let d = 0
      for (let i = öppen; i < kod.length; i++) {
        if (kod[i] === '{') d++
        else if (kod[i] === '}') {
          d--
          if (d === 0) return kod.slice(öppen, i + 1)
        }
      }
      return kod.slice(öppen)
    }
    sök = öppen
  }
  return null
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ gateText, executors, proofFiles = [], omfångHärlett = true }) {
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

  // ── R5:S OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────
  //
  // Samma form som exekverarkontrollen ovan ("NOLL exekverare lästes"), och av
  // samma skäl: en tom mängd gör regeln nedan grön om ALLT. Fram till 2026-08-30
  // var mängden två hårdkodade filer och en sond utanför dem prövades aldrig.
  //
  // Kontrollen gäller bara när omfånget HÄRLETTS. Självtestet matar in en
  // handplockad mängd och sätter `omfångHärlett: false` — annars hade varje
  // enskilt regelprov behövt bära en attrapp för att komma förbi kanariefågeln.
  if (omfångHärlett && proofFiles.length === 0) {
    problem.push({
      rule: 'NOLL filer i R5:s omfång',
      detail:
        'Svepet hittade ingen fil som rör bevismekanismen (ActionProof, actionProof ' +
        'eller ' +
        GATE +
        '). Det kan inte stämma så länge grinden finns — skanningen har gått ' +
        'blind, och R5 nedan hade varit grön om vad som helst.',
    })
  }

  // ── R5 — beviset produceras bara av anspråksvägarna ───────────────────────
  //
  // Skärpt från FILNIVÅ till FUNKTIONSNIVÅ (etapp 2b). Tidigare räckte det att
  // filen någonstans gjorde `updateMany` med `count === 1` — en fil som gjorde
  // det av egna skäl passerade även om beviset skapades utan anspråk.
  for (const { fil, text } of proofFiles) {
    const kod = codeMask(text)
    const re = /\bclaimed:\s*true\b/g
    let m
    while ((m = re.exec(kod)) !== null) {
      // Typens egen deklaration är inte ett producerat bevis.
      if (ärTypdeklaration(kod, m.index)) continue
      const kropp = omslutandeFunktionskropp(kod, m.index)
      // Ingen omslutande funktion (top-level-literal) → pröva hela filen. Det
      // är svagare, men att hoppa över hade varit att tyst släppa igenom.
      const omfång = kropp ?? kod
      const harAnspråk = /updateMany\(/.test(omfång) && /count\s*[!=]==?\s*1/.test(omfång)
      if (!harAnspråk) {
        problem.push({
          fil,
          rule: 'skapar ett bevis (`claimed: true`) utan ett atomärt anspråk i samma funktion',
          detail:
            'Beviset ska bara kunna uppstå ur ett lyckat engångsanspråk (updateMany på ' +
            'en icke-konsumerad rad, count === 1) I SAMMA FUNKTION. En handskriven ' +
            'flagga är ett kringgående i förklädnad, och ett anspråk längre bort i ' +
            'filen är inte samma sak som ett anspråk som faktiskt gäller beviset.',
        })
        break // ett brott per fil räcker; listan ska peka, inte översvämma
      }
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
const PROOF_OK = [
  {
    fil: 'ai-assistant.service.ts',
    text: `
  private async consumePendingAction(id) {
    const claim = await this.prisma.x.updateMany({})
    if (claim.count !== 1) return { status: 'already-consumed' }
    return { status: 'claimed', proof: { claimed: true } }
  }`,
  },
]

/** Anspråket ligger i EN ANNAN funktion än beviset — filnivå hade släppt igenom. */
const PROOF_ANNAN_FUNKTION = [
  {
    fil: 'smyg.ts',
    text: `
  private async nagotHeltAnnat() {
    const r = await this.prisma.x.updateMany({})
    if (r.count !== 1) throw new Error('nej')
  }
  private byggBevis() {
    return { actionProof: { claimed: true } }
  }`,
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
  const bas = { gateText: GATE_OK, executors: EXEC_OK, proofFiles: PROOF_OK, omfångHärlett: false }

  // ── KANARIEFÅGEL 1: kroppsläsningen måste ge utslag ──────────────────────
  const b = executeToolBody(EXEC_OK[0].text)
  if (!b || !b.includes(GATE) || b.includes('executeToolWithAudit(a) {')) {
    fail(`kanariefågel: kroppsläsningen gav ${JSON.stringify(b)?.slice(0, 80)}`)
  } else console.log('✅ kanariefågel: kroppsläsningen avgränsar executeTool i fixturen')

  // ── #713: DE TRE STÄLLEN SOM BYTTES, ETT PROV VART ──────────────────────
  //
  // KANARIEFÅGEL 1 ovan täcker INTE de här: den använder en ASCII-namngiven
  // nästa metod och märker därför inget när avgränsningen går blind. Det är
  // #736:s lärdom — befintliga prov skyddar mot specifika återfall, inte mot
  // att en annan mekanism slutar mäta.
  {
    const kropp = (nästa) =>
      executeToolBody(
        `class X {\n  async executeTool(n) {\n    return 1\n  }\n\n  ${nästa}(a) {\n    const ZZNÄSTA = 1\n    return a\n  }\n}`,
      )

    // (1) KROPPSAVGRÄNSNINGEN. Uppmätt mot origin/main:
    //       nästa metod nastaMetod   → längd 30, ZZNÄSTA utanför    (rätt)
    //       nästa metod ärBatch      → längd 92, ZZNÄSTA INNANFÖR   MISSAD
    //       nästa metod hittaFärsk   → längd 95, ZZNÄSTA INNANFÖR   KAPAD
    //     Kroppen löper in i NÄSTA metod. Följden är en FALSK GRÖN: R1 letar
    //     efter grindanropet i `executeTool`, och hittar det då lika gärna i
    //     metoden efter. `tool-executor.service.ts` bär redan
    //     `ärBatchMottagarkonflikt` — namnet är inte hypotetiskt.
    if (kropp('nastaMetod')?.includes('ZZNÄSTA'))
      fail('#713 (1) MOTPROV: ASCII-nästa metod läcker in i kroppen')
    else console.log('✅ #713 (1) MOTPROV: ASCII-nästa metod avgränsar som förut')
    if (kropp('ärBatch')?.includes('ZZNÄSTA'))
      fail('#713 (1) MISSAD: nästa metod med svensk INITIAL avgränsar inte kroppen')
    else console.log('✅ #713 (1) MISSAD: svensk initial avgränsar kroppen')
    if (kropp('hittaFärsk')?.includes('ZZNÄSTA'))
      fail('#713 (1) KAPAD: nästa metod med svenskt tecken MITT i avgränsar inte kroppen')
    else console.log('✅ #713 (1) KAPAD: svenskt tecken mitt i avgränsar kroppen')

    // (2) GRINDSIGNALEN. `\b${GATE}\b` matchar inuti `denPå<GATE>`, eftersom
    //     `å` inte är ett ordtecken — en fil som INTE anropar grinden hade
    //     räknats som bevisbärande. Falsk grön.
    const signal = PROOF_SIGNALS[PROOF_SIGNALS.length - 1]
    if (signal.test(`const x = denPå${GATE}(1)`))
      fail('#713 (2) FALSK GRÖN: ett annat namn räknades som grindanrop')
    else console.log('✅ #713 (2) FALSK GRÖN: `denPå<grind>` är inte grinden')
    if (!signal.test(`await ${GATE}(n, p)`))
      fail('#713 (2) MOTPROV: det äkta grindanropet känns inte igen')

    // (3) TYPDEKLARATIONEN. Uppmätt: `interface Ärende {` och
    //     `interface FörvaltningsTyp {` gav BÅDA false — en typkropp lästes
    //     som riktig kod, och R-reglerna larmade på en deklaration.
    for (const namn of ['Ärende', 'FörvaltningsTyp']) {
      const src = `interface ${namn} {\n  x: 1\n}`
      if (!ärTypdeklaration(src, src.indexOf('{') + 1))
        fail(`#713 (3) MISSAD: \`interface ${namn}\` läses inte som typdeklaration`)
      else console.log(`✅ #713 (3) MISSAD: typnamn ${namn} känns igen`)
    }
    const ascii = 'interface Avtal {\n  x: 1\n}'
    if (!ärTypdeklaration(ascii, ascii.indexOf('{') + 1))
      fail('#713 (3) MOTPROV: ASCII-typnamn slutade kännas igen')
    const kod = 'function Avtal() {\n  x()\n}'
    if (ärTypdeklaration(kod, kod.indexOf('{') + 1))
      fail('#713 (3) MOTPROV: en FUNKTION lästes som typdeklaration')
  }

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
    evaluate({ ...bas, proofFiles: [{ fil: 'genvag.ts', text: 'const p = { claimed: true }' }] }),
    'utan ett atomärt anspråk',
  )
  grön(
    'bevis bredvid ett riktigt anspråk',
    evaluate({ ...bas, proofFiles: PROOF_OK }),
  )

  röd('inga exekverare alls (blind skanning)', evaluate({ ...bas, executors: [] }), 'NOLL exekverare')

  // ── ETAPP 2B: OMFÅNGET ───────────────────────────────────────────────────
  //
  // Lärdomen av 2026-08-30: regeln fungerade, mängden var tom. En vakt vars
  // parameter defaultar till [] mäter ingenting och är grön för alltid.
  röd(
    'R5:s omfång är TOMT (blind skanning)',
    evaluate({ gateText: GATE_OK, executors: EXEC_OK, proofFiles: [] }),
    'NOLL filer i R5:s omfång',
  )
  grön(
    'tomt omfång fäller INTE när mängden matats in för hand (självtestets läge)',
    evaluate({ gateText: GATE_OK, executors: EXEC_OK, proofFiles: [], omfångHärlett: false }),
  )

  // Härledningen ska hitta en fil som rör mekanismen, och INTE en som bara
  // råkar ha ordet `claimed` av helt andra skäl (invoices.service.ts:1366
  // returnerar `{ claimed: true, invoiceNumber }` — fakturans betalning).
  const härledd = härledProofFiler(['a.ts', 'b.ts', 'c.ts'], (f) =>
    f === 'a.ts'
      ? 'const p: ActionProof = { claimed: true }'
      : f === 'b.ts'
        ? 'return { claimed: true, invoiceNumber: x }'
        : `${GATE}(name, proof)`,
  )
  const namn = härledd.map((x) => x.fil).sort()
  namn.length === 2 && namn[0] === 'a.ts' && namn[1] === 'c.ts'
    ? console.log('✅ härledningen tar mekanismfilerna och lämnar det andra `claimed`')
    : fail(`härledningen tog fel filer: ${JSON.stringify(namn)}`)

  // ── ETAPP 2B: FUNKTIONSNIVÅ, INTE FILNIVÅ ────────────────────────────────
  //
  // Det gamla filnivåvillkoret hade släppt igenom den här: filen HAR ett
  // updateMany med count === 1 — bara inte i funktionen som bygger beviset.
  röd(
    'anspråket ligger i en ANNAN funktion än beviset',
    evaluate({ ...bas, proofFiles: PROOF_ANNAN_FUNKTION }),
    'i samma funktion',
  )

  // Typens egen deklaration är inte ett producerat bevis.
  grön(
    'interface ActionProof { claimed: true } är inte ett bevis',
    evaluate({
      ...bas,
      proofFiles: [{ fil: 'action-authorization.ts', text: 'export interface ActionProof {\n  claimed: true\n}' }],
    }),
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

  // Omfånget HÄRLEDS ur koden i stället för att listas. Se docblocket vid
  // PROOF_SIGNALS för varför, och för vad den gamla listan kostade.
  const API_SRC = join(TOOLS, '..', '..')
  const SHARED_SRC = join(TOOLS, '..', '..', '..', '..', '..', 'packages', 'shared', 'src')
  const rötter = [API_SRC, SHARED_SRC].filter((r) => {
    try {
      return statSync(r).isDirectory()
    } catch {
      return false
    }
  })
  const alla = rötter.flatMap((r) => samlaKällfiler(r))
  const proofFiles = härledProofFiler(alla, (f) => readFileSync(f, 'utf8'))

  const problem = evaluate({
    gateText: readFileSync(GATE_FILE, 'utf8'),
    executors: EXECUTORS.map((f) => ({ fil: f, text: readFileSync(join(TOOLS, f), 'utf8') })),
    proofFiles,
  })

  if (problem.length > 0) {
    console.error('\n=== BINDANDE VERKTYG KAN UTFÖRAS UTAN BEKRÄFTELSE (CI-guard) ===\n')
    for (const p of problem) {
    // Exekverarna kommer in med kort filnamn, svepet med absolut sökväg.
    const var_ = p.fil ? (p.fil.includes('/') ? relative(process.cwd(), p.fil) : `src/ai/tools/${p.fil}`) : 'action-authorization.ts'
    console.error(`❌ ${var_}\n   ${p.rule}\n   ${p.detail}`)
  }
    console.error(
      '\nRegeln: maskinen FÖRESLÅR och människan BEKRÄFTAR det bindande. Se\n' +
        'apps/api/src/ai/tools/action-authorization.ts.\n',
    )
    process.exit(1)
  }

  console.log(
    `✅ båda exekverarna grindar bindande verktyg först av allt; läsverktyg passerar fritt.\n` +
      `   R5: ${proofFiles.length} fil(er) i omfånget, härledda ur ${alla.length} källfiler ` +
      `(ActionProof | actionProof | ${GATE}).`,
  )
}

main()
