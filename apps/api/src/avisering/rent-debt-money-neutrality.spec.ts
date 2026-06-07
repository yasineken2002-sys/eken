/**
 * Bankavstämnings-härdning — KATEGORI D: penganeutralitets-vakthund.
 *
 * Den HÅRDA kontraktsgränsen. Statiskt test som vägrar låta skuld-läsaren smyga in
 * penningpåverkan eller spridas till fel beslutsvägar:
 *
 *   1. RentDebtService rör ALDRIG huvudboken — ingen accounting/JournalEntry-
 *      referens i rent-debt.service.ts (det är ren läsning).
 *   2. outstanding() har EXAKT EN anropare: export-grinden
 *      (collections/rent-collection-export.service.ts, PR 2, INV-D). Den SKA
 *      referera RentDebtService.
 *   3. INGEN cron-/eskalerings-/kravbeslutsväg läser outstanding() — varken via
 *      import av RentDebtService eller .outstanding(-anrop.
 *
 * PR 1 satte "noll anropare". PR 2 öppnar grinden för export-vägen (och ENDAST den).
 * En framtida PR som kopplar in outstanding() i ytterligare en grind ska göra det
 * MEDVETET och samtidigt uppdatera detta test — inte råka göra det.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

// Enda sättet att nå skuld-läsaren är via symbolen RentDebtService (injiceras +
// importeras). `.outstanding(` används som defense-in-depth men EXKLUDERAR
// `this.outstanding(` — rent-bad-debt.service har en EGEN privat outstanding()-
// hjälpare (namnkrock som föregår serien, orörd).
const FOREIGN_OUTSTANDING = /(?<!this)\.outstanding\s*\(/

describe('Bank-härdning · D — penganeutralitet', () => {
  it('RentDebtService rör inte huvudboken (ingen accounting/JournalEntry-referens)', () => {
    const svc = read('avisering/rent-debt.service.ts')
    expect(svc).not.toMatch(/AccountingService/)
    expect(svc).not.toMatch(/journalEntry/i)
    expect(svc).not.toMatch(/createJournalEntry/)
  })

  it('export-grinden ÄR den tillåtna anroparen (PR 2, INV-D)', () => {
    const gate = read('collections/rent-collection-export.service.ts')
    expect(gate).toMatch(/RentDebtService/)
    expect(gate).toMatch(/\.outstanding\s*\(/)
  })

  // Cron-/eskalerings-/kravbeslutsvägar — ingen av dem får läsa outstanding().
  // (export-grinden är medvetet UTANFÖR denna lista — den är den tillåtna anroparen.)
  const FORBIDDEN_PATHS = [
    'avisering/avisering.scheduler.ts',
    'avisering/rent-reminder.service.ts',
    'avisering/rent-bad-debt.service.ts',
    'avisering/rent-interest.service.ts',
    'collections/collection-export.service.ts',
    'collections/rent-collections.controller.ts',
    'collections/collections.controller.ts',
  ]

  it.each(FORBIDDEN_PATHS)('%s anropar inte RentDebtService.outstanding()', (rel) => {
    const src = read(rel)
    expect(src).not.toMatch(/RentDebtService/)
    expect(src).not.toMatch(FOREIGN_OUTSTANDING)
  })

  it('ingen förbjuden beslutsväg når outstanding() (varken via import eller anrop)', () => {
    const offenders = FORBIDDEN_PATHS.filter(
      (rel) => /RentDebtService/.test(read(rel)) || FOREIGN_OUTSTANDING.test(read(rel)),
    )
    expect(offenders).toEqual([])
  })
})
