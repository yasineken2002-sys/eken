#!/usr/bin/env node
/**
 * CI-guard — en juridisk text får inte ändras utan att versionen följer med.
 *
 * ── VAD SOM BRAST ────────────────────────────────────────────────────────────
 *
 * `platform.ts` sa att versionen "ska ökas" när en juridisk text ändras
 * materiellt. Det var en KONVENTION, inte en mekanism. #574 tog bort ett
 * avtalsåtagande ur Evenos skyldigheter och bumpade ingenting — upptäckt först
 * när någon grepade brett i ett annat ärende. Följden stod skarp i produktion:
 * `1.0` betecknade två olika texter, sidorna visade ett datum fyra månader fel,
 * och ingen re-acceptance triggades.
 *
 * ── VARFÖR DEN HÄR FORMEN (innehållshash, inte git-diff) ─────────────────────
 *
 * Den självklara formen vore att diffa PR:en mot main och kräva att versionen
 * rörts om texten rörts. Jag valde bort den av tre skäl:
 *
 *   1. En diff-baserad kontroll mäter en RELATION mellan två commits och är
 *      beroende av `fetch-depth`, basref och hur historiken råkar se ut. Den kan
 *      gå tyst blind vid squash, rebase eller shallow clone — och en vakt som
 *      går blind utan att bli röd är precis det den här kodbasen har mest
 *      erfarenhet av att ångra.
 *   2. En hash mäter ETT TILLSTÅND. Den är sann eller falsk om arbetsträdet
 *      självt, oavsett hur man kom dit, och den fungerar likadant lokalt som i
 *      CI.
 *   3. Hashen är dessutom det #577 efterfrågar i sak: en version som är
 *      INNEHÅLLSADRESSERAD i stället för en handskriven etikett.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 *   R1  Den normaliserade texten för varje dokument måste hasha till det som
 *       står i `LEGAL_DOCUMENT_HASHES`. Ändrad text utan uppdaterad manifest
 *       ⇒ RÖTT, med den nya hashen utskriven så den går att klistra in.
 *   R2  Manifestets `version` måste vara samma som `LEGAL_DOCUMENT_VERSIONS`.
 *       De två får aldrig kunna glida isär.
 *   R3  Den nuvarande versionen får INTE finnas i `LEGAL_DOCUMENT_VERSION_HISTORY`.
 *       Historiken är append-only: ett versionsnummer som en gång bundits till
 *       en text kan aldrig återanvändas för en annan. DET är vad som gör bumpen
 *       obligatorisk — vill man ändra texten måste man pensionera den gamla
 *       hashen, och då är den gamla versionen förbrukad.
 *   R4  KANARIEFÅGELN: varje avsnittsrubrik som finns i källfilen måste också
 *       finnas i den extraherade texten. Rubrikerna HÄRLEDS UR KÄLLAN — ingen
 *       hårdkodad lista, inget "fler än noll". Går extraheringen blind
 *       försvinner rubrikerna och varje dokument blir rött.
 *
 * ⚠️ GRÄNSEN, UTSKRIVEN. Hashen täcker PROSAN. `{PLATFORM_COMPANY.brandName}`
 * och andra interpolationer strippas — ändras ett värde där ändras den
 * renderade texten utan att hashen märker det. Det är ett medvetet val:
 * alternativet vore att hasha bundlad output, vilket gör vakten beroende av ett
 * bygge. Interpolationerna bär namn och adresser, inte utfästelser.
 *
 * Lokalt:      node scripts/check-legal-text-version.mjs
 * Nya hashar:  node scripts/check-legal-text-version.mjs --print
 * Självtest:   node scripts/check-legal-text-version.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutComments, kanariefåglar } from './lib/source-scan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM = join(ROOT, 'packages', 'shared', 'src', 'constants', 'platform.ts')

/**
 * Ett dokument = en version = flera renderade sidor.
 *
 * Versionen är per DOKUMENT, inte per app: `CURRENT_TERMS_VERSION` gäller
 * villkoren oavsett var de visas. Hashen täcker därför webbens OCH portalens
 * text tillsammans — ändras endera måste dokumentets version bumpas.
 */
