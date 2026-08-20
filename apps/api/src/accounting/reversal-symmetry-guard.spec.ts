/**
 * VAKT: ETT VERIFIKAT REVERSERAS EN GÅNG, OAVSETT VÄG.
 *
 * Skyddet vilar på att `reversalOfEntryId` ALLTID sätts, så att `@unique` på
 * kolumnen binder ihop samtliga reverseringsvägar. Två saker kan bryta det:
 *
 *   1. Den centrala tilldelningen i `createReversalEntry` tas bort eller görs
 *      villkorlig — då tappar alla vägar skyddet på en gång.
 *   2. Någon skriver ett motverifikat FÖRBI `createReversalEntry`, direkt genom
 *      `createNumberedEntry`. Den posten får ingen länk till sitt original och
 *      är osynlig för den unika spärren.
 *
 * ── VARFÖR VAKTEN INTE PRÖVAR "VARJE ANROP SKICKAR reversalOfEntryId" ────────
 *
 * Det var den formulering uppdraget bad om, och den vore i dag TOM: kolumnen
 * sätts centralt, så inget anropsställe skickar den. Att sätta den centralt är
 * starkare än att kräva det av anroparna — en ny reverseringsväg får skyddet
 * automatiskt i stället för att kunna glömma ett argument. Det som återstår att
 * bevaka är därför de två fallen ovan, och det ÄR den åttonde vägen i sin
 * verkliga form: en som inte går genom den delade kroppen alls.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const ACCOUNTING = join(SRC, 'accounting/accounting.service.ts')

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

/** Kommentarer strippas — kodbasen beskriver sig själv, och prosan innehåller mönstren. */
function utanKommentarer(innehåll: string): string {
  return innehåll.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ── DETEKTOR 1: den centrala tilldelningen ────────────────────────────────── */

/**
 * Sätter `createReversalEntry` `reversalOfEntryId` OVILLKORLIGT?
 *
 * Villkoret är det viktiga. Formen `...(x ? { reversalOfEntryId: y } : {})` —
 * exakt den som stod här före rättningen — ser vid en snabb läsning ut som att
 * fältet sätts, men gör det bara ibland. Detektorn kräver därför en rak
 * tilldelning och fäller den villkorliga spridningen.
 */
function sätterReversalOfEntryIdOvillkorligt(innehåll: string): boolean {
  // `\n  }` MÅSTE följas av radslut. Parametertypens avslut skrivs `  }) {` och
  // inleds med samma två tecken — en icke-girig match utan radslutskravet
  // stannade där och klippte bort hela kroppen, så detektorn läste en tom sträng
  // och rapporterade "ingen tilldelning" om kod som hade den.
  const kropp = /private async createReversalEntry\([\s\S]*?\n  \}\n/.exec(innehåll)?.[0] ?? ''
  if (!kropp) return false
  if (/\.\.\.\([^)]*reversalOfEntryId[^)]*\)/.test(kropp)) return false
  return /(^|\s)reversalOfEntryId:\s*params\.original\.id\s*,/m.test(kropp)
}

describe('vakt: den centrala tilldelningen finns och är ovillkorlig', () => {
  it('KANARIEFÅGEL: detektorn ser skillnad på rak och villkorlig tilldelning', () => {
    const rak = [
      'private async createReversalEntry(params: X) {',
      '    return this.createNumberedEntry({',
      '      reversalOfEntryId: params.original.id,',
      '    })',
      '  }',
      '',
    ].join('\n')
    expect(sätterReversalOfEntryIdOvillkorligt(rak)).toBe(true)

    // Den GAMLA formen — den som gjorde att sju av åtta vägar saknade länken.
    const villkorlig = rak.replace(
      '      reversalOfEntryId: params.original.id,',
      '      ...(params.reversalOfEntryId ? { reversalOfEntryId: params.reversalOfEntryId } : {}),',
    )
    expect(sätterReversalOfEntryIdOvillkorligt(villkorlig)).toBe(false)

    // Och en kropp utan tilldelning alls.
    const utan = rak.replace('      reversalOfEntryId: params.original.id,\n', '')
    expect(sätterReversalOfEntryIdOvillkorligt(utan)).toBe(false)
  })

  it('produktionskoden sätter den ovillkorligt', () => {
    expect(sätterReversalOfEntryIdOvillkorligt(readFileSync(ACCOUNTING, 'utf8'))).toBe(true)
  })
})

