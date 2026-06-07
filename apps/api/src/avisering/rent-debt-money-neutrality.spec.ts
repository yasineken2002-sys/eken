/**
 * Bankavstämnings-härdning — KATEGORI D: penganeutralitets-vakthund.
 *
 * Den HÅRDA kontraktsgränsen. Statiskt test som vägrar låta skuld-läsaren smyga in
 * penningpåverkan eller spridas till fel beslutsvägar:
 *
 *   1. RentDebtService rör ALDRIG huvudboken — ingen accounting/JournalEntry-
 *      referens i rent-debt.service.ts (det är ren läsning).
 *   2. outstanding() får läsas av EXAKT denna uppsättning beslutsvägar:
 *        • export-grinden (collections/rent-collection-export.service.ts, PR 2, INV-D)
 *        • kravtrappans eskalering (avisering/rent-reminder.service.ts, PR 3a, INV-A)
 *        • befarad kundförlust (avisering/rent-bad-debt.service.ts, PR 3a, INV-A)
 *      Var och en SKA referera RentDebtService.
 *   3. INGEN annan cron/ränta/faktura-export/controller/scheduler läser outstanding()
 *      — varken via import av RentDebtService eller .outstanding(-anrop.
 *
 * Utveckling: PR 1 satte "noll anropare". PR 2 öppnade export-vägen. PR 3a öppnar de
 * två eskaleringstjänsterna (och ENDAST dem). En framtida PR som kopplar in
 * outstanding() i ytterligare en väg ska göra det MEDVETET och uppdatera detta test.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

// Enda sättet att nå skuld-läsaren är via symbolen RentDebtService (injiceras +
// importeras). `.outstanding(` används som defense-in-depth men EXKLUDERAR
// `this.outstanding(` (egna privata namnkrockar). OBS: rent-bad-debts tidigare
// privata outstanding()-hjälpare är BORTTAGEN i PR 3a (en sanningskälla).
const FOREIGN_OUTSTANDING = /(?<!this)\.outstanding\s*\(/

describe('Bank-härdning · D — penganeutralitet', () => {
  it('RentDebtService rör inte huvudboken (ingen accounting/JournalEntry-referens)', () => {
    const svc = read('avisering/rent-debt.service.ts')
    expect(svc).not.toMatch(/AccountingService/)
    expect(svc).not.toMatch(/journalEntry/i)
    expect(svc).not.toMatch(/createJournalEntry/)
  })

  // Vägar som FÅR läsa outstanding() — var och en SKA referera RentDebtService.
  const ALLOWED_READERS = [
    'collections/rent-collection-export.service.ts', // PR 2 — export-grind (INV-D)
    'avisering/rent-reminder.service.ts', // PR 3a — eskalering (INV-A)
    'avisering/rent-bad-debt.service.ts', // PR 3a — befarad kundförlust (INV-A)
  ]

  it.each(ALLOWED_READERS)('%s ÄR en tillåten skuld-läsare (refererar RentDebtService)', (rel) => {
    const src = read(rel)
    expect(src).toMatch(/RentDebtService/)
    expect(src).toMatch(/\.outstanding\s*\(/)
  })

  // Vägar som ALDRIG får läsa skuld — ränta, faktura-export, controllers, scheduler.
  const FORBIDDEN_PATHS = [
    'avisering/avisering.scheduler.ts',
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
