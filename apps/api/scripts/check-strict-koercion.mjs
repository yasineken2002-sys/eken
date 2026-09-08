#!/usr/bin/env node
/**
 * VARJE DTO-FÄLT SOM PIPEN KAN KONVERTERA SKA BÄRA EN STRIKT DEKORATOR.
 *
 * ── MEKANIKEN ───────────────────────────────────────────────────────────────
 *
 * Den globala pipen kör `enableImplicitConversion`, så class-transformer läser
 * fältets TS-typ och konverterar INNAN validatorn ser något. Validatorn prövar
 * alltså resultatet av konverteringen, aldrig det klienten skickade.
 *
 *     Boolean('false')   → true                 ett NEJ blir ett JA
 *     String({ a: 1 })   → "[object Object]"    ett objekt blir data
 *
 * ── TRE FORMER, EN VAKT ─────────────────────────────────────────────────────
 *
 * Vakten hette `check-strict-boolean.mjs` och mätte en form. Den mäter nu tre,
 * och heter därför något annat. Formerna står i `FORMER` och `FORBJUDNA` nedan
 * — en fjärde form är en post i en tabell, inte ett fjärde skript.
 *
 * Två slags regler, med olika form och olika skäl:
 *
 *   FORMER     "ett fält som tillhör formen SKA bära dekoratorn".
 *              Medlemskapet går att avgöra ur fältets egna dekoratorer.
 *
 *   FORBJUDNA  "den här dekoratorn får inte förekomma alls".
 *              Används där medlemskapet INTE går att avgöra: vilka fält som är
 *              datumfält syns inte i en DTO, och en namnheuristik (`*Date`,
 *              `*At`) hade varit en gissning som tiger när någon döper ett fält
 *              `forfallodag`. Frågan "används en lax datumvalidator någonstans"
 *              går däremot att ställa exakt — och den kan falla när som helst
 *              någon skriver en ny, vilket en uppräkning av kända förekomster
 *              inte kan.
 *
 * ── VARFÖR MEDLEMSKAPET FÖR STRÄNG ÄR `@IsString()`, INTE TS-TYPEN ──────────
 *
 * Uppmätt: 118 strängtypade fält bär ingen `@IsString()`. Alla 118 bär i stället
 * en validator som AVVISAR `"[object Object]"` — `@IsUUID` (55), `@IsDateString`
 * (36, se nedan), `@IsEmail` (16), `@StrictIsoDatum` (10), `@IsBooleanString` (1).
 * Noll av dem saknar validator helt.
 *
 * Farlig är den kombination som SLÄPPER IGENOM strängen: `@IsString()` med en
 * längd- eller innehållskontroll som `"[object Object]"` klarar. Därför är
 * medlemskapet `@IsString()`. Ett strängtypat fält HELT utan validator vore
 * också farligt — mängden är noll i dag och kanariefågel 13 bevakar att vakten
 * inte tyst börjar räkna in `@IsUUID`-fälten i stället.
 *
 * ── VAD VAKTEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att dekoratorn GÖR något. Den mäter att den FINNS. Beteendet — `"false"` blir
 * `false`, `{ a: 1 }` blir 400, `"2026"` blir 400 — ägs av `strict-boolean.spec.ts`,
 * `strict-string.spec.ts` och `strict-iso-datum.spec.ts`, som kör den riktiga
 * pipen och var och en har en kanariefågel som visar att koercionen finns utan
 * dekoratorn.
 *
 * Den ser heller inte ett fält vars TS-typ bär en form men som saknar validator
 * helt — de valideras inte alls, vilket är ett annat problem.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask } from '../../../scripts/lib/source-scan.mjs'

const ROT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TRAD = 'apps/api/src'

/** `@Namn(` — literalt namn, ingen teckenklass. Se CLAUDE.md om `\w`/`\b`. */
const dek = (namn) => new RegExp(`@${namn}\\s*\\(`)