/* ── DETEKTOR 2: den åttonde vägen — ett motverifikat förbi den delade kroppen ── */

/**
 * Hittar skrivningar av ett MOTVERIFIKAT som INTE går genom
 * `createReversalEntry`: en `sourceId` i en reverseringsnamnrymd som skickas
 * till `createNumberedEntry` (eller rakt till `journalEntry.create`).
 *
 * Namnrymden är formen, inte en uppräkning av kända vägar: allt som slutar på
 * `-reversal:` eller inleds med `reversal:`. En lista över dagens sju vägar hade
 * behövt underhållas och missat den åttonde — vilket är hela poängen.
 */
function motverifikatFörbiDeladKropp(innehåll: string): string[] {
  const träffar: string[] = []
  const re = /(sourceId|reversalSourceId):\s*`([a-z][a-z-]*-reversal|reversal):/g
  let m: RegExpExecArray | null
  while ((m = re.exec(innehåll)) !== null) {
    // Är den här skrivningen argument till createReversalEntry? Leta bakåt efter
    // närmaste anropsstart; är det den delade kroppen är allt som det ska.
    const före = innehåll.slice(Math.max(0, m.index - 600), m.index)
    const senasteAnrop = /(createReversalEntry|createNumberedEntry|journalEntry\.create)\s*\(/g
    let sista: string | null = null
    let k: RegExpExecArray | null
    while ((k = senasteAnrop.exec(före)) !== null) sista = k[1]!
    if (sista === 'createReversalEntry') continue
    if (sista === null) continue
    const radStart = innehåll.lastIndexOf('\n', m.index) + 1
    const radSlut = innehåll.indexOf('\n', m.index)
    träffar.push(innehåll.slice(radStart, radSlut === -1 ? undefined : radSlut).trim())
  }
  return träffar
}

describe('vakt: inget motverifikat skrivs förbi den delade kroppen', () => {
  it('KANARIEFÅGEL: detektorn fäller förbivägen och släpper den sanktionerade', () => {
    // DEN ÅTTONDE VÄGEN: ett motverifikat skrivet direkt, utan länk till sitt
    // original. Måste ge utslag.
    const förbi = [
      'await this.createNumberedEntry({',
      '  source: `INVOICE`,',
      '  sourceId: `nytt-flode-reversal:${id}`,',
      '})',
    ].join('\n')
    expect(motverifikatFörbiDeladKropp(förbi)).toHaveLength(1)

    // Den sanktionerade vägen får INTE fällas — annars blir vakten en
    // undantagslista i stället för en regel.
    const sanktionerad = [
      'await this.createReversalEntry({',
      '  source: `INVOICE`,',
      '  reversalSourceId: `rent-notice-reversal:${noticeId}`,',
      '})',
    ].join('\n')
    expect(motverifikatFörbiDeladKropp(sanktionerad)).toHaveLength(0)

    // En vanlig, icke-reverserande post ska heller inte fällas.
    const vanlig = [
      'await this.createNumberedEntry({',
      '  sourceId: `rent-notice:${noticeId}`,',
      '})',
    ].join('\n')
    expect(motverifikatFörbiDeladKropp(vanlig)).toHaveLength(0)
  })

  it('ingen produktionsfil skriver ett motverifikat förbi createReversalEntry', () => {
    const träffar: string[] = []
    for (const fil of allaTsFiler(SRC)) {
      for (const rad of motverifikatFörbiDeladKropp(utanKommentarer(readFileSync(fil, 'utf8')))) {
        träffar.push(`${fil.slice(SRC.length + 1)}: ${rad}`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('det FINNS reverseringsvägar att pröva — ett tomt svep bevisar ingenting', () => {
    // Utan den här raden vore testet ovan grönt även om varje reversering
    // försvann ur kodbasen.
    const källa = readFileSync(ACCOUNTING, 'utf8')
    const antal = [...källa.matchAll(/reversalSourceId:\s*`/g)].length
    expect(antal).toBeGreaterThanOrEqual(7)
  })
})