export const LEGAL_DOCUMENTS = {
  terms: ['apps/web/src/features/legal/TermsPage.tsx', 'apps/portal/src/pages/legal/TermsPage.tsx'],
  privacy: [
    'apps/web/src/features/legal/PrivacyPage.tsx',
    'apps/portal/src/pages/legal/PrivacyPage.tsx',
  ],
  cookies: [
    'apps/web/src/features/legal/CookiesPage.tsx',
    'apps/portal/src/pages/legal/CookiesPage.tsx',
  ],
}

/**
 * Den renderade prosan, normaliserad.
 *
 * ── VARFÖR TEXTNODER OCH INTE KLAMMERSTRIPPNING ──────────────────────────────
 *
 * Första försöket tog bort alla `{...}`-grupper med klammermatchning och sedan
 * taggarna. Det gick BLINT: komponentens egen funktionskropp är också en
 * klammergrupp, så djupet var ≥ 1 genom hela JSX:en och ALL prosa ströks.
 * Kanariefågeln nedan fällde det direkt — 15 av 15 rubriker försvann — vilket är
 * precis vad den finns för. Utan den hade tomma strängar hashats till tre snygga
 * sha256:or och vakten hade varit grön om ingenting.
 *
 * Formen nu: plocka ut JSX:ens TEXTNODER, alltså det som står mellan `>` och
 * nästa `<` utan klammer eller vinkelparenteser i sig. Det fångar prosan och
 * bara prosan — attribut ligger inuti taggen, kod ligger inuti klammer, och
 * interpolationer utesluts av att de innehåller `{`.
 *
 * Blanktecken normaliseras SIST, så hashen överlever att Prettier bryter om
 * raderna. Det är skillnaden mellan att mäta innehåll och att mäta formatering.
 */
export function renderedProse(source) {
  const kod = withoutComments(source)
  const noder = [...kod.matchAll(/>([^<>{}]+)</g)].map((m) => m[1])
  return noder.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Avsnittsrubrikerna, HÄRLEDDA UR KÄLLAN. Kanariefågelns mätobjekt — se R4.
 * Matchar `<h2 id="sec-N">Rubrik</h2>` med ren text i.
 */
export function sectionTitles(source) {
  return [...source.matchAll(/<h2[^>]*>([^<{]+)<\/h2>/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
}

/** sha256 över den normaliserade prosan för dokumentets alla sidor. */
export function documentHash(filer, läs) {
  const h = createHash('sha256')
  for (const f of filer) h.update(renderedProse(läs(f))).update('\n')
  return h.digest('hex')
}

/** Läs ett objekt-literalfält ur platform.ts utan att köra TypeScript. */
export function parseVersions(text) {
  const m = /export const LEGAL_DOCUMENT_VERSIONS = \{([\s\S]*?)\} as const/.exec(text)
  if (!m) return null
  return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]]))
}

export function parseHashes(text) {
  const m = /export const LEGAL_DOCUMENT_HASHES = \{([\s\S]*?)\n\} as const/.exec(text)
  if (!m) return null
  return Object.fromEntries(
    [...m[1].matchAll(/(\w+):\s*\{\s*version:\s*'([^']+)',\s*sha256:\s*'([a-f0-9]{64})'\s*\}/g)].map(
      (x) => [x[1], { version: x[2], sha256: x[3] }],
    ),
  )
}