/**
 * FORMERNA. Ett fält som `tillhor` en form ska bära `dekorator`.
 *
 * Lägger du till en form: lägg också till en POSITIV och en NEGATIV kanariefågel
 * nedan. En form utan sonder är en rad i en tabell, inte en spärr.
 */
export const FORMER = [
  {
    dekorator: 'StrictBoolean',
    modul: 'common/contract/strict-boolean.decorator',
    tillhor: (f) => dek('IsBoolean').test(f.dekoratorer) || /^(boolean|true|false)$/.test(f.typ),
    skada:
      'Pipen kör Boolean(värdet) före validatorn, så strängen "false" blir true. ' +
      'Ett fält som betyder JA/NEJ kan då bara betyda JA.',
  },
  {
    dekorator: 'StrictString',
    modul: 'common/contract/strict-string.decorator',
    tillhor: (f) => dek('IsString').test(f.dekoratorer),
    skada:
      'Pipen kör String(värdet) före validatorn, så { "a": 1 } blir "[object Object]". ' +
      'Strängen SER UT som data, passerar varje längdkontroll, och lagras.',
  },
]

/**
 * FÖRBJUDNA DEKORATORER. Mängden är noll och regeln är absolut.
 *
 * `@IsDateString()` är i class-validator 0.14.4 en ren ALIAS för `isISO8601` —
 * uppmätt, inte antaget:
 *
 *     värde                  isISO8601  isDateString
 *     2026                   true       true      ← bara årtal
 *     2026-09                true       true      ← år och månad
 *     2026-09-07T12:00:00    true       true      ← UTAN TIDSZON
 *     20260907               true       true      ← basformat
 *     2026-W12               true       true      ← veckoformat
 *
 * Tidsstämpeln utan offset är den allvarliga: `new Date()` tolkar den i SERVERNS
 * lokaltid, som varken är kundens eller UTC. För `paidAt`, `dueDate` eller
 * `effectiveDate` betyder det att en betalning kan hamna på fel dag — och därmed
 * i fel bokföringsperiod. `"2026"` är uppenbart fel och upptäcks; en tidsstämpel
 * utan zon ser rätt ut.
 *
 * Det var därför den här regeln INTE kunde skrivas som "inget `@IsISO8601` kvar":
 * den formen var uppfylld efter tio fältbyten, medan 36 fält med exakt samma
 * defekt stod kvar under ett annat namn.
 */
export const FORBJUDNA = [
  { dekorator: 'IsDateString', ersatt: 'StrictIsoDatum' },
  { dekorator: 'IsISO8601', ersatt: 'StrictIsoDatum' },
]

/**
 * Fältdeklarationer på klassnivå. Exporterad så kanariefåglarna mäter SAMMA
 * funktion som den skarpa körningen — en sond som skriver om parsern mäter sin
 * egen rad och kan inte falla när vakten ändras.
 */
