/**
 * ANROPAS DEN DELADE KONTERINGEN AV BÅDA VÄGARNA?
 *
 * `manual-entry-parity.spec.ts` mäter att funktionerna ÄR en funktion. Det här
 * provet mäter PÅKOPPLINGEN: att `tool-executor.service.ts` (AI) och
 * `accounting.service.ts` (människa) faktiskt går genom dem, och att den gamla
 * inline-konteringen är borta.
 *
 * Ett paritetsprov kan inte se en återinförd kopia — den hade gett samma rader
 * i provet och ändå kunnat glida isär i morgon. Därför läses källtexten.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att anropen ligger på rätt gren, eller att resultatet används. Det ägs av
 * `manual-entry.spec.ts` (funktionerna), av tool-executorns egna specar och av
 * `accounting.manual-entry.db.spec.ts` (hela vägen mot riktig Postgres).
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const ROT = join(__dirname, '..')

function las(relativ: string): string {
  return readFileSync(join(ROT, relativ), 'utf8')
}

describe('den delade konteringen är påkopplad i BÅDA vägarna', () => {
  const executor = las('ai/tools/tool-executor.service.ts')
  const service = las('accounting/accounting.service.ts')

  it('KANARIEFÅGEL: filerna lästes och är inte tomma', () => {
    // Utan den här raden är varje `toContain` nedan grön för en tom sträng —
    // nej, den är röd; men en FELSTAVAD sökväg hade kastat, och en trunkerad
    // läsning hade gett falska negativ. Talet gör läsningen synlig.
    expect(executor.length).toBeGreaterThan(50_000)
    expect(service.length).toBeGreaterThan(50_000)
  })

  it('AI-vägen anropar byggVerifikatrader och byggUtgiftsrader', () => {
    expect(executor).toContain("from '../../accounting/manual-entry'")
    expect(executor).toContain('byggVerifikatrader(')
    expect(executor).toContain('byggUtgiftsrader(')
  })

  it('människovägen anropar samma två funktioner', () => {
    expect(service).toContain("from './manual-entry'")
    expect(service).toContain('byggVerifikatrader(')
    expect(service).toContain('byggUtgiftsrader(')
  })

  it('den gamla inline-konteringen är BORTA ur tool-executorn', () => {
    // De två raderna var kärnan i kopian: kontouppslaget byggdes lokalt och
    // 1930/2641 slogs upp för hand. Står de kvar finns en andra implementation
    // kvar vid sidan av den delade — vilket är precis det här provets ärende.
    expect(executor).not.toContain('const accountByNumber = new Map(')
    expect(executor).not.toContain('accountByNumber.get(1930)')
    expect(executor).not.toContain('accountByNumber.get(2641)')
  })

  it('båda verktygen har en mänsklig väg i human-path.ts', () => {
    const humanPath = las('ai/tools/human-path.ts')
    expect(humanPath).toContain(
      "create_journal_entry: { rutt: '/accounting', atgard: 'Ny verifikation' }",
    )
    expect(humanPath).toContain(
      "record_expense: { rutt: '/accounting', atgard: 'Registrera utgift' }",
    )
  })
})