export function parseHistory(text) {
  const m = /export const LEGAL_DOCUMENT_VERSION_HISTORY = \[([\s\S]*?)\] as const/.exec(text)
  if (!m) return []
  return [...m[1].matchAll(/\{\s*doc:\s*'(\w+)',\s*version:\s*'([^']+)'/g)].map((x) => ({
    doc: x[1],
    version: x[2],
  }))
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ platformText, dokument, läs, finns = (f) => existsSync(join(ROOT, f)) }) {
  const problem = []
  const versions = parseVersions(platformText)
  const hashes = parseHashes(platformText)
  const history = parseHistory(platformText)

  if (!versions) {
    problem.push({ rule: 'LEGAL_DOCUMENT_VERSIONS går inte att läsa', detail: 'Skanningen har gått blind.' })
    return problem
  }
  if (!hashes) {
    problem.push({ rule: 'LEGAL_DOCUMENT_HASHES saknas', detail: 'Utan manifest finns ingen koppling mellan text och version.' })
    return problem
  }

  // Rostret: varje dokument i koden måste ha en post, och tvärtom.
  for (const doc of Object.keys(dokument)) {
    if (!hashes[doc]) problem.push({ rule: `${doc} saknas i LEGAL_DOCUMENT_HASHES`, detail: 'Ett dokument utan hash är obevakat.' })
    if (!versions[doc]) problem.push({ rule: `${doc} saknas i LEGAL_DOCUMENT_VERSIONS`, detail: 'Ingen version att jämföra mot.' })
  }
  for (const doc of Object.keys(hashes)) {
    if (!dokument[doc]) problem.push({ rule: `LEGAL_DOCUMENT_HASHES listar okänt dokument \`${doc}\``, detail: 'Manifestet har blivit stale.' })
  }

  for (const [doc, filer] of Object.entries(dokument)) {
    const post = hashes[doc]
    if (!post) continue

    for (const f of filer) {
      if (!finns(f)) {
        problem.push({ rule: `${doc}: filen ${f} finns inte`, detail: 'Uppräkningen pekar på något som flyttats — vakten mäter då mindre än den tror.' })
      }
    }

    // ── R4 — KANARIEFÅGELN, före hashen ────────────────────────────────────
    //
    // Rubrikerna härleds ur källan. Går extraheringen blind försvinner de, och
    // då är en hashavvikelse inte informativ — den säger bara att texten är
    // annorlunda, inte att skanningen slutat läsa.
    for (const f of filer) {
      const källa = läs(f)
      const rubriker = sectionTitles(källa)
      const prosa = renderedProse(källa)
      const saknade = rubriker.filter((r) => !prosa.includes(r))
      if (rubriker.length === 0) {
        problem.push({ rule: `${f}: NOLL avsnittsrubriker hittades`, detail: 'En juridisk sida utan rubriker betyder att skanningen inte läser filen.' })
      } else if (saknade.length > 0) {
        problem.push({
          rule: `${f}: ${saknade.length} av ${rubriker.length} rubriker saknas i den extraherade texten`,
          detail: `Extraheringen har gått blind. Först saknade: "${saknade[0]}".`,
        })
      }
    }

    // ── R1 — hashen ────────────────────────────────────────────────────────
    const faktisk = documentHash(filer, läs)
    if (faktisk !== post.sha256) {
      problem.push({
        rule: `${doc}: texten har ändrats men LEGAL_DOCUMENT_HASHES.${doc} är oförändrad`,
        detail:
          `Faktisk hash: ${faktisk}\n   ` +
          `Är ändringen MATERIELL (se regeln i platform.ts)? Bumpa då ${doc}-versionen, ` +
          `flytta den gamla posten till LEGAL_DOCUMENT_VERSION_HISTORY och skriv in hashen ovan. ` +
          `Är den redaktionell räcker det att skriva in hashen — men läs regeln först.`,
      })
    }

    // ── R2 — manifest och version får inte glida isär ──────────────────────
    if (post.version !== versions[doc]) {
      problem.push({
        rule: `${doc}: manifestets version (${post.version}) ≠ LEGAL_DOCUMENT_VERSIONS.${doc} (${versions[doc]})`,
        detail: 'De två beskriver samma sak och måste ändras tillsammans.',
      })
    }

    // ── R3 — ett förbrukat versionsnummer får aldrig återanvändas ──────────
    if (history.some((h) => h.doc === doc && h.version === versions[doc])) {
      problem.push({
        rule: `${doc}: version ${versions[doc]} är redan pensionerad i LEGAL_DOCUMENT_VERSION_HISTORY`,
        detail:
          'Ett versionsnummer som en gång bundits till en text kan aldrig betyda en annan text. ' +
          'Det är den regeln som gör bumpen obligatorisk i stället för frivillig.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const H_A = 'a'.repeat(64)
const FIXTUR_SIDA = `
/** doc-kommentar som INTE ska hashas */
export function Sida() {
  return (
    <Shell version={CURRENT_TERMS_VERSION}>
      <h2 id="sec-1">1. Rubrik ett</h2>
      <p>Prosa som räknas. Länk: <a href="https://exempel.se/a//b">exempel</a></p>
      {/* JSX-kommentar som INTE ska hashas */}
      <h2 id="sec-2">2. Rubrik två</h2>
      <p>Mer prosa.</p>
    </Shell>
  )
}
`
const plattform = (v, h, hist = '') => `
export const LEGAL_DOCUMENT_VERSIONS = {
  terms: '${v}',
} as const
export const LEGAL_DOCUMENT_HASHES = {
  terms: { version: '${v}', sha256: '${h}' },
} as const
export const LEGAL_DOCUMENT_VERSION_HISTORY = [${hist}] as const
`

function selfTest() {
  let ok = true
  const fail = (m) => { ok = false; console.error(`❌ ${m}`) }
  const grön = (label, r) => (r.length === 0 ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r[0].rule}`))
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }
  const läsFixtur = () => FIXTUR_SIDA
  const dok = { terms: ['fixtur.tsx'] }
  const finns = () => true // fixturen bor i minnet, inte på disk
  const hFixtur = documentHash(['fixtur.tsx'], läsFixtur)

  // ── KANARIEFÅGEL 1: mot den RIKTIGA källan, med SOURCE-HÄRLEDDA tal ───────
  //
  // Inte "fler än noll": varje rubrik som finns i filen måste finnas i den
  // extraherade texten, och antalet skrivs ut. Går extraheringen blind syns det
  // som ett tal, inte som tystnad.
  const läsRiktig = (f) => readFileSync(join(ROOT, f), 'utf8')
  for (const [doc, filer] of Object.entries(LEGAL_DOCUMENTS)) {
    for (const f of filer) {
      const källa = läsRiktig(f)
      const rubriker = sectionTitles(källa)
      const prosa = renderedProse(källa)
      const träffar = rubriker.filter((r) => prosa.includes(r)).length
      if (rubriker.length === 0) fail(`kanariefågel: NOLL rubriker i ${f}`)
      else if (träffar !== rubriker.length) fail(`kanariefågel: ${f} — ${träffar} av ${rubriker.length} rubriker överlevde extraheringen`)
      else console.log(`✅ kanariefågel: ${doc}/${f.split('/')[1]} — ${träffar} av ${rubriker.length} rubriker överlevde, ${prosa.length} tecken prosa`)
    }
  }

  // ── KANARIEFÅGEL 1b: hashen är okänslig för FORMATERING, känslig för INNEHÅLL ──
  const omformaterad = FIXTUR_SIDA.replace(/\n\s+/g, '\n      ').replace(/<p>/g, '<p>\n        ')
  const hOmformaterad = documentHash(['x'], () => omformaterad)
  const hÄndrad = documentHash(['x'], () => FIXTUR_SIDA.replace('Mer prosa.', 'Mer prosa, med ett tillägg.'))
  if (hOmformaterad !== hFixtur) fail('kanariefågel 1b: omformatering ändrade hashen — vakten mäter formatering, inte innehåll')
  else if (hÄndrad === hFixtur) fail('kanariefågel 1b: ändrad prosa gav SAMMA hash — vakten mäter ingenting')
  else console.log('✅ kanariefågel 1b: omformatering ⇒ samma hash, ändrad prosa ⇒ annan hash')

  // ── FÖRBEHANDLINGEN: `//` i en URL får inte äta resten av filen (#567) ────
  if (!renderedProse(FIXTUR_SIDA).includes('Rubrik två')) {
    fail('kanariefågel: `//` i en URL svalde resten av filen — förbehandlaren är blind')
  } else console.log('✅ kanariefågel: `//` i en URL bryter inte extraheringen')

  grön('paritet', evaluate({ platformText: plattform('1.0', hFixtur), dokument: dok, läs: läsFixtur, finns }))

  röd(
    'texten ändrad utan att manifestet uppdaterats',
    evaluate({ platformText: plattform('1.0', H_A), dokument: dok, läs: läsFixtur, finns }),
    'texten har ändrats',
  )
  röd(
    'manifestets version glider från LEGAL_DOCUMENT_VERSIONS',
    evaluate({
      platformText: plattform('1.0', hFixtur).replace("terms: { version: '1.0'", "terms: { version: '0.9'"),
      dokument: dok,
      läs: läsFixtur,
      finns,
    }),
    'manifestets version',
  )
  röd(
    'versionen återanvänder ett pensionerat nummer',
    evaluate({ platformText: plattform('1.0', hFixtur, "{ doc: 'terms', version: '1.0' }"), dokument: dok, läs: läsFixtur, finns }),
    'redan pensionerad',
  )
  röd(
    'extraheringen blind (rubriker försvinner)',
    evaluate({ platformText: plattform('1.0', hFixtur), dokument: dok, läs: () => FIXTUR_SIDA.replace(/<p>[\s\S]*?<\/p>/g, ''), finns }),
    'texten har ändrats',
  )

  // ── NK2 I SJÄLVTESTET: bump UTAN textändring ska INTE fälla ──────────────
  //
  // Det är en giltig handling — en rättelse av en tidigare missad bump, precis
  // det den här PR:en gör. Historiken bär den GAMLA versionen, inte den nya.
  grön(
    'versionen bumpad utan att texten rörts (rättelse av missad bump)',
    evaluate({ platformText: plattform('1.1', hFixtur, "{ doc: 'terms', version: '1.0' }"), dokument: dok, läs: läsFixtur, finns }),
  )

  for (const f of kanariefåglar()) { ok = false; console.error(`❌ delad källskanner: ${f}`) }
  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const läs = (f) => readFileSync(join(ROOT, f), 'utf8')

  if (process.argv.includes('--print')) {
    for (const [doc, filer] of Object.entries(LEGAL_DOCUMENTS)) {
      console.log(`${doc}: ${documentHash(filer, läs)}`)
    }
    return
  }

  const problem = evaluate({ platformText: readFileSync(PLATFORM, 'utf8'), dokument: LEGAL_DOCUMENTS, läs })
  if (problem.length > 0) {
    console.error('\n=== JURIDISK TEXT OCH VERSION HAR GLIDIT ISÄR (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: en juridisk text som ändras utan att versionen följer med gör att ett\n' +
        'versionsnummer betecknar två olika texter — och då går frågan "vad accepterade\n' +
        'kunden" inte att besvara. Se #577.\n',
    )
    process.exit(1)
  }
  const v = parseVersions(readFileSync(PLATFORM, 'utf8'))
  console.log(
    `✅ juridisk text och version i synk; ${Object.keys(LEGAL_DOCUMENTS).length} dokument ` +
      `(${Object.entries(v).map(([d, x]) => `${d} ${x}`).join(', ')}).`,
  )
}

main()
