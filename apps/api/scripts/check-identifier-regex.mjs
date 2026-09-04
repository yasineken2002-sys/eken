#!/usr/bin/env node
/**
 * ASCII-ANTAGANDEN OM IDENTIFIERARE I VAKTERNAS EGNA REGEXAR — spärr mot nya.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * `\w`, `\b` och `[A-Za-z_$]` är ASCII-definierade. I en kodbas som namnger
 * allt på svenska betyder det att en vakt som HÄRLEDER ett namn ur källkod kan
 * gå tyst fel, och tystnad är felets form — inte ett kast, inte ett rött prov:
 *
 *     MISSAD   svensk INITIAL         `ärLevande` matchar inte alls. Antalet
 *                                     SJUNKER, vilket åtminstone syns i en summa.
 *     KAPAD    svensk bokstav MITT i  `förvaltning` matchar sin ASCII-SVANS
 *                                     `rvaltning`. Posten HITTAS, med FEL namn,
 *                                     och ANTALET ÄR OFÖRÄNDRAT — ett prov som
 *                                     räknar ser ingenting.
 *
 * Serien är mätt, inte befarad: #640 (fyra), #671 (en), #711 (tio), #714 (elva
 * i en fil), #720 (den delade skannern, där felet kunde påverka VARJE vakt).
 *
 * ── VARFÖR EN VAKT OCH INTE EN LISTA TILL ───────────────────────────────────
 *
 * #713 räknade upp mängden och lagade den en vakt i taget. Mätningen 2026-09-04
 * visade att det inte räcker: mellan `6499be6` och `7dae737` LADE #712 till nio
 * nya förekomster i `check-sequence-allocation.mjs` — samma dygn som listan
 * dränerades. En uppräkning i ett issue kan bara beskriva det som fanns när
 * någon tittade. Utan en spärr står nästa mätning högre än den förra, hur många
 * poster som än lagas.
 *
 * ── VILKEN VY, OCH VARFÖR ───────────────────────────────────────────────────
 *
 * Tre frågor, tre vyer — regeln "EN VY PER FRÅGA" ur CLAUDE.md:
 *
 *   1. VAR LIGGER REGEXARNA?  `tokenize()`. Bara den skiljer en regex-literal
 *      från en division, och bara den vet att `/x/` inne i en sträng eller en
 *      kommentar inte är en regex. Det är hela skälet till att den delade
 *      skannern finns.
 *
 *   2. ÄR DET HÄR ETT ANROP till `new RegExp(...)`?  `codeMask`. Frågan är
 *      "är detta kod", och det är precis vad codeMask svarar på: en kommentar
 *      som NÄMNER `new RegExp(` och en felsträng som innehåller det är båda
 *      blankade.
 *
 *      VARFÖR INTE `blankComments` HÄR: den blankar kommentarer men lämnar
 *      STRÄNGKROPPAR intakta. En vakt som i en felsträng skriver "använd
 *      new RegExp(...) i stället" hade då räknats som ett anrop, och dess
 *      exempelmönster hamnat i baslinjen. Det är samma defekt som #582:s, fast
 *      åt andra hållet — falskt larm i stället för tyst grön.
 *
 *   3. VAD STÅR I MÖNSTRET?  RÅTEXTEN, via tokenens `start`/`end`.
 *
 *      OCH DET FÅR INTE VARA codeMask. codeMask blankar regexKROPPAR
 *      (`del: 'body'`) — alltså exakt det som ska mätas. En vakt som läste
 *      mönstret ur codeMask hade fått blanksteg, hittat noll ASCII-antaganden
 *      och varit grön för alltid. Det är `check-redact-copies`-defekten
 *      ordagrant: elva fältnamn matchade fortfarande, men alla elva var
 *      blanksteg.
 *
 *      Tokenens `bodyStart`/`bodyEnd` duger inte heller: för en regex MED
 *      FLAGGOR är `bodyEnd = end - 1`, så `/abc/g` ger kroppen `abc/` — det
 *      avslutande snedstrecket följer med. Mönstret klipps därför ut ur
 *      råtexten med ett girigt `^/(.*)/([a-z]*)$`, så sista `/` är avgränsaren.
 *
 * ── DEFINITIONEN AV "IDENTIFIERARE" ÄR EN LISTA, INTE PROSA ─────────────────
 *
 * `FORMER` nedan är hela definitionen. Talet den ger går att härleda om av vem
 * som helst, mot vilken ref som helst — till skillnad från #713:s 53, som kom
 * ur ett instrument i en scratchpad och inte längre går att reproducera (en
 * rekonstruktion gav 324 regex mot 393 och union 80 mot 53 vid samma ref).
 * En mängd vars instrument inte överlever sessionen är ett spår, inte ett mått.
 *
 * ── NYCKELORDSREGELN, OCH VARFÖR UNDANTAGET HAR ETT UNDANTAG ────────────────
 *
 * `\bconst\b` letar efter ett FAST ASCII-nyckelord ur JavaScripts grammatik.
 * Båda gränserna står mot samma literal, ingen identifierare härleds, och att
 * kräva `\p{L}` där hade gett brus utan att skydda något. Den formen räknas
 * INTE.
 *
 * UNDANTAGET GÄLLER INTE när gränsen står mot en position där en HÄRLEDD
 * identifierare kan följa. Det är inte en teoretisk finess — det är #720:
 *
 *     const REGEX_LÄGE = /…|\breturn$|\btypeof$|…|\bin$|…/
 *
 * Nyckelorden är ASCII och literala, så formen SÅG UT som `\bconst\b` och
 * klassades av #713:s instrument som "nyckelord 71" — bucketen som räknades
 * bort som ofarlig. Men `$` betyder att den ANDRA sidan av gränsen är hela
 * subjektet, och subjektet var en härledd identifierare. Uppmätt: `\bin$`
 * matchar strängen `påin`, eftersom `å` inte är ett ordtecken och gränsen
 * därför finns. Divisionen i `påin / 2` lästes som en regexstart.
 *
 * Regeln blir alltså STRUKTURELL: ett `\b` räknas när det som står på andra
 * sidan är FRITT SUBJEKT (ett ankare, en `${}`-interpolation), eller när
 * mönstret i övrigt bär ett ASCII-identifierarkonstrukt. Se `gräns-*` nedan.
 *
 * ── BASLINJEN FÅR BARA KRYMPA ───────────────────────────────────────────────
 *
 * `identifier-regex.baseline.json` är MEDLEMMAR — fil, mönster och antal — inte
 * ett tal. Radnummer står med flit inte där: de flyttar vid varje redigering
 * och hade gjort baslinjen till brus i stället för till ett mått.
 *
 * Vakten fäller åt BÅDA hållen:
 *
 *   (a) en förekomst i koden som INTE står i baslinjen   → RÖTT (ny skuld)
 *   (b) en post i baslinjen som inte finns i koden       → RÖTT (stale)
 *
 * (b) är den som gör spärren till en spärr. Utan den överlever listan sin egen
 * sanning: en lagad förekomst hade stått kvar som "accepterad" för alltid, och
 * formen kunnat återinföras utan att något blev rött.
 *
 * SÅ HÄR KRYMPER MAN DEN: laga förekomsten och ta bort dess post i SAMMA PR.
 * `total` härleds ur `poster` och kontrolleras — talet går inte att skriva ned
 * utan att ta bort medlemmar.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Den mäter MÖNSTERTEXT. Den kan inte se:
 *
 *   • ett mönster som byggs av konkatenering eller ur en variabel — bara
 *     literaler och `new RegExp(<literal>)` läses;
 *   • om ett `\w` faktiskt är fel i sitt sammanhang. Formen är en PROXY. En
 *     befintlig förekomst kan vara ofarlig; den står då i baslinjen, och det
 *     är hela skälet till att det är en baslinje och inte ett förbud;
 *   • att någon REDIGERAR baslinjen. Ingen vakt kan hindra det. Det den gör är
 *     att göra redigeringen SYNLIG i diffen och omöjlig att göra av misstag —
 *     en ny förekomst är röd tills någon skriver in den för hand.
 *
 * Beteendet ägs alltså av granskningen; den här filen äger bara att ingenting
 * smyger in.
 *
 * VAKTEN GRANSKAR SIG SJÄLV. Dess egna formdetektorer bär `\w` och `A-Za-z` och
 * står därför i baslinjen. Det är rätt: en vakt som undantar sin egen fil har en
 * blind fläck exakt där den är som mest sannolik.
 *
 * Kör:        node apps/api/scripts/check-identifier-regex.mjs
 * Självtest:  node apps/api/scripts/check-identifier-regex.mjs --self-test
 * Baslinje:   node apps/api/scripts/check-identifier-regex.mjs --skriv
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tokenize, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
/**
 * KORPUSEN. `scripts` står med av ett MÄTT skäl, inte för fullständighets
 * skull: #713:s egen medlemslista namnger `scripts/check-design-tokens.mjs`
 * med två poster. En korpus utan den hade varit en spärr med en tyst blind
 * fläck exakt på en fil ärendet pekar ut — samma form som `grep -v spec`, som
 * råkade utesluta hela `apps/api/src/inspections/`.
 *
 * Katalogerna läses ICKE-rekursivt, en nivå var, så de tre inte överlappar.
 */
