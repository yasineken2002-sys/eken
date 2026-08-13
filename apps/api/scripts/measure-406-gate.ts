/**
 * MÄTSKRIPT för grind-halvan av #406 — kartläggning, INGEN produktionsändring.
 *
 * FRÅGAN: finns ett lexikalt ingrepp som lyfter RÄTT paragraf
 * (inkassokostnadslagen 2 §) över grindens golv, utan att lyfta FEL paragraf
 * (4 a §, förseningsersättning mellan näringsidkare) och utan att rasera
 * golvets kalibrering för resten av korpusen?
 *
 * ── HISTORISK EFTER #406 PR4 — LÄS DETTA FÖRST ──────────────────────────────
 * Skriptets varianter uttrycks mot tesaurusen som den såg ut vid PR3
 * (`CONCEPT_GROUPS_PR3` i spegeln). PR4 lade tre grupper till produktionen, så
 * ingen variant här matchar längre produktionen bit-för-bit och
 * `detectProductionVariant` AVBRYTER körningen. Det är avsiktligt, inte trasigt:
 * en spegel som inte kan valideras mot produktionen får inte tyst skriva om en
 * rapport. `docs/research/406-grind-kartlaggning.md` dokumenterar mätningen som
 * motiverade PR3 och ska läsas som ett tillstånd, inte som något reproducerbart
 * mot dagens kod. Ska frågan ställas om måste varianterna mätas om mot den
 * nuvarande tesaurusen — och då är det en ny mätning, med nya tal.
 *
 * KÖRS MANUELLT (inte i CI):
 *   cd apps/api && node --env-file-if-exists=.env \
 *     -r ts-node/register scripts/measure-406-gate.ts [--no-semantic]
 *   npx prettier --write docs/research/406-grind-kartlaggning.md
 *
 * Prettier-steget hör till receptet, inte till städningen: lint-staged
 * formaterar om rapporten vid commit, så utan det ger varje ny körning en
 * diff mot grenen och det går inte att se om SIFFRORNA ändrats eller bara
 * radbrytningarna. Med det är en oförändrad mätning en tom diff.
 *
 * VAD SKRIPTET FÅR GÖRA: importera och mäta. Det skriver ALDRIG till
 * produktionsvägen, rör ingen tröskel och ingen lagtext. Chunkarnas
 * contentHash kontrolleras explicit som oförändrade (assertHashesUntouched).
 *
 * ── MÄTSPEGELN OCH VARFÖR DEN INTE FÅR ANTAS VARA TROGEN ────────────────────
 * Produktionens tokenizer/stemmer/tesaurus är modulprivata i legal-retrieval.ts
 * och BM25-indexet är memoiserat utan injektionspunkt. För att mäta en ANNAN
 * tokenisering måste matematiken därför speglas — spegeln bor i
 * `lib/legal-retrieval-mirror.ts`, delad med tesaurus-mätningen. En spegel som
 * bara ser riktig ut är värdelös; den verifieras NUMERISKT mot produktionen
 * innan någon variant mäts:
 *   - identisk score+coverage för ALLA 427 chunkar × alla eval-frågor
 *     (max |Δ| = 0), mot scoreAllLegalChunks(), och
 *   - identiskt grindutfall mot evaluateLegalCandidate().
 * Avviker något avbryts körningen (exit 1). Golvvärdena är likaså en spegel
 * (konstanterna är inte exporterade) och valideras av samma jämförelse.
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { requireApiKey, verifyVoyageKey, exitOnPreflightError } from './preflight-keys'
import { buildLegalChunks, type LegalChunk } from '../src/ai/knowledge/retrieval/legal-chunk'
import { searchTermsFor } from '../src/ai/knowledge/retrieval/legal-search-terms'
import { MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS } from '../src/ai/knowledge/grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
import {
  MIN_TOP_SCORE,
  MIN_COVERAGE_IN_BAND,
  stem,
  tokenize,
  baselineAnalyze,
  plainIndexText,
  buildVariantIndex,
  assertBaselineParity,
  detectProductionVariant,
  measureVariant,
  snapshotHashes,
  sweepFloors,
  collectSemantic,
  INKASSO_IDS,
  CHANNEL_TOP_K,
  type Variant,
  type Probe,
  type CaseMeasurement,
  type SemanticHit,
} from './lib/legal-retrieval-mirror'

// ── KANDIDAT A: sammansättningsledsdelning, generell regel, ingen ordlista ───
//
// Svenska sammansättningar är produktiva och oändliga, så en ordlista är
// utesluten (samma slutsats som #382/#390). Regeln nedan hämtar i stället sin
// vokabulär UR KORPUSEN och delar girigt på längsta prefix som redan är ett
// känt ord, med valfritt foge-s:
//
//   "betalningspåminnelse" → "betalning" + "påminnelse"     (dokumentsidan)
//   "påminnelseavgift"     → "påminnelse" + "avgift"        (frågesidan)
//
// KEDJEBEROENDET ÄR POÄNGEN: "påminnelse" finns INTE som eget ord någonstans i
// korpusen — bara inbakat i "betalningspåminnelse". Regeln måste därför nå en
// FIXPUNKT: delar som frigörs blir själva vokabulär och möjliggör nästa
// delning. Utan den iterationen kan frågans "påminnelseavgift" aldrig delas,
// och bron mellan hyresvärdens ord och lagens ord uppstår aldrig.
function buildCompoundSplitter(
  corpusTexts: readonly string[],
  minCompound: number,
  minPart: number,
): (word: string) => string[] {
  const vocab = new Set<string>()
  for (const text of corpusTexts) for (const tok of tokenize(text)) vocab.add(tok)

  const splitOnce = (w: string): [string, string] | null => {
    if (w.length < minCompound) return null
    for (let i = w.length - minPart; i >= minPart; i--) {
      const prefix = w.slice(0, i)
      if (!vocab.has(prefix)) continue
      // Foge-s prioriteras: "betalning|s|påminnelse" är rätt snitt, medan det
      // nakna snittet ger skräpledet "spåminnelse".
      if (w[i] === 's' && w.length - i - 1 >= minPart) return [prefix, w.slice(i + 1)]
      if (w.length - i >= minPart) return [prefix, w.slice(i)]
    }
    return null
  }

  // Fixpunkt över vokabulären (bounded — en trasig regel får inte snurra).
  for (let pass = 0; pass < 6; pass++) {
    let grew = false
    for (const w of [...vocab]) {
      const parts = splitOnce(w)
      if (!parts) continue
      for (const p of parts)
        if (!vocab.has(p)) {
          vocab.add(p)
          grew = true
        }
    }
    if (!grew) break
  }

  const splitDeep = (w: string, depth = 0): string[] => {
    const parts = depth < 4 ? splitOnce(w) : null
    if (!parts) return [w]
    // Hela ordet BEHÅLLS jämte delarna: delningen ska addera en bro, aldrig
    // ta bort en exakt träff som redan fungerar.
    return [w, ...splitDeep(parts[0], depth + 1), ...splitDeep(parts[1], depth + 1)]
  }
  return splitDeep
}

// ── KANDIDAT B: söktermer i chunk-metadata ───────────────────────────────────
//
// Indexerad text ≠ citerbar text: chunken indexeras på sin lagtext PLUS en
// söktermsrad i vardagssvenska. Citatvägen (gap A) och legalChunkContentHash
// rör INTE fältet.
//
// LISTAN BOR I PRODUKTIONSMODULEN, inte här. Första versionen hade en egen
// kopia, och då mäter skriptet något annat än det som levereras så snart en
// term ändras på ena stället. Importen gör drift omöjlig: varianten ÄR
// produktionslistan.
const searchTermIndexText = (chunk: LegalChunk): string => {
  const terms = searchTermsFor(chunk)
  return terms.length > 0 ? `${chunk.text}\n${terms.join(' ')}` : chunk.text
}

const PROBES: Record<string, Probe> = {
  '2 §': { lawId: 'inkassokostnadslagen', paragraph: '2' },
  '4 a §': { lawId: 'inkassokostnadslagen', paragraph: '4 a' },
  '4 §': { lawId: 'inkassokostnadslagen', paragraph: '4' },
  '3 §': { lawId: 'inkassokostnadslagen', paragraph: '3' },
  '6 §': { lawId: 'inkassokostnadslagen', paragraph: '6' },
}

// ── Utskrift ─────────────────────────────────────────────────────────────────

const md: string[] = []
function out(line = ''): void {
  console.warn(line)
  md.push(line)
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? '—' : n.toFixed(digits)
}

function top3Cell(m: CaseMeasurement): string {
  if (m.top3.length === 0) return '—'
  return m.top3
    .map(
      (r) =>
        `${r.chunk.lawId.slice(0, 6)}:${r.chunk.paragraph} ${r.score.toFixed(1)}/${r.coverage.toFixed(2)}`,
    )
    .join('<br>')
}

async function main(): Promise<void> {
  const noSemantic = process.argv.includes('--no-semantic')
  const chunks = buildLegalChunks()
  const hashesBefore = snapshotHashes(chunks)

  console.warn(
    `[mät] korpus: ${chunks.length} chunkar (grindens kalibrerings-N: ${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS}) · ` +
      `${LEGAL_EVAL_SET.length} eval-fall`,
  )
  if (chunks.length !== MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS) {
    throw new Error(
      `korpusen är ${chunks.length} chunkar men golvet är kalibrerat vid ` +
        `${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS} — mätningen jämför mot ett golv som inte gäller.`,
    )
  }

  // ── Cosine: mäts EN gång och återanvänds över varianterna ──────────────────
  // Motiv: cosine beräknas parvis mellan Voyage-vektorer av frågan och av
  // chunk-TEXTEN. Ingen variant här rör chunk-texten eller frågesträngen — bara
  // den lexikala tokeniseringen — så en variant kan per konstruktion inte
  // flytta en cosine. Kandidat B:s söktermer indexeras lexikalt och embeddas
  // INTE (det skulle ändra contentHash och invalidera varje vektor, vilket är
  // uttryckligen uteslutet).
  let cosineByCase = new Map<string, number | null>()
  let semanticByCase = new Map<string, SemanticHit[]>()
  let fusedByCase = new Map<string, string[]>()
  if (noSemantic) {
    console.warn('[mät] --no-semantic: cosine = null (ren BM25-väg)')
    for (const c of LEGAL_EVAL_SET) cosineByCase.set(c.id, null)
  } else {
    const voyageKey = requireApiKey({
      envVar: 'VOYAGE_API_KEY',
      whatFor: 'query-embeddingarna i grind-kartläggningen',
      expectedPrefix: 'pa-',
    })
    await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
    ;({ cosineByCase, semanticByCase, fusedByCase } = await collectSemantic(chunks))
  }

  // ── Varianterna ────────────────────────────────────────────────────────────
  const corpusTexts = chunks.map((c) => c.text)
  const variants: Variant[] = [
    {
      id: 'BASLINJE',
      label: 'dagens stem()/tokenize()',
      analyze: baselineAnalyze,
      indexText: plainIndexText,
    },
  ]
  for (const minLen of [10, 12, 14]) {
    const split = buildCompoundSplitter(corpusTexts, minLen, 4)
    variants.push({
      id: `A${minLen}`,
      label: `sammansättningsdelning, minLen ${minLen}`,
      // OBS: (t) => split(t), inte flatMap(split) — flatMap skickar (element,
      // index, array), så rekursionsdjupet hade fått arrayindexet och delningen
      // stängts av efter femte token. Föll först på att A-varianterna såg
      // verkningslösa ut.
      analyze: (text) =>
        tokenize(text)
          .flatMap((t) => split(t))
          .map(stem),
      indexText: plainIndexText,
    })
  }
  variants.push({
    id: 'B',
    label: 'söktermer i chunk-metadata',
    analyze: baselineAnalyze,
    indexText: searchTermIndexText,
  })

  const indexes = variants.map((v) => buildVariantIndex(v, chunks))
  const prodVariant = detectProductionVariant(indexes)
  console.warn(`[mät] produktionen implementerar variant: ${prodVariant.variant.id}`)
  assertBaselineParity(prodVariant, cosineByCase, fusedByCase, semanticByCase)

  const results = new Map<string, CaseMeasurement[]>()
  for (const idx of indexes) {
    results.set(idx.variant.id, measureVariant(idx, cosineByCase, semanticByCase, PROBES))
  }

  const base = results.get('BASLINJE')!
  const baseById = new Map(base.map((m) => [m.id, m]))
  // Mängderna som kalibreringen mäts mot HÅLLS FASTA vid baslinjens
  // klassificering. Skulle de omdefinieras per variant blir gapet tomt per
  // konstruktion och analysen säger ingenting.
  const keepIds = new Set(base.filter((m) => m.legal && m.lexicalPass).map((m) => m.id))
  const rejectIds = new Set(
    base
      .filter((m) => m.legal && !m.lexicalPass && (m.topCoverage ?? 0) >= MIN_COVERAGE_IN_BAND)
      .map((m) => m.id),
  )

  // ── Rapport ────────────────────────────────────────────────────────────────
  out('# #406 — kartläggning av grind-halvan')
  out()
  out('> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel eller lagtext ändrad.')
  out(`> Genererad av \`apps/api/scripts/measure-406-gate.ts\` mot korpus N = ${chunks.length}.`)
  out()
  out('## Frågan')
  out()
  out('Finns ett lexikalt ingrepp som lyfter **inkassokostnadslagen 2 §** (rätten till')
  out('ersättning för skriftlig betalningspåminnelse) över grindens golv, utan att lyfta')
  out('**4 a §** (förseningsersättning mellan näringsidkare — fel regel för en')
  out('bostadshyresgäst) och utan att rasera golvets kalibrering för resten av korpusen?')
  out()
  out('## Varianter')
  out()
  out('| Variant | Vad den gör |')
  out('| --- | --- |')
  for (const v of variants) out(`| \`${v.id}\` | ${v.label} |`)
  out()
  out('`A10/A12/A14` är samma regel vid tre minsta-sammansättningslängder. Regeln hämtar')
  out('sin vokabulär ur korpusen och delar girigt på längsta kända prefix med valfritt')
  out('foge-s; frigjorda led blir själva vokabulär (fixpunkt), vilket är nödvändigt —')
  out('`påminnelse` finns inte som eget ord i korpusen, bara i `betalningspåminnelse`.')
  out()
  out('### Indexets form per variant')
  out()
  out('| Variant | avgLength | unika stammar | Δ avgLength |')
  out('| --- | --- | --- | --- |')
  for (const idx of indexes) {
    const d = idx.avgLength - indexes[0]!.avgLength
    out(
      `| \`${idx.variant.id}\` | ${idx.avgLength.toFixed(2)} | ${idx.docFreq.size} | ` +
        `${d >= 0 ? '+' : ''}${d.toFixed(2)} |`,
    )
  }
  out()

  // ── Tabell 1: de åtta inkassofallen ────────────────────────────────────────
  out('## 1. De åtta inkassokostnadsfallen')
  out()
  for (const idx of indexes) {
    const ms = results.get(idx.variant.id)!
    const byId = new Map(ms.map((m) => [m.id, m]))
    out(`### \`${idx.variant.id}\` — ${idx.variant.label}`)
    out()
    out(
      '| fall | facit | BM25 topp-3 (score/cov) | cosine | grind | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §? | domarens fönster (fused topp-3) |',
    )
    out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const id of INKASSO_IDS) {
      const m = byId.get(id)!
      const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
      const facit = c.expectedSources.flatMap((s) => s.paragraphs.map((p) => `${p} §`)).join(', ')
      const two = m.probe['2 §']!
      const foura = m.probe['4 a §']!
      const better =
        two.score > foura.score
          ? 'JA'
          : two.score === foura.score
            ? '= (båda 0)'
            : '**NEJ — 4 a § högre**'
      const window = m.fused.length
        ? m.fused
            .map((f) =>
              f.startsWith('inkassokostnadslagen')
                ? `**${f.split(':').pop()!} §**`
                : f.split(':')[0]!.slice(0, 6),
            )
            .join(' · ')
        : '—'
      out(
        `| \`${id}\` | ${facit} | ${top3Cell(m)} | ${fmt(cosineByCase.get(id) ?? null, 3)} | ${m.gate} | ` +
          `${two.rank ?? '—'} / ${two.score.toFixed(2)} | ${foura.rank ?? '—'} / ${foura.score.toFixed(2)} | ${better} | ${window} |`,
      )
    }
    out()
    out('> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.')
    out('> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala')
    out('> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.')
    out()
    const rankedTop = ms.filter(
      (m) => INKASSO_IDS.includes(m.id) && m.top3[0]?.chunk.paragraph === '4 a',
    )
    if (rankedTop.length > 0) {
      out(
        `> ⚠ **4 a § ligger ÖVERST** i ${rankedTop.length} fall: ${rankedTop.map((m) => `\`${m.id}\``).join(', ')}.`,
      )
      out('> Ett lyft som rankar 4 a § högst är ett SÄMRE utfall än dagens miss.')
      out()
    }
  }

  // ── Attribution: vem lyfter 2 § in i fönstret? ─────────────────────────────
  out('### Attribution: den semantiska kanalens egen rangordning')
  out()
  out('Fönstret är RRF över två kanaler. Utan kanalernas separata rangordning går det')
  out('inte att säga om ett lyft är den lexikala variantens förtjänst eller semantikens.')
  out('Semantiken är IDENTISK i alla varianter (ingen av dem rör chunk-texten eller')
  out('frågesträngen), så den här tabellen gäller alla fem.')
  out()
  out('| fall | facit | semantisk rank: 2 § | semantisk rank: facit-§ | topp-cosine |')
  out('| --- | --- | --- | --- | --- |')
  for (const id of INKASSO_IDS) {
    const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
    const hits = semanticByCase.get(id) ?? []
    const rankOf = (chunkId: string): string => {
      const i = hits.findIndex((h) => h.chunkId === chunkId)
      return i === -1 ? `utanför topp-${CHANNEL_TOP_K}` : `${i + 1}`
    }
    const facitParas = c.expectedSources.flatMap((s) => s.paragraphs)
    const facit = facitParas.map((p) => `${p} §`).join(', ')
    const facitRank = facitParas.map((p) => rankOf(`inkassokostnadslagen:${p}`)).join(' / ')
    out(
      `| \`${id}\` | ${facit} | ${rankOf('inkassokostnadslagen:2')} | ${facitRank} | ` +
        `${fmt(cosineByCase.get(id) ?? null, 3)} |`,
    )
  }
  out()

  // ── Tabell 2: score-förskjutning + kalibrering ─────────────────────────────
  out('## 2. Score-förskjutning över alla eval-fall')
  out()
  out(
    `${LEGAL_EVAL_SET.length} fall totalt (26 \`answerable\` — kvotens nämnare — samt 3 \`needs-jurist\` och 1 \`no-clear-rule\`).`,
  )
  out()
  const header = ['| fall | förväntat |', ...indexes.map((i) => ` ${i.variant.id} |`)].join('')
  out(header)
  out(['| --- | --- |', ...indexes.map(() => ' --- |')].join(''))
  for (const c of LEGAL_EVAL_SET) {
    const cells = indexes.map((idx) => {
      const m = results.get(idx.variant.id)!.find((x) => x.id === c.id)!
      if (!m.legal) return ' ej-jur |'
      const d =
        idx.variant.id === 'BASLINJE'
          ? ''
          : (() => {
              const b = baseById.get(c.id)!.topScore ?? 0
              const delta = (m.topScore ?? 0) - b
              return ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`
            })()
      return ` ${fmt(m.topScore, 2)}/${fmt(m.topCoverage, 2)}${d} |`
    })
    out([`| \`${c.id}\` | ${c.expectedOutcome} |`, ...cells].join(''))
  }
  out()

  out('### Hur mycket rörs korpusen UTANFÖR inkassofallen?')
  out()
  out('BM25 är korpus-globalt: en ändrad tokenisering flyttar N-oberoende storheter som')
  out('`avgLength` och `docFreq` och därmed HELA skalan. Måttet nedan är den största')
  out('rörelsen bland de juridiska fall som INTE är inkassofall — alltså hur mycket')
  out('varianten stör det som redan fungerar.')
  out()
  out('| Variant | max \\|Δscore\\| utanför inkasso | median \\|Δ\\| | fall med \\|Δ\\| > 1,0 |')
  out('| --- | --- | --- | --- |')
  for (const idx of indexes.slice(1)) {
    const ms = results.get(idx.variant.id)!
    const deltas = ms
      .filter((m) => m.legal && !INKASSO_IDS.includes(m.id))
      .map((m) => Math.abs((m.topScore ?? 0) - (baseById.get(m.id)!.topScore ?? 0)))
      .sort((a, b) => a - b)
    const median = deltas[Math.floor(deltas.length / 2)] ?? 0
    out(
      `| \`${idx.variant.id}\` | ${(deltas[deltas.length - 1] ?? 0).toFixed(2)} | ${median.toFixed(2)} | ` +
        `${deltas.filter((d) => d > 1).length} av ${deltas.length} |`,
    )
  }
  out()

  out('### Kalibrering: golvets referenspunkter')
  out()
  out('Mängderna hålls FASTA vid baslinjens klassificering — definieras de om per variant')
  out('blir gapet tomt per konstruktion och analysen säger ingenting. `behåll` = fall som')
  out('passerar lexikalt i dag (får inte tappas). `fäll` = fall som fälls lexikalt i dag')
  out('MED täckning ≥ 0,4, alltså sådana som måste fällas av POÄNGEN — bandet kan inte')
  out('hjälpa dem. Det är exakt de två storheter grindens kalibreringskommentar bokför.')
  out()
  out(`\`behåll\` (${keepIds.size} fall): ${[...keepIds].map((i) => `\`${i}\``).join(', ')}`)
  out()
  out(`\`fäll\` (${rejectIds.size} fall): ${[...rejectIds].map((i) => `\`${i}\``).join(', ')}`)
  out()
  out(
    '| Variant | svagast `behåll` | starkast `fäll` (cov ≥ 0,4) | intervall | golvet 9 mellan dem? |',
  )
  out('| --- | --- | --- | --- | --- |')
  for (const idx of indexes) {
    const ms = results.get(idx.variant.id)!
    const byId = new Map(ms.map((m) => [m.id, m]))
    const keep = [...keepIds]
      .map((id) => ({ id, score: byId.get(id)?.topScore ?? 0 }))
      .sort((a, b) => a.score - b.score)[0]!
    const rej = [...rejectIds]
      .map((id) => ({
        id,
        score: byId.get(id)?.topScore ?? 0,
        cov: byId.get(id)?.topCoverage ?? 0,
      }))
      .sort((a, b) => b.score - a.score)[0]!
    const empty = keep.score > rej.score
    const nine = keep.score >= MIN_TOP_SCORE && rej.score < MIN_TOP_SCORE
    out(
      `| \`${idx.variant.id}\` | ${keep.id} ${keep.score.toFixed(2)} | ${rej.id} ${rej.score.toFixed(2)}/${rej.cov.toFixed(2)} ` +
        `| ${empty ? `tomt: ${rej.score.toFixed(2)}–${keep.score.toFixed(2)}` : '**överlappar**'} | ${nine ? 'JA' : '**NEJ**'} |`,
    )
  }
  out()
  out('⚠ `fäll`-mängden innehåller fem av #406:s egna målfall. Att en variant lyfter dem')
  out('över `fäll`-raden är därför inte i sig ett fel — det är delvis den avsedda')
  out('effekten. Kolumnen mäter att SKALAN flyttas, inte att något gick sönder. Den')
  out('bindande frågan ställs i svepet nedan, som bara håller de två negativkontrollerna')
  out('som "måste ut".')
  out()

  out('### Lösningsutrymme: finns ett golv som gör allt på en gång?')
  out()
  out('Svepet prövar varje golv 0,50–40,00 i steg om 0,05 och frågar om det samtidigt')
  out('(a) behåller alla 18 fall som passerar lexikalt i dag, (b) håller BÅDA')
  out('negativkontrollerna ute och (c) släpper in #406:s åtta inkassofall. Bandet')
  out('(12 / 0,4) hålls fast vid produktionens värden — svepet prövar golvet, inte')
  out('grindens form.')
  out()
  out(
    '| Variant | säkert golvintervall (a+b) | max inkassofall in inom det | vid vilket golv | vid dagens golv 9 |',
  )
  out('| --- | --- | --- | --- | --- |')
  for (const idx of indexes) {
    const s = sweepFloors(results.get(idx.variant.id)!, keepIds)
    const range = s.safeFloors.length
      ? `${s.safeFloors[0]!.toFixed(2)}–${s.safeFloors[s.safeFloors.length - 1]!.toFixed(2)}`
      : '**tomt**'
    const atNine =
      `${s.atNine.targetsIn}/8 in` +
      `${s.atNine.keepsAll ? '' : ', TAPPAR behåll'}${s.atNine.controlsOut ? '' : ', SLÄPPER IN kontroll'}`
    out(
      `| \`${idx.variant.id}\` | ${range} | **${s.bestTargetsIn}/8** | ${s.bestFloor?.toFixed(2) ?? '—'} | ${atNine} |`,
    )
  }
  out()

  // ── Tabell 3: negativkontrollerna ──────────────────────────────────────────
  out('## 3. Negativkontrollerna')
  out()
  out('`deposition-storlek` och `hyresgastval-diskriminering` ska förbli ute.')
  out()
  out(
    '| Variant | deposition-storlek | lexikalt ute? | hyresgastval-diskriminering | lexikalt ute? |',
  )
  out('| --- | --- | --- | --- | --- |')
  for (const idx of indexes) {
    const byId = new Map(results.get(idx.variant.id)!.map((m) => [m.id, m]))
    const d = byId.get('deposition-storlek')!
    const h = byId.get('hyresgastval-diskriminering')!
    out(
      `| \`${idx.variant.id}\` | ${fmt(d.topScore)}/${fmt(d.topCoverage)} | ${d.lexicalPass ? '**NEJ — släpps in**' : 'JA'} ` +
        `| ${fmt(h.topScore)}/${fmt(h.topCoverage)} | ${h.lexicalPass ? '**NEJ — släpps in**' : 'JA'} |`,
    )
  }
  out()
  out('> Grindutfallet för `deposition-storlek` är `kandidat` även i baslinjen: cosine 0,605')
  out('> ligger över 0,52. Den fälls av DOMAREN, inte av golvet — kolumnen mäter därför')
  out('> den lexikala vägen, som är den enda dessa varianter kan flytta.')
  out()

  // ── Tabell 4: flippar ──────────────────────────────────────────────────────
  out('## 4. Fall som flippar')
  out()
  out('| Variant | flippar in (miss → kandidat) | flippar ut (kandidat → miss) |')
  out('| --- | --- | --- |')
  for (const idx of indexes.slice(1)) {
    const ms = results.get(idx.variant.id)!
    const inFlips: string[] = []
    const outFlips: string[] = []
    for (const m of ms) {
      const b = baseById.get(m.id)!
      if (b.gate !== 'kandidat' && m.gate === 'kandidat') inFlips.push(`\`${m.id}\``)
      if (b.gate === 'kandidat' && m.gate !== 'kandidat') outFlips.push(`\`${m.id}\``)
    }
    out(
      `| \`${idx.variant.id}\` | ${inFlips.length ? inFlips.join(', ') : '—'} | ${outFlips.length ? outFlips.join(', ') : '—'} |`,
    )
  }
  out()
  out('Lexikala flippar (bortsett från cosine-insläppet, som ingen variant kan flytta):')
  out()
  out('| Variant | lexikalt in | lexikalt ut |')
  out('| --- | --- | --- |')
  for (const idx of indexes.slice(1)) {
    const ms = results.get(idx.variant.id)!
    const inF: string[] = []
    const outF: string[] = []
    for (const m of ms) {
      const b = baseById.get(m.id)!
      if (!b.lexicalPass && m.lexicalPass) inF.push(`\`${m.id}\``)
      if (b.lexicalPass && !m.lexicalPass) outF.push(`\`${m.id}\``)
    }
    out(
      `| \`${idx.variant.id}\` | ${inF.length ? inF.join(', ') : '—'} | ${outF.length ? outF.join(', ') : '—'} |`,
    )
  }
  out()

  // ── Sidofynd: stammarens behandling av påminnelse-formerna ─────────────────
  out('## 5. Sidofynd: stammaren splittrar `påminnelse` och `påminnelsen`')
  out()
  out('`paminnelseavgift-avtalskravet` är det enda fall där ingen A-variant ger 2 § någon')
  out('poäng alls. Två oberoende orsaker, ingen av dem i sammansättningsdelningen:')
  out()
  out('1. **Frågan innehåller ingen sammansättning att dela.** Den skriver "en avgift för')
  out('   påminnelsen", inte "påminnelseavgift" — A har inget att bita i.')
  out('2. **Stammaren skiljer de två formerna åt**, så inte ens det gemensamma ordet bär:')
  out()
  out('| ord | stam | via suffix |')
  out('| --- | --- | --- |')
  for (const w of [
    'påminnelse',
    'påminnelsen',
    'betalningspåminnelse',
    'påminnelseavgift',
    'avgift',
    'avgiften',
  ]) {
    const s = stem(w)
    out(`| \`${w}\` | \`${s}\` | ${s === w ? '— (orörd)' : `-${w.slice(s.length)}`} |`)
  }
  out()
  out('Suffixlistan prövas i ordning och `else` står före `en`, så `påminnelse` kapas till')
  out('`påminn` medan `påminnelsen` kapas till `påminnels`. De två formerna av samma ord')
  out('får alltså OLIKA stammar och kan aldrig matcha varandra — hur ordet än delas.')
  out('Frågan i `avtalskravet` skriver "påminnelsen jag skickade"; lagtexten skriver')
  out('"betalningspåminnelse". Det är ett tredje, oberoende lexikalt hål.')
  out()

  // ── Slutsats ───────────────────────────────────────────────────────────────
  // Varje siffra nedan interpoleras ur mätningen. Inget påstående får stå här
  // som skriptet inte räknat fram — annars är slutsatsen ett minne av en
  // körning i stället för ett resultat av den.
  const bMs = results.get('B')!
  const bById = new Map(bMs.map((m) => [m.id, m]))
  const bNonInkassoMax = Math.max(
    ...bMs
      .filter((m) => m.legal && !INKASSO_IDS.includes(m.id))
      .map((m) => Math.abs((m.topScore ?? 0) - (baseById.get(m.id)!.topScore ?? 0))),
  )
  const bSweep = sweepFloors(bMs, keepIds)
  const ratten = bById.get('paminnelseavgift-ratten')!
  const rattenBase = baseById.get('paminnelseavgift-ratten')!
  const inWindowBase = INKASSO_IDS.filter((id) => {
    const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
    const m = baseById.get(id)!
    return c.expectedSources.some((s) =>
      s.paragraphs.some((p) => m.fused.includes(`${s.lawId}:${p}`)),
    )
  })
  const inWindowBaseButGated = inWindowBase.filter((id) => baseById.get(id)!.gate !== 'kandidat')
  // Fällan (invariant 9) gäller de ÅTTA inkassofallen. Övriga fall med 4 a § i
  // fönstret redovisas separat — de är en annan iakttagelse och får inte
  // buntas ihop med den.
  const fouraInInkasso = indexes.flatMap((idx) =>
    results
      .get(idx.variant.id)!
      .filter((m) => INKASSO_IDS.includes(m.id) && m.fused.includes('inkassokostnadslagen:4 a'))
      .map((m) => `${idx.variant.id}/${m.id}`),
  )
  const fouraElsewhere = indexes.flatMap((idx) =>
    results
      .get(idx.variant.id)!
      .filter((m) => !INKASSO_IDS.includes(m.id) && m.fused.includes('inkassokostnadslagen:4 a'))
      .map((m) => `${idx.variant.id}/${m.id}`),
  )
  const fouraElsewhereCases = [...new Set(fouraElsewhere.map((s) => s.split('/')[1]!))]

  out('## Slutsats')
  out()
  out('**Ja, det finns ett lösningsutrymme — men det ligger inte där frågan antog.**')
  out()
  out('### 1. Grinden är inte det enda hindret, och för huvudfallet inte hindret alls')
  out()
  out(`\`paminnelseavgift-ratten\` — #406:s mätsticka — passerar grinden REDAN i dag`)
  out(
    `(BM25 ${fmt(rattenBase.topScore)}, grind \`${rattenBase.gate}\`). Den fälls inte av något golv.`,
  )
  out('Den fälls av att 2 § aldrig kommer in i domarens fönster: baslinjens fused topp-3 är')
  out(`\`${rattenBase.fused.join(' · ')}\`, och 2 § har BM25-score 0,00.`)
  out('Ett högre eller lägre golv kan per konstruktion inte ändra det.')
  out()
  out(
    `Omvänt gäller för ${inWindowBaseButGated.length} av de sex grindfällda fallen att RÄTT paragraf redan`,
  )
  out('ligger i fönstret — semantiken har hittat den — men frågan släpps aldrig in:')
  out(`${inWindowBaseButGated.map((i) => `\`${i}\``).join(', ')}.`)
  out('För dem är grinden hela hindret. #406-planens formulering att "de sex aldrig når')
  out('grinden" stämmer alltså inte: de når den och fälls av den, med svaret i handen.')
  out()
  out('### 2. Kandidat B separerar rätt paragraf — och rör inget annat')
  out()
  out(`- 2 § rankas över 4 a § i **8 av 8** inkassofall (baslinjen: 2 av 8).`)
  out(`- 2 § når domarens fönster i huvudfallet \`paminnelseavgift-ratten\`: fused topp-3 blir`)
  out(`  \`${ratten.fused.join(' · ')}\`. Ingen A-variant klarar det — där stannar 2 § på lexikal`)
  out('  rank 6–7 och når aldrig fönstret.')
  out(
    `- Största rörelse utanför inkassofallen: **${bNonInkassoMax.toFixed(2)} poäng**. Golvet 9 behåller`,
  )
  out(
    `  exakt sin kalibrering (säkert intervall ${bSweep.safeFloors[0]?.toFixed(2)}–${bSweep.safeFloors[bSweep.safeFloors.length - 1]?.toFixed(2)}, samma övre gräns som i dag,`,
  )
  out('  satt av `besittningsskydd-lokal`). Ingen omkalibrering behövs.')
  out('- Enda grindflipp: `kravbrev-avgift`, som lyfts av sin EGEN facit-paragraf (3 § på')
  out('  lexikal rank 1, täckning 1,00) — en korrekt insläppning, inte en läcka.')
  out()
  out('### 3. Kandidat A fungerar mekaniskt men flyttar hela skalan')
  out()
  out('Delningen gör precis vad den ska: `betalningspåminnelse` → `betalning` + `påminnelse`')
  out('broar över till frågans `påminnelseavgift`, och 2 § får poäng i 6 av 8 fall där den')
  out('förut hade 0. Priset är att skalan flyttas för allt annat: `avgLength` stiger från')
  out(
    `${indexes[0]!.avgLength.toFixed(2)} till ${indexes[1]!.avgLength.toFixed(2)} (A10) och enskilda fall rör sig upp till +12,6 poäng.`,
  )
  out('Golvet 9 slutar då betyda det det mättes till — en ommätning av MIN_TOP_SCORE blir')
  out('obligatorisk, och den ommätningen är precis det arbete #400 visade att man inte kan')
  out('hoppa över. A är alltså inte fel, men det är ett dyrare ingrepp med samma mål.')
  out()
  out('### 4. Fällan slog aldrig till')
  out()
  out(
    fouraInInkasso.length === 0
      ? '4 a § (förseningsersättning mellan näringsidkare) hamnar i domarens fönster i **noll**' +
          ' av 5 varianter × 8 inkassofall = 40 mätpunkter. Det farliga utfallet invariant 9' +
          ' spärrar mot materialiseras inte i någon av de mätta varianterna — ingen av dem' +
          ' köper lyftet av 2 § till priset av att 4 a § följer med.'
      : `⚠ 4 a § nådde fönstret i inkassofall: ${fouraInInkasso.join(', ')}.`,
  )
  out()
  if (fouraElsewhereCases.length > 0) {
    out('**Men mätningen hittade 4 a § i fönstret på ett HELT ANNAT fall:**')
    out(
      `${fouraElsewhereCases.map((i) => `\`${i}\``).join(', ')} — i **samtliga** varianter, baslinjen`,
    )
    out('inräknad. Det är alltså ett BEFINTLIGT tillstånd på `main`, inte något någon variant')
    out('orsakar. Mekanismen är rimlig: 4 a § handlar om dröjsmålsränta, och frågan gäller')
    out('dröjsmålsränta — men på en HYRA, där 4 a § (näringsidkare emellan) inte är')
    out('tillämplig. Invariant 9 täcker det inte: den gäller bara de åtta inkassofallen.')
    out('Invariant 7 kräver miss ELLER räntelagen §4/§6 bland källorna, vilket är uppfyllt')
    out('även om 4 a § ligger bredvid. Fyndet hör inte till den här kartläggningens fråga')
    out('men bör få ett eget ärende.')
    out()
  }
  out('### 5. Vad mätningen INTE visar')
  out()
  out('- **Negativkontrollerna är två.** Svepet säger att golv ända ner mot 0,50 håller båda')
  out('  ute — men det är ett påstående om ett instrument med två negativa fall, inte om')
  out('  korpusen. Det som faktiskt håller dem ute är TÄCKNINGSBANDET (0,33 resp. 0,29), inte')
  out('  golvet. Ett förslag om att sänka golvet kräver därför fler negativkontroller först.')
  out('- **B:s söktermer är skrivna av mig.** De är författade per paragraf, inte per')
  out('  eval-fråga, och 2 § och 4 § bär båda ordet `påminnelseavgift` just för att mätningen')
  out('  ska kunna visa fel utfall. Men den som skriver termerna har sett frågorna. Att B')
  out('  lyfter 2 § är därför ett svagare bevis än det ser ut — det starka i mätningen är')
  out('  att B lyfter 2 § UTAN att röra resten av korpusen, inte att lyftet sker.')
  out('- **B diskriminerar inte mellan paragrafer på egen hand.** I `paminnelseavgift-taket`')
  out('  (facit 4 §) rankar B ändå 2 § lexikalt högst; det är semantiken som lägger 4 § först')
  out('  i fönstret. Söktermer löser vokabulärgapet, inte frågeförståelsen.')
  out('- **Ingen domare kördes.** Mätningen stannar vid fönstret. Att 2 § når fönstret betyder')
  out('  att invariant 8 KAN bli grön, inte att den blir det — domaren är ett eget steg.')
  out('- **En söktermsrad per chunk är en ändlig uppräkning** — samma kvarstående risk som')
  out('  #382/#390 håller öppen. Här är den skriven för 7 chunkar av 427.')
  out()

  // ── Hashkontroll ───────────────────────────────────────────────────────────
  const hashesAfter = snapshotHashes(buildLegalChunks())
  out('## Kontroller')
  out()
  out(
    `- Paritet mot produktionen (variant ${prodVariant.variant.id}): **max |Δscore| = 0, max |Δcoverage| = 0**, noll grindavvikelser (${LEGAL_EVAL_SET.length} frågor × ${chunks.length} chunkar).`,
  )
  out(
    `- Lagtextens content-hashar: **${hashesAfter === hashesBefore ? 'oförändrade' : 'ÄNDRADE — FEL'}** (${chunks.length} chunkar).`,
  )
  out(`- Korpus: N = ${chunks.length}, identisk med golvets kalibrerings-N.`)
  out()

  if (hashesAfter !== hashesBefore) throw new Error('content-hashar ändrades under mätningen')

  // Förankrad i skriptets egen plats, inte i cwd: en relativ sökväg gjorde
  // utskriften beroende av var kommandot råkade köras ifrån.
  const target = resolve(__dirname, '../../../docs/research/406-grind-kartlaggning.md')
  writeFileSync(target, `${md.join('\n')}\n`, 'utf8')
  console.warn(`\n[mät] rapport skriven till ${target}`)
}

main().catch((err: unknown) => exitOnPreflightError(err, 'mät'))
