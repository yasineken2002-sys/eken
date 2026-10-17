/**
 * Återläsning av Fortnox huvudbok → källmärkt underlag. Ren logik + injicerad läsport.
 *
 * Port av den granskade offline-riggen (FORTNOX-PROVBEREDSKAP v2, APPROVED) med
 * PERIOD-modellen och KVALITETSTILLAGG-01:
 *
 *  - Summan är summan av UNIKA bokförda verifikatrader på valda konton. Ingen rad
 *    ersätter en annan via ReferenceType/ReferenceNumber — rättelser (återföring +
 *    ny post, eller differens) deltar med sina egna rader och datum.
 *  - Samma identitet (år, serie, nummer) med annat innehåll i samma läsning = KONFLIKT.
 *  - Sidmetadata (@CurrentPage/@TotalPages/@TotalResources) ska vara heltal och
 *    konstanta; antalet unika identiteter ska stämma. Det bevisar KOMPLETT
 *    TRAVERSERING, inte en atomisk ögonblicksbild — utbytt innehåll med samma
 *    antal syns inte i ett pass.
 *  - Removed=true: semantiken är obelagd → egen osäker hink, aldrig tyst.
 *  - Dimension: radens CostCenter (annars Project) via UTTRYCKLIG mappning.
 *    Huvudets dimension ärvs inte. Okänd kod → okopplad, synlig.
 *  - Räkenskapsårets gränser och de valda kontona hämtas och kontrolleras mot
 *    Fortnox (GET /3/financialyears/{Id}, /3/accounts/{n}); klientens uppgifter är
 *    inget bevis. Period väljs på verifikatets TransactionDate inom det året.
 *    Hela året traverseras och valideras före periodurvalet.
 *  - Ofullständig läsning ger summary=null, aldrig noll.
 *  - Belopp i heltal öre; mer än två decimaler är ogiltigt indata.
 */
import { isExactEmptyFirstPage } from './fortnox-pagination'
import { FortnoxReadError, type FortnoxLedgerReader, type FortnoxVoucher } from './fortnox.types'
import { createLedgerAccumulator, selectVerifiedLedgerMappings } from './fortnox-ledger-reducer'
import {
  Incomplete,
  isDate,
  isPosInt,
  stable,
  voucherKey,
  toOre,
  validateLedgerVoucher,
  type ValidatedLedgerVoucher,
} from './fortnox-ledger-validation'

// Behåller befintliga importer och samma felklass, bland annat i sändningens läsgrind.
export { Incomplete, toOre } from './fortnox-ledger-validation'

export type LedgerStatus =
  | 'COMPLETE'
  | 'COMPLETE_WITH_UNCERTAINTY'
  | 'PARTIAL'
  | 'FAILED'
  | 'AUTH_LOST'
  | 'WRONG_COMPANY'

export interface LedgerReadConfig {
  expectedDatabaseNumber: number
  financialYearId: number
  /** YYYY-MM-DD, inkluderande. Måste ligga inom räkenskapsåret som Fortnox anger. */
  periodFrom: string
  periodTo: string
  costAccounts: number[]
  /** `${type}:${code}` → fastighet. */
  mappings: ReadonlyMap<string, { propertyId: string; propertyName: string }>
  /** `${år}|${serie}|${nummer}` för verifikat som Eveno själv exporterat. */
  evenoExported: ReadonlySet<string>
}

export interface Coverage {
  pages: number
  totalPages: number
  totalResources: number
  itemsSeen: number
}

export interface LedgerRowProvenance {
  voucher: string
  row: number
  transactionDate: string
  account: number
  amountOre: number
  bucket: 'PROPERTY' | 'UNMAPPED' | 'UNALLOCATED' | 'UNCERTAIN_REMOVED'
  dimensionType: 'COST_CENTER' | 'PROJECT' | null
  code: string | null
  propertyId: string | null
  evenoExport: boolean
  /**
   * TESTKUND-008 K7.1: för Evenos EGNA exporter (exakt identitet) — vilket Eveno-verifikat och
   * vilket Eveno-källkonto raden kommer från, och vilken kontomappningsrevision som användes.
   * Ingår aldrig i summeringen; summan räknar raden en gång som i dag.
   */
  evenoSource?: {
    journalEntryId: string
    sourceAccount: number | null
    mappingRevision: number | null
  }
}