const KATALOGER = ['apps/api/scripts', 'scripts', 'scripts/lib']
const BASLINJE_PATH = join(new URL('.', import.meta.url).pathname, 'identifier-regex.baseline.json')

// ── DEFINITIONEN ────────────────────────────────────────────────────────────
//
// Varje form: `namn`, ett `prov` mot MÖNSTERTEXTEN, och `varför`. Listan ÄR
// definitionen av "avgränsar eller fångar en identifierare". Lägg till en form
// här, inte i prosan ovan — och lägg till en kanariefågel i samma PR.
//
// Proven körs mot en NORMALISERAD mönstertext (se `normalisera`): ett mönster
// ur en sträng bär dubblerade backslash i källan, en regex-literal gör det
// inte, och de två ska klassas lika.

/** En FÅNGSTgrupp — inte `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`. */
const FANGST_START = String.raw`\((?:\?<[^>=!][^>]*>)?(?!\?)`

/**
 * Ett ASCII-BOKSTAVSINTERVALL i en teckenklass: `A-Za-z`, `a-zA-Z`, `[A-Z]`,
 * `[a-z]`. Formen skrevs först som enbart `A-Za-z`, och missade då
 * `\b[A-Z][a-zA-Z]{3,}\b` i check-cron-classification — ett mönster som
 * härleder ett KLASSNAMN och tappar `Ärende` lika fullständigt. Det är exakt
 * felet hela serien handlar om: en definition som beskriver den form man råkade
 * se först. Bredare form, mätt: 15 → 21 träffar.
 */
