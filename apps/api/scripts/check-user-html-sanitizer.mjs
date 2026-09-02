#!/usr/bin/env node
/**
 * SANERINGEN AV ANVÄNDAR-/MODELLFÖRFATTAD HTML FÅR FINNAS PÅ ETT STÄLLE.
 *
 * ── Varför vakten finns ─────────────────────────────────────────────────────
 *
 * `mail/templates/base/Custom.tsx` renderar sin `bodyHtml` med
 * `dangerouslySetInnerHTML` och säger det rakt ut i sin egen docblock:
 * *"Måste redan vara säker — sanitiseras inte."* Ansvaret ligger alltså per
 * konstruktion hos ANROPAREN, och det fanns två av dem: `MessagesService`
 * (operatörens fritext) sanerade, AI-verktyget `compose_and_send_email`
 * (modellens fritext) gjorde det inte alls — samma mall, samma sänka.
 *
 * Rättningen var att slå ihop dem till EN allowlist och EN renderare i
 * `mail/user-html.ts`. Det löser dagens två. Vakten är det som gör att en
 * TREDJE inte kan uppstå.
 *
 * Två allowlists mot samma sänka är värre än två kopior av vad som helst
 * annat: den dag någon lägger till en tagg där den behövs följer den andra
 * listan inte med, alla tror att ändringen gäller överallt, och den yta som
 * glömdes släpper igenom tyst. Det är exakt samma defekt som
 * maskeringsvakten (#545) finns för, en nivå längre ut.
 *
 * ── Vad som fälls (fyra former av samma sak) ────────────────────────────────
 *
 * R1  En andra SANERARE — `sanitize-html` importerad eller anropad utanför den
 *     kanoniska modulen.
 * R2  En andra ALLOWLIST i bibliotekets egen form — `allowedTags:`,
 *     `allowedAttributes:`, `allowedSchemes:`, `disallowedTagsMode:`.
 * R3  En andra allowlist som UPPRÄKNING — en literal-samling som innehåller
 *     minst `MIN_TAG_OVERLAP` av de kanoniska taggarna. R2 fäller en kopia som
 *     använder biblioteket; R3 fäller en handrullad strippare som räknar upp
 *     samma taggar utan att heta något igenkännbart. Samma läxa som #533:
 *     spärra formen, inte uppräkningen — men båda behövs, för en kopia behöver
 *     varken heta samma sak eller använda samma bibliotek.
 * R4  En andra RENDERARE — en definition av `renderUserParagraphs` utanför den
 *     kanoniska modulen.
 *
 * Anrop och importer AV den kanoniska modulen är förstås fria. Det är hela
 * poängen: den enda tillåtna vägen.
 *
 * ── TRE VYER, OCH codeMask HADE VARIT FEL FÖR TVÅ AV DEM ────────────────────
 *
 * Mätt i det här trädet, inte resonerat:
 *
 *   modulspecifikatorn `'sanitize-html'`   codeMask → 0 träffar, blankComments → 1
 *   raw-HTML-sänkor                        råtext   → 4 filer,  codeMask     → 1
 *   kanoniska taggar ur allowedTags        blankComments → 14 riktiga namn
 *
 * Den första raden är den farliga. En modulspecifikator ÄR en sträng, och
 * `codeMask` blankar stränginnehåll: `from 'sanitize-html'` blir
 * `from '            '`. Hade R1 gått via `codeMask` vore den grön för alltid
 * — den hade sett ut att mäta och mätt ingenting. Den andra raden är det
 * omvända: tre av fyra "sänkor" i råtexten är KOMMENTARER som beskriver
 * sänkan, så sänkfrågan måste ställas mot kod.
 *
 * Vy per fråga, alltså:
 *
 *   blankComments  → modulspecifikatorn och TAGGNAMNEN. Båda bor i strängar.
 *   codeMask       → anropet, optionsnycklarna, renderar-DEFINITIONEN och
 *                    raw-HTML-sänkorna. Alla fyra är kod; ett kodexempel i
 *                    prosa är inget av dem.
 *   kommentarerna  → markörerna `user-html-allow:` / `user-html-sink-allow:`.
 *                    De står med FLIT i kommentarer och måste läsas där — en
 *                    sträng som råkar innehålla ordet får inte tysta vakten.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den mäter PÅKOPPLING i källtext: att det finns en sanerare, på ett ställe,
 * och att ingen sänka står okvitterad. Den kan per konstruktion INTE se att
 * `renderUserParagraphs` faktiskt anropas i rätt ordning, att dess utdata är
 * det som når mallen, eller att `sanitize-html` gör vad vi tror. En körtids-
 * no-op i renderaren lämnar den här vakten grön. Den mekaniken ägs av
 * `ai/tools/compose-email-sanitering.spec.ts` och `messages`-specarna.
 *
 * Den ser heller inte de tre SPA:erna. `apps/admin` skyddas av
 * `no-restricted-syntax` i `eslint.config.mjs` (#612); `apps/web` och
 * `apps/portal` har i dag noll raw-HTML-sänkor men ingen durabel spärr — det
 * är en känd, namngiven lucka och inte något den här vakten påstår sig täcka.
 *
 * Kör:        node apps/api/scripts/check-user-html-sanitizer.mjs
 * Självtest:  node apps/api/scripts/check-user-html-sanitizer.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  codeMask,
  blankComments,
  tokenize,
  kanariefåglar,
  KANARIEFÅGEL_LÄGEN,
} from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** Den enda filen som får sanera användarförfattad HTML. */
export const CANONICAL = 'mail/user-html.ts'

