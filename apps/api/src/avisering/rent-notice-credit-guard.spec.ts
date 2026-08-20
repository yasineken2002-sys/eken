/**
 * #518 — VAKTER KRING KREDITERINGEN AV EN HYRESAVI.
 *
 * Tre saker ska bli RÖDA, inte tysta:
 *
 *   1. En andra väg som skriver en `RentNoticeCredit` (utan verifikat, utan
 *      spärrar) — en kreditering som inte går genom den sanktionerade vägen är
 *      ett belopp som försvinner ur skuldberäkningen utan motsvarighet i
 *      huvudboken.
 *   2. En FJÄRDE plats som summerar avins OCR-poster. Det var tre före det här
 *      ärendet, och den tredje — en inline-dubblett i bankavstämningen — hade
 *      tyst fortsatt matcha mot bruttot.
 *   3. Ett skuldbeslut som räknas UTAN krediteringarna.
 *
 * VARJE DETEKTOR HAR EN KANARIEFÅGEL. En vakt som inte kan falla mäter
 * ingenting: detektorn matas med indata som MÅSTE ge utslag, och med indata som
 * INTE får ge det. Bryts detektorn — ett ändrat fältnamn, en klammerstack som
 * driver — faller kanariefågeln FÖRST, innan någon hinner tro att kodbasen är
 * ren av att svepet gav noll träffar.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/** Enda filen som får skriva en kreditering. */
const SANKTIONERAD_SKRIVARE = 'avisering/rent-notice-credit.service.ts'

/** Enda filen som får summera avins OCR-poster. */
const SANKTIONERAD_SUMMERING = 'avisering/rent-debt.service.ts'

/**
 * Tar bort kommentarer före varje svep.
 *
 * INTE KOSMETIK. Kodbasen dokumenterar sig själv utförligt, och flera
 * kommentarer innehåller ordagrant `computeRentDebt(n)` eller summeringar av
 * avins kolumner som PROSA. Utan strippningen fäller vakten sin egen
 * dokumentation — och den som ser fyra falska träffar slutar lita på de äkta.
 */
function utanKommentarer(innehåll: string): string {
  return innehåll.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function allaTsFiler(dir: string): string[] {
  const ut: string[] = []
  for (const post of readdirSync(dir)) {
    const full = join(dir, post)
    if (statSync(full).isDirectory()) {
      ut.push(...allaTsFiler(full))
      continue
    }
    if (post.endsWith('.ts') && !post.endsWith('.spec.ts')) ut.push(full)
  }
  return ut
}

/* ────────────────────────────────────────────────────────────────────────────
 * DETEKTOR 1 — vem skriver en kreditering?
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hittar `tx.rentNoticeCredit.create(` / `.createMany(` — alltså SKRIVNINGAR,
 * inte läsningar. `findMany` på samma delegat är helt legitimt och förekommer på
 * fem ställen i skuldvägen; en detektor som inte skiljer dem åt hade tvingat
 * fram en undantagslista, alltså precis den uppräkning svepet finns för att
 * slippa.
 */
function skrivareAvKreditering(innehåll: string): string[] {
  const träffar: string[] = []
  const re =
    /\brentNoticeCredit\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(innehåll)) !== null) {
    const radStart = innehåll.lastIndexOf('\n', m.index) + 1
    const radSlut = innehåll.indexOf('\n', m.index)
    träffar.push(innehåll.slice(radStart, radSlut === -1 ? undefined : radSlut).trim())
  }
  return träffar
}

