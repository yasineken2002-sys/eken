/**
 * Katalog över verifierade val för kundflödet (KATALOG-KONTRAKT-v1): räkenskapsår,
 * konton för ett valt år och dimensioner — hämtade ur det anslutna Fortnox-företaget.
 *
 * Ingen gissning: inga BAS-regler avgör vad som är "kostnad". Kontona erbjuds som
 * verifierade, aktiva konton som kunden uttryckligen väljer; måttet heter
 * "Nettobelopp för valda konton", aldrig bolagets resultat.
 *
 * En bruten eller avvikande paginering ger ready=false — aldrig en lyckad tom lista.
 */
import { FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

export interface FortnoxCatalog {
  ready: boolean
  reason: string | null
  financialYears: Array<{ id: number; from: string; to: string }>
  selectedFinancialYearId: number | null
  costAccounts: Array<{ number: number; name: string; selectable: boolean; reason: string | null }>
  dimensions: Array<{ dimensionType: 'COST_CENTER' | 'PROJECT'; code: string; name: string | null }>
  complete: boolean
  authLost: boolean
}

class Broken extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

async function all<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  key: string,
  query: Record<string, string | number> = {},
): Promise<T[]> {
  const out: T[] = []
  let first: [number, number] | null = null
  for (let page = 1; ; page++) {
    const body = await reader.get<Record<string, unknown>>(token, path, {
      ...query,
      page,
      limit: 100,
    })
    const mi = (body?.MetaInformation ?? {}) as Record<string, unknown>
    const [cp, tp, tr] = [mi['@CurrentPage'], mi['@TotalPages'], mi['@TotalResources']]
    if (!posInt(cp) || !posInt(tp) || !posInt(tr) || tp < 1 || cp !== page) {
      throw new Broken(`${path}: sidinformationen är ogiltig`)
    }
    if (!first) first = [tp, tr]
    else if (first[0] !== tp || first[1] !== tr)
      throw new Broken(`${path}: listan ändrades under läsningen`)
    const list = body?.[key]
    if (!Array.isArray(list)) throw new Broken(`${path}: listan saknas`)
    if (list.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) {
      throw new Broken(`${path}: ogiltigt element i listan`)
    }
    out.push(...(list as T[]))
    if (page >= tp) break
  }
  if (out.length !== first[1]) throw new Broken(`${path}: antalet stämmer inte`)
  return out
}

export async function readCatalog(
  reader: FortnoxLedgerReader,
  token: string,
  opts: { expectedDatabaseNumber: number; financialYearId: number | null },
): Promise<FortnoxCatalog> {
  const empty: FortnoxCatalog = {
    ready: false,
    reason: null,
    financialYears: [],
    selectedFinancialYearId: null,
    costAccounts: [],
    dimensions: [],
    complete: false,
    authLost: false,
  }
  try {
    const ci = await reader.get<{ CompanyInformation?: { DatabaseNumber?: unknown } }>(
      token,
      '/3/companyinformation',
    )
    if (ci?.CompanyInformation?.DatabaseNumber !== opts.expectedDatabaseNumber) {
      return { ...empty, reason: 'Fortnox svarade för ett annat företag än det anslutna' }
    }

    const years = await all<{ Id?: unknown; FromDate?: unknown; ToDate?: unknown }>(
      reader,
      token,
      '/3/financialyears',
      'FinancialYears',
    )
    const financialYears = years.map((y) => {
      if (
        !posInt(y.Id) ||
        y.Id < 1 ||
        typeof y.FromDate !== 'string' ||
        typeof y.ToDate !== 'string'
      ) {
        throw new Broken('Ett räkenskapsår saknar giltig identitet eller gränser')
      }
      if (!DATE.test(y.FromDate) || !DATE.test(y.ToDate) || y.FromDate > y.ToDate) {
        throw new Broken('Ett räkenskapsår har ogiltiga datum')
      }
      return { id: y.Id, from: y.FromDate, to: y.ToDate }
    })
    if (new Set(financialYears.map((y) => y.id)).size !== financialYears.length) {
      throw new Broken('Dubbla räkenskapsår i listan')
    }
    financialYears.sort((a, b) => b.from.localeCompare(a.from))

    const dims: FortnoxCatalog['dimensions'] = []
    for (const c of await all<{ Code?: unknown; Description?: unknown }>(
      reader,
      token,
      '/3/costcenters',
      'CostCenters',
    )) {
      if (typeof c.Code !== 'string' || !c.Code) throw new Broken('Kostnadsställe utan kod')
      dims.push({
        dimensionType: 'COST_CENTER',
        code: c.Code,
        name: typeof c.Description === 'string' ? c.Description : null,
      })
    }
    for (const p of await all<{ ProjectNumber?: unknown; Description?: unknown }>(
      reader,
      token,
      '/3/projects',
      'Projects',
    )) {
      const code =
        typeof p.ProjectNumber === 'string' || typeof p.ProjectNumber === 'number'
          ? String(p.ProjectNumber)
          : ''
      if (!code) throw new Broken('Projekt utan nummer')
      dims.push({
        dimensionType: 'PROJECT',
        code,
        name: typeof p.Description === 'string' ? p.Description : null,
      })
    }

    let selected: number | null = null
    const accounts: FortnoxCatalog['costAccounts'] = []
    if (opts.financialYearId !== null) {
      if (!financialYears.some((y) => y.id === opts.financialYearId)) {
        return {
          ...empty,
          financialYears,
          dimensions: dims,
          reason: 'Räkenskapsåret finns inte i Fortnox',
        }
      }
      selected = opts.financialYearId
      const list = await all<{ Number?: unknown; Description?: unknown; Active?: unknown }>(
        reader,
        token,
        '/3/accounts',
        'Accounts',
        { financialyear: selected },
      )
      for (const a of list) {
        if (!posInt(a.Number) || a.Number < 1000 || a.Number > 9999)
          throw new Broken('Konto med ogiltigt nummer')
        const active = a.Active === true
        accounts.push({
          number: a.Number,
          name: typeof a.Description === 'string' ? a.Description : '',
          selectable: active,
          reason: active ? null : 'Kontot är inaktivt i Fortnox',
        })
      }
      if (new Set(accounts.map((a) => a.number)).size !== accounts.length)
        throw new Broken('Dubbla konton i listan')
      accounts.sort((a, b) => a.number - b.number)
    }
    return {
      ready: true,
      reason: null,
      financialYears,
      selectedFinancialYearId: selected,
      costAccounts: accounts,
      dimensions: dims,
      complete: true,
      authLost: false,
    }
  } catch (err) {
    if (err instanceof Broken) return { ...empty, reason: err.message }
    if (err instanceof FortnoxReadError) {
      if (err.kind === 'auth')
        return { ...empty, authLost: true, reason: 'Fortnox-inloggningen har upphört; anslut igen' }
      if (err.kind === 'forbidden')
        return { ...empty, reason: 'Behörighet eller licens saknas i Fortnox' }
      return { ...empty, reason: 'Fortnox kunde inte läsas just nu; försök igen' }
    }
    throw err
  }
}