/** Renderaren den kanoniska modulen måste exportera — och ingen annan definiera. */
export const RENDERARE = 'renderUserParagraphs'

/**
 * Så många kanoniska taggnamn i EN literal-samling räcker för att kalla det en
 * andra allowlist.
 *
 * Tre, och marginalen är MÄTT mot 8a43026, inte gissad. Histogrammet över
 * samtliga 8330 literal-samlingar i `apps/api/src`, med dubbletter borträknade:
 *
 *     överlapp 0 → 8285 samlingar
 *     överlapp 1 →   44
 *     överlapp 3+ →   0
 *     överlapp 14 →   1   ← den kanoniska listan själv
 *
 * Ingen icke-kanonisk samling ligger över 1. Tröskeln har alltså två steg
 * marginal nedåt och elva uppåt. (Odedupat fanns EN samling på 2: `['a','a']`
 * i en spec — därför räknas överlappet på unika namn.)
 */
export const MIN_TAG_OVERLAP = 3

/**
 * Markörerna kräver ett SKÄL. En markör utan motivering är en tyst
 * avstängning — och de undantagna filerna räknas upp i den gröna utskriften,
 * så listan aldrig blir osynlig.
 */
export const MIN_REASON = 25

/** Bibliotekets egen optionsform. Kod-frågan: är det här en allowlist? */
const OPTION_KEYS = /\b(allowedTags|allowedAttributes|allowedSchemes|disallowedTagsMode|nonTextTags)\s*:/

/**
 * Raw-HTML-sänkor. Formen, inte en filnamnslista — en ny mall som renderar
 * ogranskad HTML fälls utan att någon behöver komma ihåg att lägga till den.
 */
const SINK =
  /dangerouslySetInnerHTML|\.(?:innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML|document\.write\s*\(/

/**
 * Taggarna HÄRLEDS ur den kanoniska modulen — ingen andra lista i den här filen.
 *
 * `blankComments`, INTE `codeMask`: taggnamnen ÄR stränginnehåll. Under
 * `codeMask` blir de fjorton blanksteg, jämförelsen kan aldrig mer bli sann,
 * och vakten hade fortsatt skriva ut ett tal. Se huvudkommentaren.
 */
export function canonicalTags(text) {
  const m = blankComments(text).match(/allowedTags:\s*\[([\s\S]*?)\]/)
  if (!m) return []
  return [...new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))]
}

/** Kommentarernas text, sammanslagen — komponerad ur den delade skannerns tokenize. */
export function kommentarsText(text) {
  return tokenize(text)
    .filter((t) => t.kind === 'line-comment' || t.kind === 'block-comment')
    .map((t) => text.slice(t.bodyStart, t.bodyEnd))
    .join('\n')
}

