import { expect, it } from 'vitest'
import { consumptionSearch } from './consumption-tab'
it('tillåter bara befintliga flikar och tappar främmande sökfält', () => {
  expect(consumptionSearch({ tab: 'review', organizationId: 'other' })).toEqual({ tab: 'review' })
  for (const tab of ['meters', 'tariffs', 'readings', 'charges'])
    expect(consumptionSearch({ tab })).toEqual({ tab })
  for (const tab of ['unknown', '/other', ['review'], 1, null])
    expect(consumptionSearch({ tab })).toEqual({})
})
