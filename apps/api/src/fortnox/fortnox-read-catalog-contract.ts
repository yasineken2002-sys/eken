import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'

/** Efter strict schemavalidering; samma katalogregler för båda checkpointversionerna. */
export function checkpointCatalogMatches(
  input: StartCheckpointInput,
  expectedDatabaseNumber: number,
  hasProjectMapping: boolean,
  catalog: CheckpointCatalog,
): boolean {
  const year = catalog.financialYear
  if (
    catalog.companyDatabaseNumber !== expectedDatabaseNumber ||
    year.id !== input.financialYearId ||
    year.fromDate > year.toDate ||
    input.periodFrom < year.fromDate ||
    input.periodTo > year.toDate ||
    (input.financialYearStart !== undefined && input.financialYearStart !== year.fromDate) ||
    (input.financialYearEnd !== undefined && input.financialYearEnd !== year.toDate)
  )
    return false
  const accounts = new Set(catalog.accounts.map((account) => account.number))
  if (
    accounts.size !== catalog.accounts.length ||
    accounts.size !== input.costAccounts.length ||
    input.costAccounts.some((account) => !accounts.has(account)) ||
    catalog.accounts.some((account) => account.active === false)
  )
    return false
  for (const [type, coverage] of [
    ['COST_CENTER', catalog.coverage.costCenters],
    ['PROJECT', catalog.coverage.projects],
  ] as const) {
    const codes = catalog.dimensions
      .filter((dimension) => dimension.type === type)
      .map((d) => d.code)
    if (!coverage) {
      if (codes.length || (type === 'PROJECT' && hasProjectMapping)) return false
      continue
    }
    if (
      new Set(codes).size !== codes.length ||
      coverage.totalResources !== codes.length ||
      coverage.itemsSeen < codes.length ||
      coverage.pages !== Math.max(1, coverage.totalPages) ||
      (coverage.totalPages === 0 && (coverage.totalResources !== 0 || coverage.itemsSeen !== 0))
    )
      return false
  }
  return true
}
