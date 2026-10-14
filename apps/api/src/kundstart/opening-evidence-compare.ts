import type {
  OpeningEvidenceDifference,
  OpeningEvidenceStop,
  OpeningEvidenceView,
} from '@eken/shared'
import {
  canonical,
  key,
  order,
  type SourceDocument,
  type EvidenceMapping,
  type EvidenceKind,
} from './opening-evidence-format'

export interface EvidenceImport {
  row: number
  document: string
  kind: EvidenceKind
  tenantId: string | null
  leaseId: string | null
  original: number | null
  paid: number | null
  credited: number | null
  open: number | null
  period: string
  due: string
  received: string
  resolutionOk: boolean
}
export interface CheckedMapping extends EvidenceMapping {
  valid: boolean
}
export type EvidenceComparison = Pick<
  OpeningEvidenceView,
  'comparisonStatus' | 'counts' | 'stopp' | 'avvikelser'
>

/** No cached status or aggregate can substitute for both document sets and their identities. */
export function compareEvidence(
  source: SourceDocument[],
  mapping: CheckedMapping[],
  imported: EvidenceImport[],
  company: string,
): EvidenceComparison {
  const stopp: OpeningEvidenceStop[] = [],
    avvikelser: OpeningEvidenceDifference[] = []
  const stop = (
    kod: string,
    fil: OpeningEvidenceStop['fil'],
    rad: number | null,
    nyckel: string | null,
    skal: string,
  ) => stopp.push({ kod, fil, rad, nyckel, skal })
  const mappings = new Map<string, CheckedMapping>(),
    sourceKeys = new Map<string, SourceDocument>(),
    importKeys = new Map<string, EvidenceImport>()
  const oldCustomers = new Map<string, string>(),
    newCustomers = new Map<string, string>(),
    newContracts = new Map<string, string>()
  for (const m of mapping) {
    const k = key(m.company, m.customer, m.contract),
      customerKey = key(m.company, m.customer)
    if (m.company !== company || !m.valid)
      stop(
        'MAPPNING_IDENTITET',
        'MAPPNING',
        m.row,
        null,
        'Mappningen har okänd eller motstridig koppling inom organisationen',
      )
    if (mappings.has(k))
      stop('DUBBEL_MAPPNING', 'MAPPNING', m.row, k, 'Dubblett eller tvetydig mappning')
    if (
      (oldCustomers.has(customerKey) && oldCustomers.get(customerKey) !== m.tenantId) ||
      (newCustomers.has(m.tenantId) && newCustomers.get(m.tenantId) !== customerKey)
    )
      stop(
        'TVETYDIG_KUND',
        'MAPPNING',
        m.row,
        k,
        'Gamla och nya kunder får inte slås ihop eller delas implicit',
      )
    const newContract = key(m.tenantId, m.leaseId)
    if (newContracts.has(newContract) && newContracts.get(newContract) !== k)
      stop('TVETYDIG_AVTAL', 'MAPPNING', m.row, k, 'Gamla avtal får inte slås ihop implicit')
    newContracts.set(newContract, k)
    mappings.set(k, m)
    oldCustomers.set(customerKey, m.tenantId)
    newCustomers.set(m.tenantId, customerKey)
  }
  for (const s of source) {
    const k = key(s.company, s.kind, s.document)
    for (const error of s.errors) stop('KALLRAD', 'KALLA', s.row, k, error)
    if (sourceKeys.has(k))
      stop('DUBBEL_DOKUMENTNYCKEL', 'KALLA', s.row, k, 'Dubblett av dokumentnyckel')
    sourceKeys.set(k, s)
    if (!mappings.has(key(s.company, s.customer, s.contract)))
      stop('SAKNAD_MAPPNING', 'KALLA', s.row, k, 'Dokumentets gamla kund/avtal saknar mappning')
  }
  const usedMappings = new Set(source.map((s) => key(s.company, s.customer, s.contract)))
  for (const [k, m] of mappings)
    if (!usedMappings.has(k))
      stop('EXTRA_MAPPNING', 'MAPPNING', m.row, k, 'Mappningen saknar motsvarande dokument')
  for (const r of imported) {
    const k = key(company, r.kind, r.document)
    if (importKeys.has(k))
      stop('DUBBEL_DOKUMENTNYCKEL', 'IMPORT', r.row, k, 'Dubblett av dokumentnyckel')
    importKeys.set(k, r)
    if (!r.resolutionOk || !r.tenantId || !r.leaseId)
      stop(
        'IMPORT_KOPPLING',
        'IMPORT',
        r.row,
        k,
        'Importens aktuella koppling måste valideras på nytt',
      )
    if (r.kind === 'RECEIVABLE' && (r.paid === null || r.credited === null))
      stop(
        'IMPORT_SAKNAR_KEDJA',
        'IMPORT',
        r.row,
        k,
        'Importen saknar betalt/krediterat för dokumentet',
      )
    if (r.original === null || r.open === null)
      stop('IMPORT_SAKNAR_BELOPP', 'IMPORT', r.row, k, 'Importen saknar belopp')
  }
  for (const [k, s] of sourceKeys)
    if (!importKeys.has(k))
      stop('SAKNAT_DOKUMENT', 'KALLA', s.row, k, 'Dokumentet saknas i importen')
  for (const [k, r] of importKeys)
    if (!sourceKeys.has(k))
      stop('EXTRA_DOKUMENT', 'IMPORT', r.row, k, 'Importdokumentet saknas i den oberoende källan')
  const badDocuments = new Set<string>()
  const sums = new Map<
    string,
    { kind: EvidenceKind; tenantId: string; leaseId: string; expected: bigint; actual: bigint }
  >()
  const sum = (
    kind: EvidenceKind,
    tenantId: string,
    leaseId: string,
    amount: number,
    side: 'expected' | 'actual',
  ) => {
    const k = key(kind, tenantId, leaseId),
      v = sums.get(k) ?? { kind, tenantId, leaseId, expected: 0n, actual: 0n }
    v[side] += BigInt(amount)
    sums.set(k, v)
  }
  if (stopp.length === 0) {
    for (const [k, s] of sourceKeys) {
      const r = importKeys.get(k)!,
        m = mappings.get(key(s.company, s.customer, s.contract))!
      const expected = {
        tenantId: m.tenantId,
        leaseId: m.leaseId,
        original: s.original,
        open: s.open,
        ...(s.kind === 'RECEIVABLE'
          ? { paid: s.paid, credited: s.credited, period: s.period, due: s.due }
          : { received: s.received }),
      }
      for (const [field, value] of Object.entries(expected)) {
        const actual = r[field as keyof EvidenceImport] as string | number | null
        if (value !== actual) {
          badDocuments.add(k)
          avvikelser.push({
            niva: 'DOKUMENT',
            typ: s.kind,
            nyckel: k,
            kund: s.customer,
            avtal: s.contract,
            falt: field,
            kalla: value,
            import: actual,
            skal: 'Dokumentet skiljer sig från den oberoende källan',
          })
        }
      }
      sum(s.kind, m.tenantId, m.leaseId, s.open!, 'expected')
      sum(r.kind, r.tenantId!, r.leaseId!, r.open!, 'actual')
    }
    for (const [k, s] of sums)
      if (s.expected !== s.actual) {
        const m = mapping.find((v) => v.tenantId === s.tenantId && v.leaseId === s.leaseId)
        avvikelser.push({
          niva: 'KUND_AVTAL',
          typ: s.kind,
          nyckel: k,
          kund: m?.customer ?? null,
          avtal: m?.contract ?? null,
          falt: 'open',
          kalla: s.expected.toString(),
          import: s.actual.toString(),
          skal: `Differens import minus källa: ${s.actual - s.expected} öre`,
        })
      }
  }
  stopp.sort((a, b) => order(canonical(a), canonical(b)))
  avvikelser.sort((a, b) => order(canonical(a), canonical(b)))
  return {
    comparisonStatus: stopp.length ? 'STOPP' : badDocuments.size ? 'AVVIKELSE' : 'OK',
    counts: {
      dokumentKalla: source.length,
      dokumentImport: imported.length,
      matchade: stopp.length ? 0 : source.length - badDocuments.size,
      avvikelser: badDocuments.size,
      stopp: stopp.length,
    },
    stopp,
    avvikelser,
  }
}
