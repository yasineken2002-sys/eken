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
/**
 * Belopp → heltal öre, EXAKT ur talets decimala form (ingen flyttalsaritmetik,
 * ingen epsilon). Saknat värde är ogiltigt — inte noll. Mer än två decimaler,
 * exponentform eller ett resultat utanför säkra heltal ger null.
 */
export function toOre(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  // String() ger den kortaste decimalform som återger exakt samma double — dvs.
  // den form JSON-svaret hade. Exponentform (1e21, 1e-7) avvisas.
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v))
  if (!m) return null
  const ore = BigInt(m[2] ?? '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  const signed = m[1] === '-' ? -ore : ore
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER))
    return null
  return Number(signed)
}

/** Summering med grind: utanför säkra heltal → ogiltigt (aldrig tyst avrundning). */
function add(a: number, b: number): number {
  const s = a + b
  if (!Number.isSafeInteger(s))
    throw new Incomplete('Beloppssumman ligger utanför säkert talområde')
  return s
}

const absent = (v: unknown) => v === undefined || v === null
/** En sida av en rad: saknad = 0 (inaktiv sida); annars exakt toOre. */
const sideOre = (v: unknown): number | null => (absent(v) ? 0 : toOre(v))

const optionalCode = (x: unknown) => x === undefined || x === null || typeof x === 'string'

/**
 * Strikt kontroll av en verifikatrad ur Fortnox, för ALLA rader i året (inte bara
 * valda konton och inte bara perioden). Ett fel gör läsningen ofullständig — en
 * rad med t.ex. konto som sträng får aldrig tyst falla bort ur summan.
 */
function rowProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'rad saknas'
  const x = r as Record<string, unknown>
  if (
    typeof x.Account !== 'number' ||
    !Number.isInteger(x.Account) ||
    x.Account < 1000 ||
    x.Account > 9999
  ) {
    return 'ogiltigt konto'
  }
  // En saknad sida är den inaktiva sidan (= 0, dokumenterat). BÅDA saknade är
  // saknat underlag, inte noll. En närvarande sida måste vara ett giltigt belopp.
  if (absent(x.Debit) && absent(x.Credit)) return 'belopp saknas på båda sidor'
  const d = sideOre(x.Debit)
  const c = sideOre(x.Credit)
  if (d === null || c === null) return 'ogiltigt belopp'
  if (d < 0 || c < 0) return 'negativt belopp (semantik obelagd)'
  if (x.Removed !== undefined && typeof x.Removed !== 'boolean')
    return 'ogiltig borttagningsmarkering'
  if (!optionalCode(x.CostCenter) || !optionalCode(x.Project)) return 'ogiltig dimension'
  return null
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
      // R5: ett svar som uttryckligen anger ett ANNAT år är inget bevis för valt år.
      // Saknat Year accepteras (fältet är inte obligatoriskt i schemat) men noteras.
      const accYear = (acc.Account as { Year?: unknown }).Year
      if (accYear !== undefined && accYear !== null && accYear !== cfg.financialYearId) {
        throw new Incomplete(`Konto ${n}: Fortnox svarade för ett annat räkenskapsår`)
      }
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

    // Endast kopplingar vars dimension FINNS i Fortnox används för fördelning.
    const usable = new Map<string, { propertyId: string; propertyName: string }>()
    for (const [key, m] of cfg.mappings) {
      if (verified.has(key)) usable.set(key, m)
      else {
        const sep = key.indexOf(':')
        const kind = key.slice(0, sep) === 'PROJECT' ? 'Projektet' : 'Kostnadsstället'
        uncertainties.push(
          `${kind} ${key.slice(sep + 1)} är kopplat i Eveno men finns inte i Fortnox; kopplingen används inte.`,
        )
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
      if (!Array.isArray(v.VoucherRows) || v.VoucherRows.length === 0) {
        throw new Incomplete(`Verifikat ${key} saknar rader`)
      }
      for (const [i, r] of (v.VoucherRows as unknown[]).entries()) {
        const p = rowProblem(r)
        if (p) throw new Incomplete(`Verifikat ${key} rad ${i + 1}: ${p}`)
      }
      vouchers.push({ key, v })
    }

    return aggregate(vouchers, { ...cfg, mappings: usable }, base)
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
      const debit = sideOre(r.Debit)
      const credit = sideOre(r.Credit)
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
        removed = add(removed, amountOre)
        uncertain = true
        base.uncertainties.push(
          `Verifikat ${key} rad ${i + 1} är markerad som borttagen i Fortnox; innebörden är inte belagd och raden ingår inte i summan.`,
        )
        rows.push(prov)
        continue
      }
      total = add(total, amountOre)
      if (evenoExport) eveno = add(eveno, amountOre)
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
          cur.amountOre = add(cur.amountOre, amountOre)
          byProperty.set(m.propertyId, cur)
        } else {
          prov.bucket = 'UNMAPPED'
          const k = `${dimensionType}:${code}`
          const cur = unmapped.get(k) ?? { dimensionType, code, amountOre: 0 }
          cur.amountOre = add(cur.amountOre, amountOre)
          unmapped.set(k, cur)
        }
      } else {
        unallocated = add(unallocated, amountOre)
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