export interface LedgerSummary {
  currency: 'SEK'
  totalOre: number
  byProperty: Array<{ propertyId: string; propertyName: string; amountOre: number }>
  unmappedDimensions: Array<{
    dimensionType: 'COST_CENTER' | 'PROJECT'
    code: string
    amountOre: number
  }>
  unallocatedOre: number
  uncertainRemovedOre: number
  evenoExportOre: number
  /**
   * KUNDSTART-001 §12.6: Fortnox `BalanceBroughtForward` (ingående balans för året) per
   * valt konto, i öre med Fortnox tecken (debet +, kredit −). null = fältet saknades i
   * svaret — aldrig tolkat som 0. Ingår INTE i totalOre (som är periodens rörelse).
   */
  balanceBroughtForwardOre?: Record<string, number | null>
  /** KUNDSTART K-B8: räkenskapsårets AccountingMethod enligt Fortnox (null = saknades). */
  financialYearAccountingMethod?: string | null
}

export interface LedgerReadResult {
  status: LedgerStatus
  /** Räkenskapsåret enligt Fortnox; null om det inte hann läsas/verifieras. */
  financialYear: { id: number; fromDate: string; toDate: string } | null
  reason: string | null
  summary: LedgerSummary | null
  rows: LedgerRowProvenance[] | null
  coverage: Record<string, Coverage>
  uncertainties: string[]
  references: Array<{
    voucher: string
    referenceType: string | null
    referenceNumber: string | null
  }>
}

export async function paged<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  key: string,
  query: Record<string, string | number>,
  coverage: Record<string, Coverage>,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = []
  let page = 1
  let first: { tp: number; tr: number } | null = null
  for (;;) {
    const body = await reader.get<Record<string, unknown>>(token, path, {
      ...query,
      page,
      limit: 100,
    })
    if (isExactEmptyFirstPage(page, body, key)) {
      coverage[path] = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
      return { items, total: 0 }
    }
    const mi = (body?.MetaInformation ?? {}) as Record<string, unknown>
    const cp = mi['@CurrentPage']
    const tp = mi['@TotalPages']
    const tr = mi['@TotalResources']
    if (!isPosInt(cp) || !isPosInt(tp) || !isPosInt(tr) || tp < 1) {
      throw new Incomplete(`${path}: sidinformation saknas eller är ogiltig`)
    }
    if (cp !== page) throw new Incomplete(`${path}: begärde sida ${page} men fick ${cp}`)
    if (!first) first = { tp, tr }
    else if (first.tp !== tp || first.tr !== tr) {
      throw new Incomplete(`${path}: antalet ändrades under läsningen`)
    }
    const list = body?.[key]
    if (!Array.isArray(list)) throw new Incomplete(`${path}: listan saknas på sida ${page}`)
    // P-null: varje element måste vara ett objekt innan något fält läses.
    if (list.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) {
      throw new Incomplete(`${path}: ogiltigt element på sida ${page}`)
    }
    items.push(...(list as T[]))
    if (page >= tp) break
    page += 1
  }
  coverage[path] = {
    pages: page,
    totalPages: first.tp,
    totalResources: first.tr,
    itemsSeen: items.length,
  }
  return { items, total: first.tr }
}

