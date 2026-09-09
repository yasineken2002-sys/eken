const TABS = ['meters', 'tariffs', 'readings', 'charges', 'review'] as const
export type ConsumptionTab = (typeof TABS)[number]
export function consumptionSearch(search: Record<string, unknown>): { tab?: ConsumptionTab } {
  const tab = TABS.find((value) => value === search.tab)
  return tab ? { tab } : {}
}