describe('#518 — vakt: bara EN väg skriver en kreditering', () => {
  it('KANARIEFÅGEL: detektorn ger utslag på skrivningar, och bara på dem', () => {
    expect(skrivareAvKreditering('await tx.rentNoticeCredit.create({ data: {} })')).toHaveLength(1)
    expect(skrivareAvKreditering('tx.rentNoticeCredit.deleteMany({})')).toHaveLength(1)
    // Läsningar är legitima och får ALDRIG fällas — annars blir vakten en
    // uppräkning av undantag i stället för en regel.
    expect(skrivareAvKreditering('await tx.rentNoticeCredit.findMany({})')).toHaveLength(0)
    expect(skrivareAvKreditering('credits: { select: { amount: true } }')).toHaveLength(0)
    // Namnlikhet får inte ge falskt utslag: RentNoticeCreditLine är en annan
    // tabell, och radskrivningen sker som nästlad create inuti föräldern.
    expect(skrivareAvKreditering('tx.rentNoticeCreditLine.findMany({})')).toHaveLength(0)
  })

  it('ingen annan produktionsfil skriver en kreditering', () => {
    const träffar: string[] = []
    for (const fil of allaTsFiler(SRC)) {
      const relativ = fil.slice(SRC.length + 1)
      if (relativ === SANKTIONERAD_SKRIVARE) continue
      for (const rad of skrivareAvKreditering(readFileSync(fil, 'utf8'))) {
        träffar.push(`${relativ}: ${rad}`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('den sanktionerade vägen finns kvar — svepet får inte bli tomt för att filen försvann', () => {
    // Utan den här raden vore föregående test grönt även om krediteringen
    // slutade existera. Ett tomt svep över en tom mängd bevisar ingenting.
    const innehåll = readFileSync(join(SRC, SANKTIONERAD_SKRIVARE), 'utf8')
    expect(skrivareAvKreditering(innehåll).length).toBeGreaterThan(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * DETEKTOR 2 — en fjärde summeringsplats
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hittar aritmetik som kombinerar avins två bärande kolumner (`totalAmount` och
 * `consumptionAmount`) och returnerar den OMSLUTANDE FUNKTIONENS kropp.
 *
 * ATT LÄSA KODEN, INTE TEXTEN: en radbaserad grep hade inte kunnat avgöra om
 * summan tar hänsyn till krediteringen, eftersom avdraget typiskt sker på en
 * annan rad. Detektorn klipper därför ut hela den omslutande funktionen med en
 * klammerstack och prövar villkoret mot den. Ett fast radfönster hade gett fel
 * svar så fort någon flyttade en rad.
 */
function funktionerSomSummerarOcrPoster(innehåll: string): string[] {
  const kroppar: string[] = []
  const rader = innehåll.split('\n')

  for (let i = 0; i < rader.length; i++) {
    const rad = rader[i]!
    if (!/totalAmount/.test(rad)) continue
    // Aritmetik, inte en select/include eller en fältkopiering.
    const fönster = rader.slice(i, i + 6).join('\n')
    if (!/consumptionAmount/.test(fönster)) continue
    if (!/[+\-]|\.plus\(|\.minus\(/.test(fönster)) continue
    if (/:\s*true/.test(rad)) continue

    // Gå bakåt till närmaste rad som ser ut som en funktionsstart på LÄGRE
    // indentering, och framåt till dess avslutande klammer.
    const indent = (r: string) => r.length - r.trimStart().length
    let start = i
    while (start > 0) {
      start--
      const r = rader[start]!
      if (r.trim() === '') continue
      // Ankaret måste vara en FUNKTIONSSTART. Första versionen accepterade varje
      // rad som slutade på `{` och landade därför på ett `if (…) {` några rader
      // ovanför — kroppen blev då för liten och missade `credited`-avdraget som
      // låg utanför if-satsen. En falsk träff i en vakt är dyrare än ingen vakt:
      // den lär den som läser att träffarna inte betyder något.
      if (indent(r) >= indent(rad)) continue
      if (/\b(if|for|while|switch|catch|try|else)\s*[({]/.test(r)) continue
      if (/\bfunction\b|=>|^\s*(?:private|public|protected|static|async)?\s*[\w$]+\s*\(/.test(r))
        break
    }
    let djup = 0
    let slut = start
    let sett = false
    for (let j = start; j < rader.length; j++) {
      for (const ch of rader[j]!) {
        if (ch === '{') {
          djup++
          sett = true
        } else if (ch === '}') djup--
      }
      slut = j
      if (sett && djup <= 0) break
    }
    kroppar.push(rader.slice(start, slut + 1).join('\n'))
    // MÅSTE gå framåt. Hittas ingen avslutande klammer landar `slut` på `start`,
    // som ligger BAKOM `i` — utan Math.max backar loopvariabeln och svepet
    // snurrar för evigt medan varje varv lägger på en filstor sträng. Uppmätt:
    // testkörningen dog med heap OOM efter 44 sekunder.
    i = Math.max(i, slut)
  }
  return kroppar
}

describe('#518 — vakt: ingen fjärde plats summerar avins OCR-poster blind för kreditering', () => {
  it('KANARIEFÅGEL: detektorn klipper ut funktionen som summerar, och bara den', () => {
    const summerar = [
      'function betalbart(n) {',
      '  return Number(n.totalAmount) + Number(n.consumptionAmount)',
      '}',
    ].join('\n')
    expect(funktionerSomSummerarOcrPoster(summerar)).toHaveLength(1)
    expect(funktionerSomSummerarOcrPoster(summerar)[0]).toContain('consumptionAmount')

    // En SELECT är ingen summering. Utan den här raden hade varje query i
    // kodbasen fällts och vakten tvingat fram en undantagslista.
    const select = [
      'const rad = await tx.rentNotice.findFirst({',
      '  select: { totalAmount: true, consumptionAmount: true },',
      '})',
    ].join('\n')
    expect(funktionerSomSummerarOcrPoster(select)).toHaveLength(0)

    // Och en ren fältkopiering utan aritmetik ska heller inte fällas.
    const kopia = [
      'function map(n) {',
      '  return { totalAmount: Number(n.totalAmount), consumptionAmount: Number(n.consumptionAmount) }',
      '}',
    ].join('\n')
    expect(funktionerSomSummerarOcrPoster(kopia)).toHaveLength(0)
  })

  it('varje summerande funktion tar hänsyn till krediteringen', () => {
    const blinda: string[] = []
    for (const fil of allaTsFiler(SRC)) {
      const relativ = fil.slice(SRC.length + 1)
      if (relativ === SANKTIONERAD_SUMMERING) continue
      for (const kropp of funktionerSomSummerarOcrPoster(
        utanKommentarer(readFileSync(fil, 'utf8')),
      )) {
        // Villkoret: funktionen måste NÄMNA krediteringen — antingen genom att
        // dra av den själv (`credited`) eller genom att delegera till den enda
        // definitionen (`rentNoticeOcrComponents` / `rentNoticePayableTotal`).
        if (/credited|rentNoticeOcrComponents|rentNoticePayableTotal|computeRentDebt/.test(kropp)) {
          continue
        }
        blinda.push(`${relativ}: ${kropp.split('\n')[0]!.trim()}`)
      }
    }
    expect(blinda).toEqual([])
  })

  it('den sanktionerade summeringen finns kvar', () => {
    const innehåll = readFileSync(join(SRC, SANKTIONERAD_SUMMERING), 'utf8')
    expect(funktionerSomSummerarOcrPoster(innehåll).length).toBeGreaterThan(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * DETEKTOR 3 — ett skuldbeslut utan credited-term
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hittar varje `computeRentDebt({ … })`-anrop och returnerar dess
 * argumentobjekt, så att kravet på en `credits`-nyckel kan prövas.
 *
 * TypeScript fäller redan ett anrop utan `credits` (fältet är obligatoriskt i
 * `RentDebtInput`) — men bara så länge fältet FÖRBLIR obligatoriskt. Görs det
 * valfritt "för bekvämlighets skull" blir varje befintlig anropare tyst blind
 * igen, och ingenting blir rött. Den här vakten är det som gör den ändringen
 * synlig: den prövar anropen, inte typen.
 */
function computeRentDebtAnrop(innehåll: string): string[] {
  const ut: string[] = []
  const nyckel = 'computeRentDebt('
  let i = innehåll.indexOf(nyckel)
  while (i !== -1) {
    let djup = 0
    let j = i + nyckel.length - 1
    for (; j < innehåll.length; j++) {
      const ch = innehåll[j]
      if (ch === '(') djup++
      else if (ch === ')') {
        djup--
        if (djup === 0) break
      }
    }
    ut.push(innehåll.slice(i, j + 1))
    i = innehåll.indexOf(nyckel, j)
  }
  return ut
}

describe('#518 — vakt: inget skuldbeslut räknas utan credited-term', () => {
  it('KANARIEFÅGEL: detektorn hittar anropen och ser skillnad på med och utan credits', () => {
    const utan = 'computeRentDebt({ type, totalAmount, allocations: [] })'
    const med = 'computeRentDebt({ type, totalAmount, allocations: [], credits: [] })'
    expect(computeRentDebtAnrop(utan)).toHaveLength(1)
    expect(computeRentDebtAnrop(utan)[0]).not.toContain('credits')
    expect(computeRentDebtAnrop(med)[0]).toContain('credits')
    // Nästlade parenteser får inte klippa argumentet för tidigt.
    const nästlat = 'computeRentDebt({ allocations: xs.map((a) => a.amount), credits: [] })'
    expect(computeRentDebtAnrop(nästlat)[0]).toContain('credits')
  })

  it('varje anrop i produktionskoden skickar krediteringarna', () => {
    const utan: string[] = []
    for (const fil of allaTsFiler(SRC)) {
      for (const anrop of computeRentDebtAnrop(utanKommentarer(readFileSync(fil, 'utf8')))) {
        // Deklarationen själv (`export function computeRentDebt(`) är inget anrop.
        if (/^computeRentDebt\(input:/.test(anrop)) continue
        // En SPREAD av ett redan typat indataobjekt (`{ ...debtInput, … }`) bär
        // krediteringarna med sig. Att kräva en bokstavlig `credits:`-nyckel
        // även där hade tvingat fram en meningslös upprepning — och en vakt som
        // kräver något meningslöst blir en vakt någon stänger av.
        if (/\.\.\./.test(anrop)) continue
        // Ett förbyggt indataobjekt som skickas vidare (`computeRentDebt(debtInput)`)
        // är redan typat som `RentDebtInput` och bär därmed krediteringarna.
        // Kravet gäller de anrop som konstruerar sitt argument PÅ PLATS — det är
        // där ett fält kan glömmas.
        if (!/\{/.test(anrop)) continue
        if (!/\bcredits\s*:/.test(anrop)) utan.push(`${fil.slice(SRC.length + 1)}: ${anrop}`)
      }
    }
    expect(utan).toEqual([])
  })

  it('det FINNS anrop att pröva — ett tomt svep bevisar ingenting', () => {
    let antal = 0
    for (const fil of allaTsFiler(SRC)) {
      antal += computeRentDebtAnrop(utanKommentarer(readFileSync(fil, 'utf8'))).length
    }
    expect(antal).toBeGreaterThan(5)
  })
})