export async function readLedger(
  reader: FortnoxLedgerReader,
  token: string,
  cfg: LedgerReadConfig,
): Promise<LedgerReadResult> {
  const coverage: Record<string, Coverage> = {}
  const uncertainties: string[] = []
  const base = {
    coverage,
    uncertainties,
    references: [] as LedgerReadResult['references'],
    financialYear: null as LedgerReadResult['financialYear'],
  }
  const fail = (status: LedgerStatus, reason: string): LedgerReadResult => ({
    status,
    reason,
    summary: null,
    rows: null,
    ...base,
  })

  for (const d of [cfg.periodFrom, cfg.periodTo]) {
    if (!isDate(d)) return fail('FAILED', `Ogiltigt datum: ${String(d)}`)
  }
  if (cfg.periodFrom > cfg.periodTo) return fail('FAILED', 'Periodens start ligger efter dess slut')
  if (cfg.costAccounts.length === 0) return fail('FAILED', 'Inga konton valda')

  try {
    const ci = await reader.get<{ CompanyInformation?: { DatabaseNumber?: unknown } }>(
      token,
      '/3/companyinformation',
    )
    if (ci?.CompanyInformation?.DatabaseNumber !== cfg.expectedDatabaseNumber) {
      return fail('WRONG_COMPANY', 'Fortnox svarade för ett annat företag än det anslutna')
    }

    const fy = await reader.get<{
      FinancialYear?: {
        Id?: unknown
        FromDate?: unknown
        ToDate?: unknown
        AccountingMethod?: unknown
      }
    }>(token, `/3/financialyears/${cfg.financialYearId}`)
    const y = fy?.FinancialYear
    if (
      !y ||
      y.Id !== cfg.financialYearId ||
      !isDate(y.FromDate) ||
      !isDate(y.ToDate) ||
      y.FromDate > y.ToDate
    ) {
      throw new Incomplete('Räkenskapsåret kunde inte verifieras i Fortnox')
    }
    base.financialYear = { id: cfg.financialYearId, fromDate: y.FromDate, toDate: y.ToDate }
    if (cfg.periodFrom < y.FromDate || cfg.periodTo > y.ToDate) {
      return fail('FAILED', `Perioden måste ligga inom räkenskapsåret ${y.FromDate}–${y.ToDate}`)
    }
    const yearStart = y.FromDate
    const yearEnd = y.ToDate

    const ingaende: Record<string, number | null> = {}
    for (const n of [...new Set(cfg.costAccounts)].sort((a, b) => a - b)) {
      const acc = await reader.get<{ Account?: { Number?: unknown; Active?: unknown } }>(
        token,
        `/3/accounts/${n}`,
        {
          financialyear: cfg.financialYearId,
        },
      )
      if (acc?.Account?.Number !== n)
        throw new Incomplete(`Konto ${n} finns inte i Fortnox kontoplan för året`)
      // R5: ett svar som uttryckligen anger ett ANNAT år är inget bevis för valt år.
      // Saknat Year accepteras (fältet är inte obligatoriskt i schemat) men noteras.
      const accYear = (acc.Account as { Year?: unknown }).Year
      if (accYear !== undefined && accYear !== null && accYear !== cfg.financialYearId) {
        throw new Incomplete(`Konto ${n}: Fortnox svarade för ett annat räkenskapsår`)
      }
      if (acc.Account.Active === false) uncertainties.push(`Konto ${n} är inaktivt i Fortnox.`)
      const bbf = (acc.Account as { BalanceBroughtForward?: unknown }).BalanceBroughtForward
      if (bbf === undefined || bbf === null) ingaende[String(n)] = null
      else {
        const o = toOre(bbf)
        if (o === null) throw new Incomplete(`Konto ${n}: ogiltig ingående balans i Fortnox`)
        ingaende[String(n)] = o
      }
    }

    const cc = await paged<{ Code?: unknown }>(
      reader,
      token,
      '/3/costcenters',
      'CostCenters',
      {},
      coverage,
    )
    // R3: samma kod med ANNAT innehåll i samma läsning = konflikt (identiska dubletter
    // redovisas och räknas en gång).
    const verified = new Set<string>()
    const ccSeen = new Map<string, string>()
    for (const c of cc.items) {
      if (typeof c.Code !== 'string' || !c.Code) throw new Incomplete('/3/costcenters: kod saknas')
      const h = stable(c)
      const prev = ccSeen.get(c.Code)
      if (prev !== undefined && prev !== h)
        throw new Incomplete(`KONFLIKT: kostnadsställe ${c.Code} med olika innehåll`)
      ccSeen.set(c.Code, h)
      verified.add(`COST_CENTER:${c.Code}`)
    }
    if (ccSeen.size !== cc.total)
      throw new Incomplete('/3/costcenters: antalet unika koder stämmer inte')

    // R4: projekt läses (paginerat, med samma kontroller) när någon projektkoppling
    // finns. Utan projektkopplingar används projekt aldrig för fördelning, och
    // projektmärkta rader redovisas som okopplade — ingen projekt-scope behövs då.
    const wantsProjects = [...cfg.mappings.keys()].some((k) => k.startsWith('PROJECT:'))
    if (wantsProjects) {
      const pr = await paged<{ ProjectNumber?: unknown }>(
        reader,
        token,
        '/3/projects',
        'Projects',
        {},
        coverage,
      )
      const prSeen = new Map<string, string>()
      for (const p of pr.items) {
        const code =
          typeof p.ProjectNumber === 'string' || typeof p.ProjectNumber === 'number'
            ? String(p.ProjectNumber)
            : ''
        if (!code) throw new Incomplete('/3/projects: projektnummer saknas')
        const h = stable(p)
        const prev = prSeen.get(code)
        if (prev !== undefined && prev !== h)
          throw new Incomplete(`KONFLIKT: projekt ${code} med olika innehåll`)
        prSeen.set(code, h)
        verified.add(`PROJECT:${code}`)
      }
      if (prSeen.size !== pr.total)
        throw new Incomplete('/3/projects: antalet unika projekt stämmer inte')
    }

    const usable = selectVerifiedLedgerMappings(cfg.mappings, verified, uncertainties)

    const list = await paged<FortnoxVoucher>(
      reader,
      token,
      '/3/vouchers/sublist',
      'Vouchers',
      { financialyear: cfg.financialYearId },
      coverage,
    )
    const seen = new Map<string, string>()
    for (const v of list.items) {
      const k = voucherKey(v)
      if (!k) throw new Incomplete('Verifikat utan giltig identitet i listan')
      const h = stable(v)
      const prev = seen.get(k)
      if (prev !== undefined && prev !== h)
        throw new Incomplete(`KONFLIKT: verifikat ${k} med olika innehåll`)
      if (prev !== undefined)
        uncertainties.push(`Verifikat ${k} förekom flera gånger i listan och räknades en gång.`)
      seen.set(k, h)
    }
    if (seen.size !== list.total) {
      throw new Incomplete(
        `/3/vouchers: ${seen.size} unika verifikat men Fortnox angav ${list.total}`,
      )
    }

    // Alla detaljer måste vara validerade före första summeringen. Ett sent
    // detaljfel ska fortfarande vinna över en tidigare möjlig summeringsoverflow.
    const vouchers: ValidatedLedgerVoucher[] = []
    for (const key of [...seen.keys()].sort()) {
      const [, series, number] = key.split('|')
      const body = await reader.get<{ Voucher?: FortnoxVoucher }>(
        token,
        `/3/vouchers/${series}/${number}`,
        { financialyear: cfg.financialYearId },
      )
      vouchers.push(
        validateLedgerVoucher(key, body?.Voucher, {
          id: cfg.financialYearId,
          fromDate: yearStart,
          toDate: yearEnd,
        }),
      )
    }

    const accumulator = createLedgerAccumulator({ ...cfg, mappings: usable }, base)
    for (const voucher of vouchers) accumulator.add(voucher)
    const res = accumulator.finish()
    if (res.summary) {
      res.summary.balanceBroughtForwardOre = ingaende
      // KUNDSTART K-B8: årets bokföringsmetod ur samma svar; null = saknades (aldrig antaget).
      const am = (y as { AccountingMethod?: unknown }).AccountingMethod
      res.summary.financialYearAccountingMethod = typeof am === 'string' && am ? am : null
    }
    return res
  } catch (err) {
    if (err instanceof Incomplete) return fail('PARTIAL', err.message)
    if (err instanceof FortnoxReadError) {
      if (err.kind === 'auth')
        return fail('AUTH_LOST', 'Fortnox nekade åtkomst (inloggningen har upphört)')
      if (err.kind === 'forbidden')
        return fail('PARTIAL', 'Behörighet eller licens saknas för en resurs')
      if (err.kind === 'invalid') return fail('PARTIAL', 'Fortnox svar kunde inte tolkas')
      return fail('PARTIAL', 'Läsningen avbröts (nätverk, tidsgräns eller begränsning)')
    }
    throw err
  }
}
