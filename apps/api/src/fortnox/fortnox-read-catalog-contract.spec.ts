import { checkpointCatalogMatches } from './fortnox-read-catalog-contract'
import {
  CheckpointCatalogSchema,
  type CheckpointCatalog,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'

const input: StartCheckpointInput = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const emptyCoverage = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
function catalog(): CheckpointCatalog {
  return {
    version: 1,
    companyDatabaseNumber: 900001,
    financialYear: {
      id: 1,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      accountingMethod: null,
    },
    accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: -125 }],
    dimensions: [],
    coverage: { costCenters: { ...emptyCoverage } },
  }
}

/** Handvalda v1-policyfall: ingen provider, modell eller hash används som facit. */
describe('Gemensam katalogpolicy bevarar v1:s betydelse', () => {
  it('okänd aktivitet/metod och negativ ingående balans förblir uttryckliga värden', () => {
    const value = catalog()
    const before = JSON.stringify(value)
    expect(checkpointCatalogMatches(input, 900001, false, value)).toBe(true)
    expect(JSON.stringify(value)).toBe(before)
    expect(value.accounts[0]).toStrictEqual({
      number: 5170,
      active: null,
      balanceBroughtForwardOre: -125,
    })
  })

  it('en fryst projektkoppling tillåter en verifierad tom projektlista', () => {
    const value = catalog()
    expect(checkpointCatalogMatches(input, 900001, true, value)).toBe(false)
    value.coverage.projects = { ...emptyCoverage }
    expect(checkpointCatalogMatches(input, 900001, true, value)).toBe(true)
  })

  it('bevarar distinkta dimensionstyper och redovisade identiska listdubletter', () => {
    const value = catalog()
    value.dimensions = [
      { type: 'COST_CENTER', code: 'A' },
      { type: 'PROJECT', code: 'A' },
    ]
    value.coverage = {
      costCenters: { pages: 2, totalPages: 2, totalResources: 1, itemsSeen: 2 },
      projects: { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
    }
    expect(checkpointCatalogMatches(input, 900001, true, value)).toBe(true)
  })

  it('katalogkontonas ordning ändrar inte det exakta kontourvalet', () => {
    const value = catalog()
    value.accounts.unshift({ number: 5190, active: true, balanceBroughtForwardOre: null })
    expect(
      checkpointCatalogMatches({ ...input, costAccounts: [5170, 5190] }, 900001, false, value),
    ).toBe(true)
    expect(value.accounts.map((a) => a.number)).toStrictEqual([5190, 5170])
  })

  it('accepterar ett längre räkenskapsår när period och uttryckliga gränser stämmer', () => {
    const value = catalog()
    value.financialYear.fromDate = '2025-07-01'
    expect(
      checkpointCatalogMatches(
        { ...input, financialYearStart: '2025-07-01', financialYearEnd: '2026-12-31' },
        900001,
        false,
        value,
      ),
    ).toBe(true)
  })

  const invalidCases: Array<{ name: string; change: (value: CheckpointCatalog) => void }> = [
    {
      name: 'fel företag',
      change: (v) => {
        v.companyDatabaseNumber = 900002
      },
    },
    {
      name: 'fel åridentitet',
      change: (v) => {
        v.financialYear.id = 2
      },
    },
    {
      name: 'bakvänt år',
      change: (v) => {
        v.financialYear.fromDate = '2027-01-01'
      },
    },
    {
      name: 'periodens första dag före året',
      change: (v) => {
        v.financialYear.fromDate = '2026-10-02'
      },
    },
    {
      name: 'periodens sista dag efter året',
      change: (v) => {
        v.financialYear.toDate = '2026-10-30'
      },
    },
    {
      name: 'valt konto saknas',
      change: (v) => {
        v.accounts = []
      },
    },
    {
      name: 'extra konto',
      change: (v) => {
        v.accounts.push({ number: 5190, active: true, balanceBroughtForwardOre: 0 })
      },
    },
    {
      name: 'dubbelt konto',
      change: (v) => {
        v.accounts.push({ number: 5170, active: null, balanceBroughtForwardOre: -125 })
      },
    },
    {
      name: 'uttryckligen inaktivt konto',
      change: (v) => {
        v.accounts[0]!.active = false
      },
    },
    {
      name: 'dubblerad dimensionskod inom samma typ',
      change: (v) => {
        v.dimensions = [
          { type: 'COST_CENTER', code: 'A' },
          { type: 'COST_CENTER', code: 'A' },
        ]
        v.coverage.costCenters = { pages: 1, totalPages: 1, totalResources: 2, itemsSeen: 2 }
      },
    },
    {
      name: 'fler angivna resurser än distinkta koder',
      change: (v) => {
        v.coverage.costCenters = { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 }
      },
    },
    {
      name: 'färre observerade än distinkta koder',
      change: (v) => {
        v.dimensions = [{ type: 'COST_CENTER', code: 'A' }]
        v.coverage.costCenters = { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 0 }
      },
    },
    {
      name: 'inte alla sidor observerade',
      change: (v) => {
        v.coverage.costCenters.totalPages = 2
      },
    },
    {
      name: 'tom samling utan första sidbevis',
      change: (v) => {
        v.coverage.costCenters.pages = 0
      },
    },
    {
      name: 'noll sidor men observerade objekt',
      change: (v) => {
        v.coverage.costCenters.itemsSeen = 1
      },
    },
    {
      name: 'projektkod utan projektcoverage även utan projektkoppling',
      change: (v) => {
        v.dimensions = [{ type: 'PROJECT', code: 'P1' }]
      },
    },
  ]
  it.each(invalidCases)('nekar $name utan att ändra kandidat', ({ change }) => {
    const value = catalog()
    change(value)
    // Dessa kroppar är giltigt formade; det är bindnings-/täckningspolicyn som fäller dem.
    expect(CheckpointCatalogSchema.safeParse(value).success).toBe(true)
    const before = JSON.stringify(value)
    expect(checkpointCatalogMatches(input, 900001, false, value)).toBe(false)
    expect(JSON.stringify(value)).toBe(before)
  })

  it.each([{ financialYearStart: '2026-02-01' }, { financialYearEnd: '2026-11-30' }])(
    'nekar ändrade uttryckliga årgränser: %j',
    (bounds) => {
      expect(checkpointCatalogMatches({ ...input, ...bounds }, 900001, false, catalog())).toBe(
        false,
      )
    },
  )
})
