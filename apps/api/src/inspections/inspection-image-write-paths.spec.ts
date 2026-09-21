import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * VAKT: SIGNERADE BILAGOR SKA INTE GÅ ATT ÄNDRA ELLER RADERA NÅGON VÄG.
 *
 * ── VAD VAKTEN MÄTER ────────────────────────────────────────────────────────
 *
 * Att `InspectionImage` skrivs från EXAKT ETT ställe i hela API:et, och att det
 * stället ligger i `inspections.service.ts` — där varje skrivning föregås av
 * `lockAndAssertUnsigned` under radlås.
 *
 * Spärren i tjänsten hindrar den som går genom tjänsten. Den här vakten mäter
 * något annat: att ingen ANNAN modul har öppnat en egen väg in i samma tabell.
 * Det är den sortens lucka som uppstår långt efter att spärren skrivits, av
 * någon som inte visste att den fanns — och som inget enhetsprov över tjänsten
 * kan se, eftersom provet bara känner till de vägar det redan provar.
 *
 * ── VAKTEN MÅSTE KUNNA FALLA ────────────────────────────────────────────────
 *
 * En sökning som ger noll träffar ser likadan ut vare sig kodbasen är ren eller
 * sonden är trasig. `kanariefågel` nedan bevisar att skanningen HITTAR den
 * skrivning som faktiskt finns. Slutar den göra det är vaktens tystnad inte ett
 * besked om kodbasen, utan om sonden.
 *
 * ── VAD VAKTEN INTE KAN SE ──────────────────────────────────────────────────
 *
 *   • Rå SQL. `$executeRaw`/`$queryRaw` mot tabellen fångas inte av mönstret
 *     nedan, och en skrivning som går förbi Prisma går förbi vakten.
 *   • Lagringen. Vakten läser skrivningar mot DATABASRADEN. Att objektet i R2
 *     inte byts ut är en annan fråga, och den besvaras av bildkontrollen
 *     (`inspection-image-integrity.service.ts`) — som UPPTÄCKER ett byte men
 *     inte hindrar det. Den här kodbasen påstår inte lagringsimmutabilitet.
 *   • Dynamiska anrop. `prisma[modell].delete(...)` med modellnamnet i en
 *     variabel syns inte. Mätt: inget sådant mönster finns i kodbasen i dag,
 *     och vakten skulle inte se det om det kom.
 *   • Migrationer och skript utanför `src/`.
 *   • Skrivningar inuti kommentarer eller strängar — de rensas bort före
 *     sökningen, se `utanKommentarer`.
 */

const SRC = join(__dirname, '..')

/** Skrivande Prisma-operationer. Läsningar (`findMany` m.fl.) är inte med. */
const SKRIVOPERATIONER = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]

const MÖNSTER = new RegExp(`\\binspectionImage\\.(${SKRIVOPERATIONER.join('|')})\\b`, 'g')

/** Filen som FÅR skriva. Allt annat är ett fynd. */
const TILLÅTEN_FIL = 'inspections/inspections.service.ts'

/**
 * Tar bort kommentarer innan mönstret körs.
 *
 * Utan det här blir varje kommentar som NÄMNER en skrivväg ett fynd — och
 * kodbasen dokumenterar med flit gamla, borttagna skrivvägar i klartext
 * (`inspections.controller.ts` beskriver den `prisma.inspectionImage.create`
 * som togs bort i F025). En vakt som larmar på sin egen historieskrivning lär
 * läsaren att stänga av den.
 *
 * Priset är att en skrivning inuti en STRÄNG inte heller syns. Det är en
 * medveten avvägning: en strängliteral som råkar innehålla mönstret är ingen
 * skrivväg, och en `eval`-baserad skrivning fångas ändå inte av en textsökning.
 */
function utanKommentarer(innehåll: string): string {
  return innehåll
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

function tsFiler(katalog: string): string[] {
  const träffar: string[] = []
  for (const post of readdirSync(katalog)) {
    const full = join(katalog, post)
    if (statSync(full).isDirectory()) {
      if (post === 'node_modules' || post === 'generated') continue
      träffar.push(...tsFiler(full))
    } else if (post.endsWith('.ts')) {
      träffar.push(full)
    }
  }
  return träffar
}

type Träff = { fil: string; rad: number; text: string }

function skrivningar(): Träff[] {
  const funna: Träff[] = []
  for (const fil of tsFiler(SRC)) {
    // Specar räknas inte: de skriver mot sina egna fixturer, inte mot
    // produktens skrivvägar, och att förbjuda dem hade gjort vakten till ett
    // hinder för just de prov som bevisar spärren.
    if (fil.endsWith('.spec.ts')) continue
    const innehåll = utanKommentarer(readFileSync(fil, 'utf8'))
    innehåll.split('\n').forEach((text, i) => {
      MÖNSTER.lastIndex = 0
      if (MÖNSTER.test(text)) {
        funna.push({ fil: relative(SRC, fil), rad: i + 1, text: text.trim() })
      }
    })
  }
  return funna
}

describe('vakt: skrivvägar in i InspectionImage', () => {
  it('KANARIEFÅGEL: skanningen hittar den skrivning som FINNS', () => {
    // Utan den här raden kan vakten nedan vara grön av att sonden är trasig.
    const funna = skrivningar()
    expect(funna.length).toBeGreaterThan(0)
    expect(funna.some((t) => t.fil === TILLÅTEN_FIL)).toBe(true)
  })

  it('INGEN ANNAN MODUL skriver InspectionImage', () => {
    const främmande = skrivningar().filter((t) => t.fil !== TILLÅTEN_FIL)
    expect(främmande.map((t) => `${t.fil}:${t.rad} ${t.text}`)).toEqual([])
  })

  it('varje skrivande metod i tjänsten tar låset först', () => {
    const källa = readFileSync(join(SRC, TILLÅTEN_FIL), 'utf8')

    // Metoderna som rör bildrader, och den spärr var och en måste passera
    // innan den skriver. `skapaRattelse` tar sitt eget `FOR UPDATE` på källan
    // och skriver bara NYA rader — originalets bilder rörs inte.
    const kravPerMetod: { metod: string; spärr: string }[] = [
      { metod: 'async saveAnalysisImages(', spärr: 'lockAndAssertUnsigned' },
      { metod: 'async skapaRattelse(', spärr: 'FOR UPDATE' },
      { metod: 'async delete(', spärr: 'lockAndAssertUnsigned' },
    ]

    for (const { metod, spärr } of kravPerMetod) {
      const start = källa.indexOf(metod)
      expect(start).toBeGreaterThan(-1)
      // Kroppen fram till nästa metodstart på samma nivå räcker: spärren ska
      // stå TIDIGT, inte någonstans i filen.
      const kropp = källa.slice(start, start + 4000)
      expect(kropp.includes(spärr)).toBe(true)
    }
  })

  it('tjänsten raderar aldrig ett lagringsobjekt som hör till en besiktning', () => {
    // `delete()` tar bort DATABASRADERNA via kaskad. Lade den till en
    // `storage.deleteFile` hade originalets bilaga försvunnit även när en
    // rättelseversion pekar på samma nyckel — och bevisunderlaget med den.
    const källa = readFileSync(join(SRC, TILLÅTEN_FIL), 'utf8')
    expect(källa.includes('deleteFile')).toBe(false)
  })
})