const ASCII_INTERVALL = /[Aa]-[Zz]/.source

export const FORMER = [
  {
    namn: 'fångst-w',
    prov: new RegExp(FANGST_START + String.raw`[^)]*\\w`),
    varför: 'en fångstgrupp som bär \\w fångar bara ASCII-svansen av ett svenskt namn',
  },
  {
    namn: 'fångst-ascii',
    prov: new RegExp(FANGST_START + `[^)]*${ASCII_INTERVALL}`),
    varför: 'en fångstgrupp med ASCII-bokstavsintervall ser omsorgsfull ut och är lika begränsad',
  },
  {
    namn: 'matchning-w',
    prov: /\\w/,
    varför: '\\w i matchningsposition avgränsar ett namn på ASCII',
  },
  {
    namn: 'matchning-ascii',
    prov: new RegExp(ASCII_INTERVALL),
    varför: 'ett ASCII-bokstavsintervall antar att ett härlett namn bara bär ASCII',
  },
  {
    // `kräverOckså` är inte pynt. Utan den läste `\}\s*\\b` slutklammern i en
    // KVANTIFIERARE som en interpolation: `\b[A-Z][a-zA-Z]{3,}\b` klassades som
    // `gräns-interp` fast mönstret inte bär något `${`. Funnet genom att läsa
    // MEDLEMMARNA, inte talet — summan hade sett rimlig ut i båda fallen.
    namn: 'gräns-interp',
    prov: /\\b\s*\$\{|\}\s*\\b/,
    kräverOckså: /\$\{/,
    varför: 'ett \\b intill en ${}-interpolation avgränsar ett HÄRLETT namn — #647, #714',
  },
  {
    namn: 'gräns-ankare',
    prov: /\\b[A-Za-z]+\$|\^[A-Za-z]+\\b/,
    varför:
      'ett \\b som paras med ett ankare vetter mot FRITT SUBJEKT: andra sidan av gränsen är ' +
      'den härledda identifieraren. Det är #720 — \\bin$ matchar påin.',
  },
  {
    namn: 'gräns-idkonstrukt',
    prov: /\\b/,
    kräverOckså: new RegExp(`\\\\\\\\w|${ASCII_INTERVALL}`),
    varför:
      'ett \\b i ett mönster som i övrigt bär ett ASCII-identifierarkonstrukt avgränsar ' +
      'samma härledda namn',
  },
]

/**
 * NYCKELORDSUNDANTAGET. Ett mönster vars enda ASCII-drag är `\b<ord>\b` letar
 * efter ett fast nyckelord ur språkets grammatik och härleder ingenting.
 * Undantaget gäller bara när ingen av `gräns-interp` / `gräns-ankare` /
 * `gräns-idkonstrukt` slagit till — se huvudet.
 */
const NYCKELORD_ENDAST = /^(?:[^\\]|\\[^bw])*\\b[A-Za-z]+\\b(?:[^\\]|\\[^bw])*$/

/** Källans mönstertext → jämförbar form. Ett mönster i en sträng bär `\\`. */
function normalisera(text, ursprung) {
  return ursprung === 'literal' ? text : text.replace(/\\\\/g, '\\')
}

/** Formerna ett mönster träffar, i listans ordning. Tom lista = ingen skuld. */
export function klassificera(mönster, ursprung = 'literal') {
  const p = normalisera(mönster, ursprung)
  const träffar = FORMER.filter((f) => f.prov.test(p) && (!f.kräverOckså || f.kräverOckså.test(p)))
  if (!träffar.length) return []
  if (träffar.every((f) => f.namn.startsWith('gräns-')) && NYCKELORD_ENDAST.test(p)) return []
  return träffar.map((f) => f.namn)
}

/** `/mönster/flaggor` → mönstret. Girigt, så sista `/` är avgränsaren. */
function literalMönster(rå) {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(rå)
  return m ? m[1] : null
}

/**
 * Varje regexförekomst i en fil: literaler via `tokenize`, och `new RegExp(…)`
 * med en literal som första argument — anropet avgörs i `codeMask`, mönstret
 * läses ur råtexten.
 */
export function förekomster(text) {
  const ut = []
  const kod = codeMask(text)
  const tokens = tokenize(text)

  for (const t of tokens) {
    if (t.kind !== 'regex') continue
    const m = literalMönster(text.slice(t.start, t.end))
    if (m !== null) ut.push({ mönster: m, ursprung: 'literal' })
  }

  for (const m of kod.matchAll(/new\s+RegExp\s*\(\s*/g)) {
    const efter = m.index + m[0].length
    const arg = tokens.find(
      (t) => t.start === efter && (t.kind === 'string' || t.kind === 'template'),
    )
    if (arg) ut.push({ mönster: text.slice(arg.bodyStart, arg.bodyEnd), ursprung: 'sträng' })
  }
  return ut
}

/** Alla klassade förekomster i en fil, med antal per unikt mönster. */
export function poster(rel, text) {
  const per = new Map()
  for (const { mönster, ursprung } of förekomster(text)) {
    const former = klassificera(mönster, ursprung)
    if (!former.length) continue
    const nyckel = `${mönster} ${former.join(',')}`
    const post = per.get(nyckel) ?? { fil: rel, mönster, former, antal: 0 }
    post.antal++
    per.set(nyckel, post)
  }
  return [...per.values()]
}

const nyckelAv = (p) => `${p.fil} ${p.mönster} ${p.former.join(',')}`

/** Kärnan, matbar med SYNTETISK indata så kanariefåglarna kan pröva former. */
export function evaluateTexts(filer, baslinje) {
  const fel = []
  const ikod = new Map()
  for (const { rel, text } of filer) for (const p of poster(rel, text)) ikod.set(nyckelAv(p), p)

  const ibas = new Map((baslinje.poster ?? []).map((p) => [nyckelAv(p), p]))

  for (const [k, p] of ikod) {
    const b = ibas.get(k)
    if (!b) {
      fel.push(
        `NY ${p.fil} — ${p.former.join('+')}: /${p.mönster}/ (${p.antal} st). ` +
          'En ny ASCII-härledning av en identifierare. Avgränsa med \\p{L} och u-flaggan: ' +
          '(?<![\\p{L}\\p{N}_$])namn(?![\\p{L}\\p{N}_$]) täcker allt \\b täckte, plus ' +
          'svenska initialer. Är den bevisligen ofarlig — skriv in den i ' +
          'identifier-regex.baseline.json och motivera i PR-texten.',
      )
    } else if (p.antal > b.antal) {
      fel.push(
        `FLER ${p.fil} — /${p.mönster}/ finns ${p.antal} gånger, baslinjen har ${b.antal}. ` +
          'Baslinjen får bara krympa.',
      )
    }
  }

  for (const [k, b] of ibas) {
    const p = ikod.get(k)
    if (!p) {
      fel.push(
        `STALE ${b.fil} — /${b.mönster}/ (${b.former.join('+')}) står i baslinjen men finns ` +
          'inte längre i koden. Lagade du den? Ta bort posten i SAMMA PR. En baslinje som ' +
          'inte städas överlever sin egen sanning, och då kan formen återinföras i tystnad.',
      )
    } else if (p.antal < b.antal) {
      fel.push(
        `FÄRRE ${b.fil} — /${b.mönster}/ finns ${p.antal} gånger, baslinjen har ${b.antal}. ` +
          'Skriv ned antalet i baslinjen i samma PR.',
      )
    }
  }

  const summa = [...ikod.values()].reduce((a, p) => a + p.antal, 0)
  const basSumma = (baslinje.poster ?? []).reduce((a, p) => a + p.antal, 0)
  if (baslinje.total !== undefined && baslinje.total !== basSumma) {
    fel.push(
      `TOTAL baslinjens "total" är ${baslinje.total} men medlemmarna summerar till ${basSumma}. ` +
        'Talet HÄRLEDS ur poster — det går inte att skriva ned utan att ta bort medlemmar.',
    )
  }

  return {
    fel,
    mätt: { filer: filer.length, poster: ikod.size, förekomster: summa, baslinje: basSumma },
  }
}

export function laddaBaslinje() {
  return JSON.parse(readFileSync(BASLINJE_PATH, 'utf8'))
}

export function allaSkript() {
  const ut = []
  for (const kat of KATALOGER) {
    const bas = join(ROT, kat)
    for (const n of readdirSync(bas)) {
      const p = join(bas, n)
      if (statSync(p).isFile() && n.endsWith('.mjs')) ut.push(p)
    }
  }
  return ut.sort()
}

export function läs(filer = allaSkript()) {
  return filer.map((abs) => ({
    rel: relative(ROT, abs).replaceAll('\\', '/'),
    text: readFileSync(abs, 'utf8'),
  }))
}

// ── kanariefåglarna ─────────────────────────────────────────────────────────

function självtest() {
  const fel = []
  const kräv = (namn, villkor, detalj) => {
    if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`)
  }

  // Den delade skannern bär hela mätningen. Går den sönder ska DEN HÄR vakten
  // bli röd, inte bara source-scan.mjs egen körning.
  for (const f of kanariefåglar()) fel.push(`delad skanner: ${f}`)

  const bas = evaluateTexts(läs(), laddaBaslinje())
  kräv('baslinjen är grön', bas.fel.length === 0, bas.fel.slice(0, 3).join(' | '))

  // ── KANARIE 1: MISSAD och KAPAD — de två felformerna ur #711 ──────────────
  //
  // Proven visar att ASCII-antagandet FAKTISKT ger de två utfallen, så att
  // definitionen ovan inte bara är en åsikt om vilka tecken som är fula.
  {
    const ascii = /(\w+)\s*:/
    const uni = /([\p{L}\p{N}_$]+)\s*:/u
    const aM = ascii.exec('ärLevande: 1')?.[1]
    const uM = uni.exec('ärLevande: 1')?.[1]
    kräv(
      'KANARIE 1 MISSAD (svensk initial hittas inte av ASCII-formen)',
      aM !== 'ärLevande' && uM === 'ärLevande',
      `ascii=${JSON.stringify(aM)} uni=${JSON.stringify(uM)}`,
    )
    const aK = ascii.exec('förvaltning: 1')?.[1]
    kräv(
      'KANARIE 1 KAPAD (namnet hittas, med FEL namn)',
      aK === 'rvaltning' && uni.exec('förvaltning: 1')?.[1] === 'förvaltning',
      `ascii=${JSON.stringify(aK)}`,
    )
    kräv(
      'KANARIE 1 KAPAD är osynlig för en RÄKNING',
      (ascii.exec('förvaltning: 1') ? 1 : 0) === (uni.exec('förvaltning: 1') ? 1 : 0),
      'antalet skiljer sig — då hade en summa räckt, och regeln vore onödig',
    )
  }

  // ── KANARIE 2: en NY härledning i en vakt ska fällas ──────────────────────
  {
    const ny = 'const m = /(?:const|let)\\s+(\\w+)\\s*=/'
    const r = evaluateTexts([{ rel: 'apps/api/scripts/zz-prov-ny.mjs', text: ny }], { poster: [] })
    kräv(
      'KANARIE 2 (ny \\w-härledning i en vakt fälls)',
      r.fel.filter((f) => f.startsWith('NY ')).length === 1,
      JSON.stringify(r.fel),
    )
  }

  // ── KANARIE 3: en baslinjepost UTAN motsvarighet ska fällas ───────────────
  //
  // Riktningen som gör spärren till en spärr. Utan den kan en lagad förekomst
  // stå kvar som accepterad, och formen återinföras i tystnad.
  {
    const r = evaluateTexts(
      [{ rel: 'apps/api/scripts/zz-prov-tom.mjs', text: 'export const x = 1' }],
      {
        poster: [
          {
            fil: 'apps/api/scripts/zz-prov-tom.mjs',
            mönster: '(\\w+)',
            former: ['fångst-w', 'matchning-w'],
            antal: 1,
          },
        ],
      },
    )
    kräv(
      'KANARIE 3 (baslinjepost utan motsvarighet fälls)',
      r.fel.filter((f) => f.startsWith('STALE ')).length === 1,
      JSON.stringify(r.fel),
    )
  }

  // ── KANARIE 4: ANTALET räknas, inte bara medlemskapet ─────────────────────
  {
    const text = 'const a = /(\\w+)x/\nconst b = /(\\w+)x/\n'
    const post = {
      fil: 'apps/api/scripts/zz-prov-antal.mjs',
      mönster: '(\\w+)x',
      former: ['fångst-w', 'matchning-w'],
      antal: 1,
    }
    const r = evaluateTexts([{ rel: post.fil, text }], { poster: [post] })
    kräv(
      'KANARIE 4 (en förekomst MER än baslinjen fälls)',
      r.fel.filter((f) => f.startsWith('FLER ')).length === 1,
      JSON.stringify(r.fel),
    )
    const r2 = evaluateTexts([{ rel: post.fil, text: 'const a = /(\\w+)x/\n' }], {
      poster: [{ ...post, antal: 2 }],
    })
    kräv(
      'KANARIE 4 (en förekomst FÄRRE än baslinjen fälls också)',
      r2.fel.filter((f) => f.startsWith('FÄRRE ')).length === 1,
      JSON.stringify(r2.fel),
    )
  }

  // ── KANARIE 5: NYCKELORDSREGELN, båda riktningarna ────────────────────────
  //
  // Den här skiljer regeln från "fäll allt som bär \b".
  {
    const k = (p) => klassificera(p)
    kräv(
      'KANARIE 5 (\\bconst\\b räknas INTE — fast nyckelord, härleder inget)',
      k(String.raw`\bconst\b`).length === 0,
      JSON.stringify(k(String.raw`\bconst\b`)),
    )
    kräv(
      'KANARIE 5 (\\breturn$ RÄKNAS — #720, andra sidan är fritt subjekt)',
      k(String.raw`\breturn$`).includes('gräns-ankare'),
      JSON.stringify(k(String.raw`\breturn$`)),
    )
    kräv(
      'KANARIE 5 (^const\\b RÄKNAS — spegelvänt samma sak)',
      k(String.raw`^const\b`).includes('gräns-ankare'),
      JSON.stringify(k(String.raw`^const\b`)),
    )
    const interp = '\\b' + '${namn}' + '\\b'
    kräv(
      'KANARIE 5 (\\b${namn}\\b RÄKNAS — interpolerat, alltså härlett)',
      k(interp).includes('gräns-interp'),
      JSON.stringify(k(interp)),
    )
    kräv(
      'KANARIE 5 (\\bthis\\.\\w+ RÄKNAS — nyckelord PLUS idkonstrukt)',
      k(String.raw`\bthis\.\w+`).length > 0,
      JSON.stringify(k(String.raw`\bthis\.\w+`)),
    )
  }

  // ── KANARIE 6: DELSTRÄNGS-MOTPROVET ───────────────────────────────────────
  //
  // En LAGAD form får inte räknas. Gjorde den det gick baslinjen aldrig att
  // krympa, och vakten straffade precis den ändring den finns för att framkalla.
  {
    const lagad = '(?<![\\p{L}\\p{N}_$])' + '${esc}' + '(?![\\p{L}\\p{N}_$])'
    kräv(
      'KANARIE 6 (den LAGADE lookaround-formen räknas inte)',
      klassificera(lagad).length === 0,
      JSON.stringify(klassificera(lagad)),
    )
    kräv(
      'KANARIE 6 (\\p{L}-fångst räknas inte)',
      klassificera(String.raw`([\p{L}\p{N}_$]+)\s*:`).length === 0,
      JSON.stringify(klassificera(String.raw`([\p{L}\p{N}_$]+)\s*:`)),
    )
    // DELSTRÄNGS-MOTPROVET på detektorerna själva: bokstäverna `w` och `b`
    // utan sin BACKSLASH är vanlig mönstertext, inte `\w` och `\b`. En
    // detektor skriven som /w/ i stället för /\\w/ hade fällt varje mönster
    // som råkar innehålla ett w — och varit grön i baslinjen, eftersom
    // baslinjen då bara vuxit.
    kräv(
      'KANARIE 6 (`w` och `b` UTAN backslash är inte \\w och \\b)',
      klassificera(String.raw`word\s+between`).length === 0,
      JSON.stringify(klassificera(String.raw`word\s+between`)),
    )
  }

  // ── KANARIE 7: VYERNA ─────────────────────────────────────────────────────
  //
  // Att mönstret läses ur RÅTEXTEN och inte ur codeMask, och att ett anrop i
  // PROSA inte räknas. Utan de här kan vakten vara stum och grön.
  {
    const iKommentar = '// exempel: const m = /(\\w+)/\nexport const x = 1'
    kräv(
      'KANARIE 7 (en regex i en KOMMENTAR räknas inte)',
      poster('zz.mjs', iKommentar).length === 0,
      JSON.stringify(poster('zz.mjs', iKommentar)),
    )

    const iSträng = 'const doc = \'använd new RegExp("(\\\\w+)") i stället\'\nexport const x = 1'
    kräv(
      'KANARIE 7 (new RegExp i en STRÄNG är inget anrop)',
      poster('zz.mjs', iSträng).length === 0,
      JSON.stringify(poster('zz.mjs', iSträng)),
    )

    const anrop = 'const r = new RegExp(`\\\\b${namn}\\\\b`, "g")'
    kräv(
      'KANARIE 7 (new RegExp med en MALL läses och klassas)',
      poster('zz.mjs', anrop).length === 1,
      JSON.stringify(poster('zz.mjs', anrop)),
    )

    const m = poster('zz.mjs', 'const r = /(\\w+)/gu')
    kräv(
      'KANARIE 7 (flaggor följer inte med i mönstret)',
      m.length === 1 && m[0].mönster === '(\\w+)',
      JSON.stringify(m),
    )
  }

  // ── KANARIE 8: mängden är inte tom ────────────────────────────────────────
  //
  // En baslinje på noll hade varit grön och betytt ingenting. Golvet är mätt
  // mot dagens main, inte gissat.
  kräv(
    'KANARIE 8 (baslinjen mäter något)',
    bas.mätt.förekomster >= 40,
    `bara ${bas.mätt.förekomster} förekomster — har korpusen eller FORMER tömts?`,
  )
  kräv(
    'KANARIE 8 (mer än en handfull filer bär formen)',
    new Set((laddaBaslinje().poster ?? []).map((p) => p.fil)).size >= 5,
    'färre än fem filer i baslinjen',
  )

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `SJÄLVTEST GRÖNT — ${bas.mätt.filer} skript, ${bas.mätt.förekomster} förekomster över ` +
      `${bas.mätt.poster} poster, ${FORMER.length} former, båda riktningarna prövade.`,
  )
}

function skrivBaslinje() {
  const p = läs().flatMap(({ rel, text }) => poster(rel, text))
  p.sort((a, b) => a.fil.localeCompare(b.fil) || a.mönster.localeCompare(b.mönster))
  const ut = {
    $comment:
      'BASLINJE — befintliga ASCII-antaganden om identifierare i vakternas regexar (#713). ' +
      'MEDLEMMAR, inte ett tal: fil + mönster + antal. Radnummer står inte här; de flyttar.',
    $howto:
      'Listan får bara KRYMPA. Laga en förekomst och ta bort dess post i SAMMA PR — en post ' +
      'utan motsvarighet i koden är lika röd som en okänd förekomst. Att lägga TILL en post ' +
      'är att ta på sig ny skuld och ska motiveras i PR-texten.',
    $definition:
      'Formerna står i check-identifier-regex.mjs (FORMER). Talet går att härleda om mot ' +
      'vilken ref som helst: node apps/api/scripts/check-identifier-regex.mjs --skriv',
    total: p.reduce((a, x) => a + x.antal, 0),
    poster: p,
  }
  process.stdout.write(JSON.stringify(ut, null, 2) + '\n')
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-identifier-regex.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else if (process.argv.includes('--skriv')) skrivBaslinje()
else {
  const { fel, mätt } = evaluateTexts(läs(), laddaBaslinje())
  if (fel.length) {
    console.error(
      'ASCII-antaganden om identifierare — baslinjen stämmer inte:\n  ' + fel.join('\n  '),
    )
    process.exit(1)
  }
  console.warn(
    `Inga nya ASCII-härledningar — ${mätt.filer} vaktskript, ${mätt.förekomster} förekomster ` +
      `över ${mätt.poster} poster, exakt baslinjen.`,
  )
}
