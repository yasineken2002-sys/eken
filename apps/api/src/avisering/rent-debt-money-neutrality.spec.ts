/**
 * Bankavstämnings-härdning PR 1 — KATEGORI D: penganeutralitets-vakthund.
 *
 * Den HÅRDA kontraktsgränsen för grund-PR:n. Ett statiskt test som vägrar låta
 * PR 1 smyga in penningpåverkan:
 *
 *   1. RentDebtService rör ALDRIG huvudboken — ingen accounting/JournalEntry-
 *      referens i rent-debt.service.ts (det är ren läsning).
 *   2. INGEN eskalerings-/export-/kravbeslutsväg läser outstanding() ÄNNU —
 *      varken via import av RentDebtService eller .outstanding(-anrop.
 *
 * Om en framtida PR vill koppla in outstanding() i en grind ska den göra det
 * MEDVETET och samtidigt uppdatera detta test — inte råka göra det.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('PR1 · D — penganeutralitet', () => {
  it('RentDebtService rör inte huvudboken (ingen accounting/JournalEntry-referens)', () => {
    const svc = read('avisering/rent-debt.service.ts')
    expect(svc).not.toMatch(/AccountingService/)
    expect(svc).not.toMatch(/journalEntry/i)
    expect(svc).not.toMatch(/createJournalEntry/)
  })

  // Vägar som FÅR ta eskalerings-/export-/kravbeslut — ingen av dem får läsa
  // outstanding() i PR 1.
  const DECISION_PATHS = [
    'avisering/avisering.scheduler.ts',
    'avisering/rent-reminder.service.ts',
    'avisering/rent-bad-debt.service.ts',
    'avisering/rent-interest.service.ts',
    'collections/rent-collection-export.service.ts',
    'collections/collection-export.service.ts',
    'collections/rent-collections.controller.ts',
    'collections/collections.controller.ts',
  ]

  // Enda sättet att nå PR1:s läsare är via symbolen RentDebtService (injiceras +
  // importeras). Det är den robusta grinden. `.outstanding(` används som defense-
  // in-depth men EXKLUDERAR `this.outstanding(` — rent-bad-debt.service har en
  // EGEN privat outstanding()-hjälpare (namnkrock som föregår PR 1, orörd).
  const FOREIGN_OUTSTANDING = /(?<!this)\.outstanding\s*\(/

  it.each(DECISION_PATHS)('%s anropar inte RentDebtService.outstanding()', (rel) => {
    const src = read(rel)
    expect(src).not.toMatch(/RentDebtService/)
    expect(src).not.toMatch(FOREIGN_OUTSTANDING)
  })

  it('ingen beslutsväg når PR1:s outstanding() (varken via import eller anrop)', () => {
    const offenders = DECISION_PATHS.filter(
      (rel) => /RentDebtService/.test(read(rel)) || FOREIGN_OUTSTANDING.test(read(rel)),
    )
    expect(offenders).toEqual([])
  })
})
