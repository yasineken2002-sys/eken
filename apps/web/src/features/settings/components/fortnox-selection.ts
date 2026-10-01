import { fortnoxReadInputSchema } from '../api/fortnox.api'
import type {
  FortnoxCatalogResponse,
  FortnoxReadInput,
  FortnoxMappingInput,
} from '../api/fortnox.api'

export function verifyCatalog(catalog: FortnoxCatalogResponse, companyNumber: number): void {
  if (!catalog.ready || !catalog.complete)
    throw new Error('Katalogen är inte komplett. Hämta om valen.')
  if (catalog.company.databaseNumber !== companyNumber)
    throw new Error('Företaget i katalogen stämmer inte. Hämta om status och val.')
}

export function buildReadSelection(
  catalog: FortnoxCatalogResponse,
  companyNumber: number,
  selection: {
    yearId: number | null
    from: string
    to: string
    accounts: number[]
  },
): FortnoxReadInput {
  verifyCatalog(catalog, companyNumber)
  const year = catalog.financialYears.find((item) => item.id === selection.yearId)
  if (!year || catalog.selectedFinancialYearId !== year.id)
    throw new Error('Välj ett verifierat räkenskapsår och invänta dess konton.')
  if (
    !selection.accounts.length ||
    selection.accounts.some(
      (number) =>
        !catalog.costAccounts.some((account) => account.number === number && account.selectable),
    )
  )
    throw new Error('Välj minst ett tillgängligt konto från listan.')
  const input = {
    financialYearId: year.id,
    financialYearStart: year.from,
    financialYearEnd: year.to,
    periodFrom: selection.from,
    periodTo: selection.to,
    costAccounts: [...new Set(selection.accounts)].sort((a, b) => a - b),
  }
  if (!fortnoxReadInputSchema.safeParse(input).success)
    throw new Error(
      'Välj giltiga datum inom räkenskapsåret. Från-datum får inte ligga efter till-datum.',
    )
  return input
}

export const dimensionKey = (value: { dimensionType: string; code: string }) =>
  `${value.dimensionType}:${value.code}`

export function buildMappingSelection(
  catalog: FortnoxCatalogResponse,
  companyNumber: number,
  selection: { dimensionKey: string; propertyId: string },
  properties: readonly { id: string; organizationId: string }[],
  organizationId: string,
): FortnoxMappingInput {
  verifyCatalog(catalog, companyNumber)
  const dimension = catalog.dimensions.find((item) => dimensionKey(item) === selection.dimensionKey)
  const property = properties.find(
    (item) => item.id === selection.propertyId && item.organizationId === organizationId,
  )
  if (!dimension || !property)
    throw new Error('Välj en dimension från katalogen och en fastighet i din organisation.')
  return {
    dimensionType: dimension.dimensionType,
    code: dimension.code,
    propertyId: property.id,
  }
}