/** Motiveringen bakom en markör, eller null. */
export function markörSkäl(text, markör) {
  const m = kommentarsText(text).match(new RegExp(`${markör}:\\s*(.+)`))
  const skäl = m?.[1]?.trim() ?? ''
  return skäl.length >= MIN_REASON ? skäl : null
}

function sourceFiles(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) ut.push(...sourceFiles(full))
    else if (namn.endsWith('.ts') || namn.endsWith('.tsx')) ut.push(full)
  }
  return ut
}

/** Hittar en andra sanerare/allowlist/renderare i en filtext. */
export function findCopies(text, tags, { rel } = {}) {
  const problem = []
  if (rel === CANONICAL) return problem
  if (markörSkäl(text, 'user-html-allow')) return problem

  const kod = codeMask(text)
  const strängar = blankComments(text)

  // R1a — modulspecifikatorn är en STRÄNG. blankComments, aldrig codeMask.
  if (/from\s+['"]sanitize-html['"]|require\(\s*['"]sanitize-html['"]\s*\)/.test(strängar)) {
    problem.push({ kind: 'sanerare', detalj: "import av 'sanitize-html'" })
  }
  // R1b — anropet är KOD.
  if (/\bsanitizeHtml\s*\(/.test(kod)) {
    problem.push({ kind: 'sanerare', detalj: 'anrop av sanitizeHtml()' })
  }
  // R2 — optionsnycklarna är KOD. `USER_HTML_OPTS.allowedTags` är en läsning,
  // inte en definition, och matchar inte (nyckelformen kräver kolon).
  if (OPTION_KEYS.test(kod)) {
    problem.push({ kind: 'allowlist-form', detalj: kod.match(OPTION_KEYS)[1] + ':' })
  }
  // R3 — uppräkningen bor i STRÄNGAR. Kommentarer bort (en utkommenterad
  // gammal lista är ingen kopia), stränginnehåll kvar.
  for (const m of strängar.matchAll(/(?:new Set\(\[|\[)([\s\S]{0,600}?)\]/g)) {
    const literaler = [...new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))]
    const överlapp = literaler.filter((l) => tags.includes(l))
    if (överlapp.length >= MIN_TAG_OVERLAP) {
      problem.push({ kind: 'allowlist-uppräkning', detalj: `${överlapp.length} kanoniska taggar` })
    }
  }
  // R4 — definitionen är KOD.
  if (new RegExp(`function\\s+${RENDERARE}\\b`).test(kod)) {
    problem.push({ kind: 'renderare', detalj: `function ${RENDERARE}` })
  }
  return problem
}

// ── OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────────────
//
// Regeln kan fungera perfekt medan mängden är TOM. Fyra mängder kan krympa
// tyst här, och alla fyra lämnar vakten grön:
//
//   • filerna `sourceFiles` hittar,
//   • literal-samlingarna R3 alls granskar,
//   • de kanoniska taggarna — jämförelsemängden,
//   • RAW-HTML-SÄNKORNA. Den sista är vaktens existensberättigande: finns
//     ingen sänka finns inget att sanera, och en vakt som skyddar en yta som
//     inte längre går att hitta skyddar ingenting. Blir den mängden tom är
//     det antingen för att sänkan togs bort — och då ska vakten fällas så
//     någon får säga det — eller för att mönstret slutat matcha. Bägge
//     betyder att vakten inte längre mäter det den påstår.
//
// Golven är MÄTTA mot 8a43026: 823 filer, 8330 samlingar, 14 taggar, 1 sänka.
export const MIN_FILER = 500
export const MIN_SAMLINGAR = 3000
export const MIN_TAGGAR = 10
export const MIN_SÄNKOR = 1

/**
 * Bedömningen är SKILD från mätningen, så en tom mängd kan prövas utan att
 * någon behöver bygga ett falskt filträd. Kanariefågeln matar in `sänkor: 0`
 * och kräver rött.
 */
export function bedömOmfång({ filer, samlingar, taggar, sänkor }) {
  const fel = []
  if (filer < MIN_FILER) fel.push(`omfång: ${filer} filer skannade, golv ${MIN_FILER}`)
  if (samlingar < MIN_SAMLINGAR)
    fel.push(`omfång: ${samlingar} literal-samlingar granskade, golv ${MIN_SAMLINGAR}`)
  if (taggar.length < MIN_TAGGAR)
    fel.push(`omfång: ${taggar.length} kanoniska taggar, golv ${MIN_TAGGAR}`)
  // Jämförelsemängden måste vara RIKTIGA namn. Hade någon bytt R3 till codeMask
  // blir de blanktecken, och överlappet kan aldrig mer bli sant.
  if (taggar.some((t) => !/[A-Za-z]/.test(t)))
    fel.push('omfång: taggnamn utan bokstäver — masken har blankat stränginnehållet')
  if (sänkor.length < MIN_SÄNKOR)
    fel.push(
      `omfång: ${sänkor.length} raw-HTML-sänkor härledda, golv ${MIN_SÄNKOR}. ` +
        'Antingen finns ingen yta kvar som renderar användarförfattad HTML — och då ' +
        'ska den här vakten tas bort med ett beslut, inte stå kvar och vara grön — ' +
        'eller så har SINK-mönstret slutat matcha och vakten har gått blind.',
    )
  return fel
}

/** Härleder sänkorna. Frågan är "är det här ett ANROP/en attributsättning" → KOD. */
export function härledSänkor(root = SRC) {
  const ut = []
  for (const full of sourceFiles(root)) {
    const text = readFileSync(full, 'utf8')
    if (!SINK.test(codeMask(text))) continue
    const rel = relative(root, full).split(sep).join('/')
    ut.push({ rel, skäl: markörSkäl(text, 'user-html-sink-allow') })
  }
  return ut
}

export function scanTree(root = SRC) {
  const kanonisk = readFileSync(join(root, CANONICAL), 'utf8')
  const tags = canonicalTags(kanonisk)
  if (tags.length === 0) {
    throw new Error(
      'Kunde inte läsa allowedTags ur den kanoniska modulen — vakten mäter ingenting.',
    )
  }
  if (!new RegExp(`function\\s+${RENDERARE}\\b`).test(codeMask(kanonisk))) {
    throw new Error(
      `Den kanoniska modulen definierar inte längre ${RENDERARE} — R4 letar efter ett namn ` +
        'som inte finns, och skulle vara grön för alltid.',
    )
  }

  const fynd = []
  const undantagna = []
  let filer = 0
  let samlingar = 0
  for (const full of sourceFiles(root)) {
    filer++
    const rel = relative(root, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    samlingar += [...blankComments(text).matchAll(/(?:new Set\(\[|\[)([\s\S]{0,600}?)\]/g)].length
    const skäl = markörSkäl(text, 'user-html-allow')
    if (rel !== CANONICAL && skäl) undantagna.push({ rel, skäl })
    for (const p of findCopies(text, tags, { rel })) fynd.push({ rel, ...p })
  }

  const sänkor = härledSänkor(root)
  for (const s of sänkor) {
    if (!s.skäl) {
      fynd.push({
        rel: s.rel,
        kind: 'okvitterad sänka',
        detalj: 'renderar HTML utan att säga varifrån den är säker',
      })
    }
  }

  const omfångsfel = bedömOmfång({ filer, samlingar, taggar: tags, sänkor })
  return { tags, fynd, undantagna, sänkor, omfångsfel, mätt: { filer, samlingar } }
}

function run() {
  const { tags, fynd, undantagna, sänkor, omfångsfel, mätt } = scanTree()
  if (omfångsfel.length) {
    console.error('\n❌ Vakten har slutat mäta det den påstår\n')
    for (const f of omfångsfel) console.error(`  ${f}`)
    process.exit(1)
  }
  if (fynd.length) {
    console.error('\n❌ Saneringen av användarförfattad HTML finns i mer än ett exemplar\n')
    for (const f of fynd) console.error(`  ${f.rel}  — ${f.kind}: ${f.detalj}`)
    console.error(
      `\nSaneringen ska ske i src/${CANONICAL} och ingen annanstans.\n\n` +
        'Två allowlists mot samma sänka är hur den ena tyst blir svagare än den\n' +
        'andra: någon lägger till en tagg där den behövs, den andra listan följer\n' +
        'inte med, och ingen kontroll blir röd. Det var precis så AI-vägen matade\n' +
        'osanerad modelltext in i samma mall som operatörsvägen sanerade.\n\n' +
        'Importera i stället:\n' +
        `  import { renderUserParagraphs } from '<...>/mail/user-html'\n\n` +
        'En NY sänka (dangerouslySetInnerHTML, innerHTML=, insertAdjacentHTML,\n' +
        'document.write) måste säga i en kommentar varifrån dess HTML är säker:\n' +
        '  user-html-sink-allow: <varför den strängen redan är sanerad>\n\n' +
        'Behöver en fil verkligen ha en egen sanerare eller lista? Sätt\n' +
        '  user-html-allow: <varför>\n' +
        'i en kommentar i filen. Skälet räknas upp i den gröna utskriften.\n',
    )
    process.exit(1)
  }
  console.warn(
    `✅ Saneringen finns på ETT ställe (${tags.length} tillåtna taggar i src/${CANONICAL})`,
  )
  console.warn(
    `   omfång: ${mätt.filer} filer, ${mätt.samlingar} literal-samlingar, ` +
      `${sänkor.length} härledd(a) raw-HTML-sänka/-or`,
  )
  for (const s of sänkor) console.warn(`     sänka: ${s.rel} — ${s.skäl}`)
  if (undantagna.length) {
    console.warn(`   ${undantagna.length} fil(er) undantagna:`)
    for (const u of undantagna) console.warn(`     ${u.rel} — ${u.skäl}`)
  }
}

// ── självtest ───────────────────────────────────────────────────────────────
function selfTest() {
  let failed = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) failed++
  }
  const TAGGAR = ['p', 'h1', 'h2', 'strong', 'em', 'a', 'br', 'ul', 'ol', 'li']

  // ── R1–R4, en och en ─────────────────────────────────────────────────────
  t(
    'R1 en andra IMPORT av sanitize-html fälls',
    findCopies("import sanitizeHtml from 'sanitize-html'", TAGGAR).some(
      (p) => p.kind === 'sanerare',
    ),
  )
  t(
    'R1 ett andra ANROP av sanitizeHtml fälls',
    findCopies('const rent = sanitizeHtml(text, OPTS)', TAGGAR).some((p) => p.kind === 'sanerare'),
  )
  t(
    'R2 en andra allowlist i bibliotekets form fälls',
    findCopies("const O = { allowedTags: ['b'] }", TAGGAR).some((p) => p.kind === 'allowlist-form'),
  )
  t(
    'R3 en andra allowlist som UPPRÄKNING fälls — även utan bibliotekets namn',
    findCopies("const TILLATNA = ['p', 'strong', 'em']", TAGGAR).some(
      (p) => p.kind === 'allowlist-uppräkning',
    ),
  )
  t(
    'R4 en andra renderare fälls',
    findCopies(`export function ${RENDERARE}(t) { return t }`, TAGGAR).some(
      (p) => p.kind === 'renderare',
    ),
  )

  // ── motpar: legitim användning är TYST ───────────────────────────────────
  t(
    'ett ANROP av den kanoniska renderaren är ingen kopia',
    findCopies(`const html = ${RENDERARE}(body)`, TAGGAR).length === 0,
  )
  t(
    'en IMPORT av den kanoniska modulen är ingen kopia',
    findCopies(`import { ${RENDERARE} } from '../mail/user-html'`, TAGGAR).length === 0,
  )
  t(
    'en LÄSNING av optionsobjektet är ingen definition',
    findCopies('expect(USER_HTML_OPTS.allowedTags).not.toContain(tagg)', TAGGAR).length === 0,
  )
  t(
    'en fil som nämner EN tagg fälls inte',
    findCopies("const x = ['p']", TAGGAR).length === 0,
  )
  t(
    'den kanoniska filen fäller inte sig själv',
    findCopies("import sanitizeHtml from 'sanitize-html'", TAGGAR, { rel: CANONICAL }).length === 0,
  )

  // ── VYERNAS SEMANTIK ─────────────────────────────────────────────────────
  //
  // Sonden nedan överskrider MED FLIT tröskeln: en sond UNDER tröskeln ger
  // grönt av rätt skäl och bevisar ingenting om masken.
  const SOND = ['p', 'strong', 'em'] // 3 = tröskeln
  t(
    `SOND-STYRKA: ${SOND.length} kanoniska taggar mot tröskel ${MIN_TAG_OVERLAP}`,
    SOND.length >= MIN_TAG_OVERLAP,
  )
  t(
    'VY: en modulspecifikator i en KOMMENTAR är ingen import',
    findCopies("// import sanitizeHtml from 'sanitize-html' — se user-html.ts", TAGGAR).length === 0,
  )
  t(
    'VY: men R1 läser blankComments, inte codeMask — importen fälls fortfarande',
    // Det här är kärnan i migreringsfällan. Under codeMask är specifikatorn
    // blanksteg och regeln kan ALDRIG matcha. Beviset körs som ett par:
    // regeln fäller den riktiga importen, och den skulle inte göra det om
    // frågan ställdes mot kod.
    findCopies("import sanitizeHtml from 'sanitize-html'", TAGGAR).length === 1 &&
      !/sanitize-html/.test(codeMask("import sanitizeHtml from 'sanitize-html'")),
  )
  t(
    'VY: en utkommenterad taggliston är ingen kopia',
    findCopies(`// const T = [${SOND.map((s) => `'${s}'`).join(', ')}]`, TAGGAR).length === 0,
  )
  t(
    'VY: men en RIKTIG tagglista fälls — skärpan är kvar',
    findCopies(`const T = [${SOND.map((s) => `'${s}'`).join(', ')}]`, TAGGAR).some(
      (p) => p.kind === 'allowlist-uppräkning',
    ),
  )
  t(
    'VY: en renderar-definition i PROSA är ingen definition',
    findCopies(`// se function ${RENDERARE} i mail/user-html.ts`, TAGGAR).length === 0,
  )
  t(
    'VY: markören i en STRÄNG tystar INTE vakten',
    findCopies(
      `const hint = 'user-html-allow: det här är bara en text som nämner markören'\n` +
        "import sanitizeHtml from 'sanitize-html'",
      TAGGAR,
    ).length === 1,
  )
  t(
    'VY: markören i en KOMMENTAR tystar den',
    findCopies(
      '// user-html-allow: eget prov mot den gamla formen, aldrig i produktionsvägen\n' +
        "import sanitizeHtml from 'sanitize-html'",
      TAGGAR,
    ).length === 0,
  )
  t(
    'en markör UTAN riktigt skäl tystar INTE',
    findCopies("// user-html-allow: x\nimport sanitizeHtml from 'sanitize-html'", TAGGAR).length ===
      1,
  )
  t(
    'VY: taggarna kommer ur strängarna, inte som blanktecken',
    canonicalTags("const O = { allowedTags: ['p', 'strong', 'p'] }").join(',') === 'p,strong',
  )

  // ── KANARIEFÅGEL 1: REGELN ───────────────────────────────────────────────
  //
  // Kontrollerna ovan är namngivna negativkontroller: de fäller specifika
  // återfall. De upptäcker inte att mekanismen gått blind i EN av sina fyra
  // vägar — en `findCopies` som tappat R3 men behållit R1 passerar tre av dem.
  // Kanariefågeln matar in en andra sanerare/allowlist av VARJE form i ett och
  // samma anrop och kräver utslag på alla fyra, plus ett motpar som kräver att
  // ren kod förblir tyst.
  t(
    'KANARIEFÅGEL (regel): alla fyra detektionsvägarna ger utslag',
    (() => {
      const vägar = {
        sanerare: findCopies("import sanitizeHtml from 'sanitize-html'", TAGGAR),
        'allowlist-form': findCopies("const O = { allowedSchemes: ['http'] }", TAGGAR),
        'allowlist-uppräkning': findCopies("const T = ['p', 'strong', 'em']", TAGGAR),
        renderare: findCopies(`function ${RENDERARE}(t) {}`, TAGGAR),
      }
      return Object.entries(vägar).every(([kind, fynd]) => fynd.some((p) => p.kind === kind))
    })(),
  )
  t(
    'KANARIEFÅGEL (regel): och ren kod ger INGET utslag — vakten fäller inte allt',
    findCopies("const s = 'hej'\nexport function annat() { return 1 }", TAGGAR).length === 0,
  )
  t(
    'KANARIEFÅGEL (regel): taggarna HÄRLEDS — tom lista är ett fel, inte grönt',
    canonicalTags('inget här').length === 0,
  )

  // ── KANARIEFÅGEL 2: OMFÅNGET ─────────────────────────────────────────────
  //
  // Den mängd vakten skyddar är HÄRLEDD, inte listad. En härledd mängd kan bli
  // tom utan att någon rad ändras — mönstret slutar matcha, masken byts, en
  // katalog flyttas. En tom mängd MÅSTE fälla; annars är vakten grön just när
  // den slutat ha något att skydda.
  const fulltOmfång = { filer: 823, samlingar: 8330, taggar: TAGGAR, sänkor: [{ rel: 'x' }] }
  t(
    'KANARIEFÅGEL (omfång): en TOM sänkmängd fäller',
    bedömOmfång({ ...fulltOmfång, sänkor: [] }).some((f) => /raw-HTML-sänkor/.test(f)),
  )
  t(
    'KANARIEFÅGEL (omfång): ett tomt filträd fäller',
    bedömOmfång({ ...fulltOmfång, filer: 0 }).length > 0,
  )
  t(
    'KANARIEFÅGEL (omfång): noll granskade literal-samlingar fäller',
    bedömOmfång({ ...fulltOmfång, samlingar: 0 }).length > 0,
  )
  t(
    'KANARIEFÅGEL (omfång): en KRYMPT taggmängd fäller (trubbig, inte tom)',
    bedömOmfång({ ...fulltOmfång, taggar: ['p', 'a'] }).length > 0,
  )
  t(
    'KANARIEFÅGEL (omfång): taggar som blankats av fel mask fäller',
    bedömOmfång({ ...fulltOmfång, taggar: Array(12).fill('   ') }).length > 0,
  )
  t(
    'KANARIEFÅGEL (omfång): och det fulla omfånget är GRÖNT — golvet fäller inte allt',
    bedömOmfång(fulltOmfång).length === 0,
  )
  t(
    'KANARIEFÅGEL (omfång): sänkan frågas mot KOD — en sänka i prosa räknas inte',
    !SINK.test(codeMask('// renderas med dangerouslySetInnerHTML, se Custom.tsx')) &&
      SINK.test(codeMask('<div dangerouslySetInnerHTML={{ __html: b }} />')),
  )

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ──────────────────
  const skanner = kanariefåglar()
  t(
    `delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`,
    skanner.length === 0,
    skanner.join(' | '),
  )

  // ── KODBASEN PÅ RIKTIGT ──────────────────────────────────────────────────
  const { tags, fynd, sänkor, omfångsfel, mätt } = scanTree()
  t('kodbasen har exakt en sanerare', fynd.length === 0, JSON.stringify(fynd).slice(0, 300))
  t('allowlistan gick att läsa ur den kanoniska modulen', tags.length >= MIN_TAGGAR, `${tags.length} taggar`)
  t(
    'OMFÅNGSKANARIEFÅGEL mot trädet: mängderna är inte tomma',
    omfångsfel.length === 0,
    omfångsfel.length
      ? omfångsfel.join(' | ')
      : `${mätt.filer} filer (golv ${MIN_FILER}), ${mätt.samlingar} literal-samlingar ` +
        `(golv ${MIN_SAMLINGAR}), ${tags.length} taggar (golv ${MIN_TAGGAR}), ` +
        `${sänkor.length} sänka/-or (golv ${MIN_SÄNKOR}): ${sänkor.map((s) => s.rel).join(', ')}`,
  )

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv[2] === '--self-test') selfTest()
else run()