export function faltIFil(kalla) {
  const kod = codeMask(kalla)
  const ut = []
  // `\p{L}`, inte `\w`: ett fältnamn får börja på å/ä/ö. Se CLAUDE.md om \b.
  const FALT = /([\p{L}_$][\p{L}\p{N}_$]*)\s*[!?]?\s*:/gu
  const KLASS = /(?:^|[\n;}])\s*(?:export\s+)?(?:abstract\s+)?class\s+[\p{L}\p{N}_$]+[^{]*\{/gu
  for (const km of kod.matchAll(KLASS)) {
    const start = kod.indexOf('{', km.index + km[0].length - 1)
    let d = 0
    let slut = -1
    for (let i = start; i < kod.length; i += 1) {
      if ('{(['.includes(kod[i])) d += 1
      else if ('})]'.includes(kod[i])) {
        d -= 1
        if (d === 0) {
          slut = i
          break
        }
      }
    }
    if (slut < 0) continue
    const kropp = kod.slice(start + 1, slut)
    let forra = 0
    for (const m of kropp.matchAll(FALT)) {
      let d2 = 0
      for (let i = 0; i < m.index; i += 1) {
        if ('{(['.includes(kropp[i])) d2 += 1
        else if ('})]'.includes(kropp[i])) d2 -= 1
      }
      // Djup 0 = klassnivå. Utesluter `example:` inne i @ApiProperty({ … }).
      if (d2 !== 0) continue
      const dekoratorer = kropp.slice(forra, m.index)
      const efter = /^[^\n;]*/.exec(kropp.slice(m.index + m[0].length))?.[0] ?? ''
      forra = m.index + m[0].length + efter.length
      ut.push({
        falt: m[1],
        typ: efter.trim().replace(/,$/, ''),
        dekoratorer,
        rad: kalla.slice(0, start + 1 + m.index).split('\n').length,
      })
    }
  }
  return ut
}

function dtoFiler(rot) {
  const ut = []
  const gaa = (katalog) => {
    for (const namn of readdirSync(katalog)) {
      const p = join(katalog, namn)
      if (statSync(p).isDirectory()) gaa(p)
      else if (namn.endsWith('.dto.ts')) ut.push(p)
    }
  }
  gaa(join(rot, TRAD))
  return ut
}

/**
 * Fält som tillhör en form men saknar dess dekorator, plus varje förekomst av en
 * förbjuden dekorator.
 *
 * Båda frågorna ställs mot MASKERAD kod: `f.dekoratorer` kommer ur `faltIFil`,
 * och filsvepet efter förbjudna kör `codeMask` självt. En dekorator som NÄMNS i
 * en kommentar uppfyller alltså ingenting och friar ingenting — kanariefågel 14
 * kräver att det håller.
 */
export function oskyddade(rot = ROT) {
  const ut = []
  for (const p of dtoFiler(rot)) {
    const kalla = readFileSync(p, 'utf8')
    const fil = relative(rot, p)

    for (const f of faltIFil(kalla)) {
      for (const form of FORMER) {
        if (!form.tillhor(f)) continue
        if (dek(form.dekorator).test(f.dekoratorer)) continue
        ut.push({ sort: 'saknas', fil, falt: f.falt, rad: f.rad, form })
      }
    }

    const kod = codeMask(kalla)
    for (const f of FORBJUDNA) {
      const re = new RegExp(`@${f.dekorator}\\s*\\(`, 'g')
      for (const m of kod.matchAll(re)) {
        ut.push({
          sort: 'forbjuden',
          fil,
          falt: f.dekorator,
          rad: kalla.slice(0, m.index).split('\n').length,
          forbjuden: f,
        })
      }
    }
  }
  return ut.sort((a, b) => `${a.fil}\t${a.rad}`.localeCompare(`${b.fil}\t${b.rad}`))
}

function kanariefåglar() {
  const fel = []
  const bas = mkdtempSync(join(tmpdir(), 'strict-koercion-'))
  mkdirSync(join(bas, TRAD, 'sond'), { recursive: true })
  const lagg = (n, i) => writeFileSync(join(bas, TRAD, 'sond', n), i, 'utf8')

  // ── BOOLESK FORM ────────────────────────────────────────────────────────
  // 1. POSITIV — ETT PÅHITTAT FÄLT som inte finns i kodbasen. Namnet är valt så
  //    att en träff omöjligen kan komma från något annat.
  lagg('a.dto.ts', `export class A {\n  @IsBoolean()\n  zzPahittadFlagga!: boolean\n}\n`)
  // 2. POSITIV — ENRADSFORMEN, den företrädaren missade helt.
  lagg('b.dto.ts', `export class B {\n  @IsBoolean() @IsOptional() zzEnrad?: boolean\n}\n`)
  // 3. NEGATIV — skyddat fält fälls inte.
  lagg('c.dto.ts', `export class C {\n  @StrictBoolean()\n  @IsBoolean()\n  falt!: boolean\n}\n`)
  // 4. NEGATIV — DEN SOM FÅNGAR FÖRETRÄDARENS FALSKA POSITIVA: ett fält vars
  //    TS-typ är en strängunion, som FÖLJER ett booleskt enradsfält. Fälls det
  //    har parsern börjat tillskriva föregående fälts dekorator.
  lagg(
    'd.dto.ts',
    `export class D {\n  @StrictBoolean() @IsBoolean() @IsOptional() flagga?: boolean\n  @IsEnum(['A','B'])\n  @IsOptional()\n  strangUnion?: 'A' | 'B'\n}\n`,
  )
  // 5. NEGATIV — `example:` inne i en dekorators objektliteral är inget fält.
  lagg(
    'e.dto.ts',
    `export class E {\n  @ApiProperty({ example: true })\n  @StrictBoolean()\n  @IsBoolean()\n  falt!: boolean\n}\n`,
  )
  // 6. POSITIV — ett fältnamn på å/ä/ö ska hittas som vilket annat som helst.
  lagg('f.dto.ts', `export class F {\n  @IsBoolean()\n  ärGodkänd!: boolean\n}\n`)

  // ── STRÄNGFORM ──────────────────────────────────────────────────────────
  // 7. POSITIV — @IsString() utan @StrictString().
  lagg('g.dto.ts', `export class G {\n  @IsString()\n  @MaxLength(200)\n  zzPahittatSvar!: string\n}\n`)
  // 8. NEGATIV — skyddat strängfält fälls inte.
  lagg('h.dto.ts', `export class H {\n  @IsString()\n  @StrictString()\n  falt!: string\n}\n`)
  // 9. POSITIV — ENRADSFORMEN även för sträng. Formerna delar parser, men en
  //    form som läggs till utan egen sond ärver inget bevis.
  lagg('i.dto.ts', `export class I {\n  @IsString() @IsOptional() zzStrangEnrad?: string\n}\n`)
  // 13. NEGATIV — DEN SOM HÅLLER MEDLEMSKAPET SMALT: ett strängTYPAT fält med
  //     en validator som avvisar "[object Object]" är inte medlem i formen.
  //     Faller den har medlemskapet glidit från @IsString() till TS-typen, och
  //     vakten kräver plötsligt dekoratorn på 118 fält som inte behöver den.
  lagg('m.dto.ts', `export class M {\n  @IsUUID()\n  zzIdentitet!: string\n}\n`)

  // ── FÖRBJUDNA DATUMVALIDATORER ──────────────────────────────────────────
  // 10. POSITIV — @IsDateString(), aliaset som stod kvar på 36 fält.
  lagg('j.dto.ts', `export class J {\n  @IsDateString()\n  zzForfallodag!: string\n}\n`)
  // 11. POSITIV — @IsISO8601(), samma mängd under ett annat namn.
  lagg('k.dto.ts', `export class K {\n  @IsISO8601()\n  zzUtstalld!: string\n}\n`)
  // 12. NEGATIV — den strikta datumdekoratorn fälls inte, och drar heller inte
  //     in fältet i strängformen (den bär ingen @IsString()).
  lagg('l.dto.ts', `export class L {\n  @StrictIsoDatum()\n  falt!: string\n}\n`)

  // ── PROSA ÄR INTE KOD ───────────────────────────────────────────────────
  // 14. POSITIV × 2 — en KOMMENTAR som nämner dekoratorn får varken frikänna ett
  //     oskyddat fält eller fälla ett förbjudet namn. Utan `codeMask` blir den
  //     första grön (kommentaren läses som skydd) och den andra röd (kommentaren
  //     läses som förekomst) — två fel i motsatt riktning, av samma orsak.
  lagg(
    'n.dto.ts',
    `export class N {\n  // @StrictString() ska läggas till här någon gång\n  @IsString()\n  zzProsaskyddad!: string\n}\n` +
      `\nexport class O {\n  /* historik: fältet bar @IsDateString() före #847 */\n  @StrictIsoDatum()\n  falt!: string\n}\n`,
  )

  const funna = oskyddade(bas)
  const saknas = (falt) => funna.some((f) => f.sort === 'saknas' && f.falt === falt)
  const forbjuden = (namn) => funna.some((f) => f.sort === 'forbjuden' && f.falt === namn)

  const krav = [
    [saknas('zzPahittadFlagga'), 'KANARIEFÅGEL 1: ett påhittat oskyddat booleskt fält fälldes INTE.'],
    [saknas('zzEnrad'), 'KANARIEFÅGEL 2: ENRADSFORMEN missades — parsern är radankrad igen.'],
    [!funna.some((f) => f.fil.endsWith('c.dto.ts')), 'KANARIEFÅGEL 3: ett skyddat booleskt fält fälldes.'],
    [
      !saknas('strangUnion'),
      'KANARIEFÅGEL 4: en strängunion efter ett booleskt enradsfält fälldes — parsern tillskriver föregående fälts @IsBoolean.',
    ],
    [!saknas('example'), 'KANARIEFÅGEL 5: `example:` i en objektliteral räknades som fält.'],
    [saknas('ärGodkänd'), 'KANARIEFÅGEL 6: ett fältnamn på å/ä/ö hittades inte.'],
    [saknas('zzPahittatSvar'), 'KANARIEFÅGEL 7: ett @IsString() utan @StrictString() fälldes INTE.'],
    [!funna.some((f) => f.fil.endsWith('h.dto.ts')), 'KANARIEFÅGEL 8: ett skyddat strängfält fälldes.'],
    [saknas('zzStrangEnrad'), 'KANARIEFÅGEL 9: strängformens ENRADSFORM missades.'],
    [forbjuden('IsDateString'), 'KANARIEFÅGEL 10: @IsDateString() fälldes INTE.'],
    [forbjuden('IsISO8601'), 'KANARIEFÅGEL 11: @IsISO8601() fälldes INTE.'],
    [!funna.some((f) => f.fil.endsWith('l.dto.ts')), 'KANARIEFÅGEL 12: @StrictIsoDatum() fälldes.'],
    [
      !saknas('zzIdentitet'),
      'KANARIEFÅGEL 13: ett @IsUUID()-fält krävdes bära @StrictString() — medlemskapet har glidit från @IsString() till TS-typen.',
    ],
    [
      saknas('zzProsaskyddad'),
      'KANARIEFÅGEL 14a: en KOMMENTAR som nämner @StrictString() frikände ett oskyddat fält — vakten läser prosa som kod.',
    ],
    [
      !funna.some((f) => f.sort === 'forbjuden' && f.fil.endsWith('n.dto.ts')),
      'KANARIEFÅGEL 14b: en KOMMENTAR som nämner @IsDateString() räknades som en förekomst — vakten läser prosa som kod.',
    ],
  ]
  for (const [ok, text] of krav) if (!ok) fel.push(text)
  return fel
}

const kanarieFel = kanariefåglar()
if (kanarieFel.length) {
  console.error('❌ Strikt koercion: vaktens egna kanariefåglar föll\n')
  for (const f of kanarieFel) console.error(`  ${f}`)
  console.error('\nEn vakt som inte kan fälla mäter ingenting. Laga vakten, inte koden.')
  process.exit(1)
}

/**
 * SJÄLVTESTET — EGEN FUNKTION, INTE EN IF-KROPP.
 *
 * `check-self-tests-fail.mjs` härleder rapportvägen ur den FUNKTION dispatchen
 * anropar och injicerar ett fel i den för att pröva att vakten faktiskt avslutar
 * nollskilt. En självtestkropp som bara ligger i ett if-block går inte att mäta
 * så — den här filen skrevs först på det viset, och metavakten fällde den med
 * "ingen rapportmekanism kunde härledas ur självtestets kropp".
 *
 * Rapportvägen är därför en LISTA som exitbeslutet läser. Ett självtest som
 * skriver ut ett fel men ändå avslutar med 0 gör sitt CI-steg grönt om en vakt
 * som slutat mäta.
 */
function selfTest() {
  const fel = []
  // Sonderna mäter VAKTENS egen `oskyddade()`, inte en omskrivning av dess
  // parser. En sond som skriver om logiken mäter sin egen rad och kan inte
  // falla när vakten ändras.
  for (const f of kanariefåglar()) fel.push(f)
  if (fel.length) {
    console.error('❌ Strikt koercion, självtestet föll\n')
    for (const f of fel) console.error(`  ${f}`)
    process.exit(1)
  }
  console.warn('✅ Strikt koercion, självtest: 15 sonder gröna')
  console.warn('   BOOLESK FORM')
  console.warn('    1 POSITIV  ett påhittat oskyddat fält fälls')
  console.warn('    2 POSITIV  ENRADSFORMEN hittas (företrädaren missade den)')
  console.warn('    3 NEGATIV  ett skyddat fält fälls inte')
  console.warn('    4 NEGATIV  en strängunion efter ett booleskt enradsfält fälls INTE')
  console.warn('    5 NEGATIV  `example:` i en objektliteral är inget fält')
  console.warn('    6 POSITIV  ett fältnamn på å/ä/ö hittas')
  console.warn('   STRÄNGFORM')
  console.warn('    7 POSITIV  @IsString() utan @StrictString() fälls')
  console.warn('    8 NEGATIV  ett skyddat strängfält fälls inte')
  console.warn('    9 POSITIV  strängformens ENRADSFORM hittas')
  console.warn('   13 NEGATIV  @IsUUID() på ett strängTYPAT fält krävs INTE bära dekoratorn')
  console.warn('   FÖRBJUDNA DATUMVALIDATORER')
  console.warn('   10 POSITIV  @IsDateString() fälls')
  console.warn('   11 POSITIV  @IsISO8601() fälls')
  console.warn('   12 NEGATIV  @StrictIsoDatum() fälls inte')
  console.warn('   PROSA ÄR INTE KOD')
  console.warn('   14 POSITIV  en kommentar frikänner inte — och fäller inte heller')
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  selfTest()
}

const funna = oskyddade()
if (funna.length) {
  console.error('❌ Strikt koercion: ett DTO-fält kan läsa något annat än det klienten skickade\n')
  for (const p of funna) {
    if (p.sort === 'saknas') {
      console.error(
        `  ${p.fil}:${p.rad} — fältet ${p.falt} saknar @${p.form.dekorator}(). ${p.form.skada} ` +
          `Lägg till dekoratorn från ${p.form.modul}.`,
      )
    } else {
      console.error(
        `  ${p.fil}:${p.rad} — @${p.falt}() är förbjuden. Den är en alias för isISO8601 och ` +
          'godtar "2026-09-07T12:00:00" utan tidszon, som new Date() tolkar i SERVERNS lokaltid — ' +
          `en betalning kan hamna i fel bokföringsperiod. Använd @${p.forbjuden.ersatt}().`,
      )
    }
  }
  console.error(
    '\nINGEN BASLINJE. Regeln är absolut: mängden är noll, och ett nytt fält utan ' +
      'dekoratorn fäller bygget. Det finns ingen nivå där "det klienten skickade" och ' +
      '"det servern validerade" får vara olika saker.',
  )
  process.exit(1)
}

console.warn('✅ Strikt koercion: varje DTO-fält bär sin dekorator — 0 oskyddade.')
console.warn(
  '   Vakten mäter att dekoratorn FINNS. Att den GÖR något ägs av strict-boolean.spec.ts, ' +
    'strict-string.spec.ts och strict-iso-datum.spec.ts, som kör den riktiga pipen.',
)
