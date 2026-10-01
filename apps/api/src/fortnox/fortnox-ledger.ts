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
import { FortnoxReadError, type FortnoxLedgerReader, type FortnoxVoucher } from './fortnox.types'

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

/** Läsningen kan inte fullföljas; ger PARTIAL/FAILED med orsak. */
class Incomplete extends Error {}

const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'

const DATE = /^\d{4}-\d{2}-\d{2}$/

function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** Belopp → öre. Null om inte ett ändligt tal med högst två decimaler. */
export function toOre(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const ore = Math.round(v * 100)
  return Math.abs(v * 100 - ore) < 1e-6 ? ore : null
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function voucherKey(v: FortnoxVoucher): string | null {
  if (!isPosInt(v.Year) || typeof v.VoucherSeries !== 'string' || !isPosInt(v.VoucherNumber))
    return null
  if (!/^[A-Za-z0-9]{1,8}$/.test(v.VoucherSeries)) return null
  return `${v.Year}|${v.VoucherSeries}|${v.VoucherNumber}`
}

async function paged<T>(
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
      FinancialYear?: { Id?: unknown; FromDate?: unknown; ToDate?: unknown }
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
      if (acc.Account.Active === false) uncertainties.push(`Konto ${n} är inaktivt i Fortnox.`)
    }

    const cc = await paged<{ Code?: unknown }>(
      reader,
      token,
      '/3/costcenters',
      'CostCenters',
      {},
      coverage,
    )
    const codes = new Set<string>()
    for (const c of cc.items) if (typeof c.Code === 'string') codes.add(c.Code)
    if (codes.size !== cc.total)
      throw new Incomplete('/3/costcenters: antalet unika koder stämmer inte')
    for (const key of cfg.mappings.keys()) {
      const sep = key.indexOf(':')
      const type = key.slice(0, sep)
      const code = key.slice(sep + 1)
      if (type === 'COST_CENTER' && !codes.has(code)) {
        uncertainties.push(`Kostnadsstället ${code} är kopplat i Eveno men finns inte i Fortnox.`)
      }
    }

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

    const vouchers: Array<{ key: string; v: FortnoxVoucher }> = []
    for (const key of [...seen.keys()].sort()) {
      const [year, series, number] = key.split('|')
      const body = await reader.get<{ Voucher?: FortnoxVoucher }>(
        token,
        `/3/vouchers/${series}/${number}`,
        {
          financialyear: cfg.financialYearId,
        },
      )
      const v = body?.Voucher
      if (!v || voucherKey(v) !== key)
        throw new Incomplete(`Detalj saknas eller avviker för verifikat ${key}`)
      if (Number(year) !== cfg.financialYearId)
        throw new Incomplete(`Verifikat ${key} hör till fel räkenskapsår`)
      if (
        !isDate(v.TransactionDate) ||
        v.TransactionDate < yearStart ||
        v.TransactionDate > yearEnd
      ) {
        throw new Incomplete(`Verifikat ${key} har saknat eller ogiltigt datum`)
      }
      if (!Array.isArray(v.VoucherRows)) throw new Incomplete(`Verifikat ${key} saknar rader`)
      vouchers.push({ key, v })
    }

    return aggregate(vouchers, cfg, base)
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

function aggregate(
  vouchers: Array<{ key: string; v: FortnoxVoucher }>,
  cfg: LedgerReadConfig,
  base: Pick<LedgerReadResult, 'coverage' | 'uncertainties' | 'references' | 'financialYear'>,
): LedgerReadResult {
  const accounts = new Set(cfg.costAccounts)
  const rows: LedgerRowProvenance[] = []
  const byProperty = new Map<
    string,
    { propertyId: string; propertyName: string; amountOre: number }
  >()
  const unmapped = new Map<
    string,
    { dimensionType: 'COST_CENTER' | 'PROJECT'; code: string; amountOre: number }
  >()
  let total = 0
  let unallocated = 0
  let removed = 0
  let eveno = 0
  let uncertain = false

  for (const { key, v } of vouchers) {
    const date = v.TransactionDate as string
    if (date < cfg.periodFrom || date > cfg.periodTo) continue
    const evenoExport = cfg.evenoExported.has(key)
    if (v.ReferenceType || v.ReferenceNumber) {
      base.references.push({
        voucher: key,
        referenceType: typeof v.ReferenceType === 'string' ? v.ReferenceType : null,
        referenceNumber: typeof v.ReferenceNumber === 'string' ? v.ReferenceNumber : null,
      })
    }
    const vRows = v.VoucherRows as Array<Record<string, unknown>>
    for (const [i, r] of vRows.entries()) {
      if (typeof r.Account !== 'number' || !accounts.has(r.Account)) continue
      const debit = toOre(r.Debit)
      const credit = toOre(r.Credit)
      if (debit === null || credit === null) {
        return {
          status: 'PARTIAL',
          reason: `Ogiltigt belopp i verifikat ${key} rad ${i + 1}`,
          summary: null,
          rows: null,
          ...base,
        }
      }
      const amountOre = debit - credit
      const cc = typeof r.CostCenter === 'string' && r.CostCenter ? r.CostCenter : null
      const pr = typeof r.Project === 'string' && r.Project ? r.Project : null
      const dimensionType = cc ? 'COST_CENTER' : pr ? 'PROJECT' : null
      const code = cc ?? pr
      const prov: LedgerRowProvenance = {
        voucher: key,
        row: i + 1,
        transactionDate: date,
        account: r.Account,
        amountOre,
        bucket: 'UNALLOCATED',
        dimensionType,
        code,
        propertyId: null,
        evenoExport,
      }
      if (r.Removed === true) {
        prov.bucket = 'UNCERTAIN_REMOVED'
        removed += amountOre
        uncertain = true
        base.uncertainties.push(
          `Verifikat ${key} rad ${i + 1} är markerad som borttagen i Fortnox; innebörden är inte belagd och raden ingår inte i summan.`,
        )
        rows.push(prov)
        continue
      }
      total += amountOre
      if (evenoExport) eveno += amountOre
      if (!dimensionType && (v.CostCenter || v.Project)) {
        uncertain = true
        base.uncertainties.push(
          `Verifikat ${key}: dimension finns bara på verifikatets huvud och har inte förts över till raden.`,
        )
      }
      if (dimensionType && code) {
        const m = cfg.mappings.get(`${dimensionType}:${code}`)
        if (m) {
          prov.bucket = 'PROPERTY'
          prov.propertyId = m.propertyId
          const cur = byProperty.get(m.propertyId) ?? { ...m, amountOre: 0 }
          cur.amountOre += amountOre
          byProperty.set(m.propertyId, cur)
        } else {
          prov.bucket = 'UNMAPPED'
          const k = `${dimensionType}:${code}`
          const cur = unmapped.get(k) ?? { dimensionType, code, amountOre: 0 }
          cur.amountOre += amountOre
          unmapped.set(k, cur)
        }
      } else {
        unallocated += amountOre
      }
      rows.push(prov)
    }
  }

  if (unmapped.size) {
    base.uncertainties.push(
      `${unmapped.size} Fortnox-dimension(er) saknar koppling till fastighet och redovisas som okopplade.`,
    )
  }
  if (eveno) {
    base.uncertainties.push(
      'En del av beloppet kommer från verifikat som Eveno själv har exporterat; lägg inte ihop det med Evenos egna siffror.',
    )
  }
  base.uncertainties.push(LIMITATION)
  return {
    status: uncertain ? 'COMPLETE_WITH_UNCERTAINTY' : 'COMPLETE',
    reason: null,
    summary: {
      currency: 'SEK',
      totalOre: total,
      byProperty: [...byProperty.values()].sort((a, b) =>
        a.propertyName.localeCompare(b.propertyName, 'sv'),
      ),
      unmappedDimensions: [...unmapped.values()].sort((a, b) => a.code.localeCompare(b.code, 'sv')),
      unallocatedOre: unallocated,
      uncertainRemovedOre: removed,
      evenoExportOre: eveno,
    },
    rows,
    ...base,
  }
}
