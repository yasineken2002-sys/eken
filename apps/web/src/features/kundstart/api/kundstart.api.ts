import { api, get, post } from '@/lib/api'

// KUNDSTART-001: brytdatum, öppningspaket och Fortnox-kundaktivering. Speglar
// apps/api/src/kundstart och fortnox-customer-activation. Servern prövar allt igen.

export interface Cutover {
  cutoverDate: string | null
  setAt: string | null
  setById: string | null
  locked: boolean
  lockReason: string | null
}

export type PackageStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'EXECUTED' | 'DISCARDED'
export type ReconStatus = 'AVSTAMD' | 'AVGRANSAD' | 'DIFFERENS' | null

export interface KontoAvstamning {
  konto: '1510' | '2890'
  paketOre: number
  fortnoxOre: number | null
  differensOre: number | null
  spec: {
    sha256: string
    antal: number
    summaOre: number
    beskrivning: string
    filnamn: string
  } | null
  status: 'AVSTAMD' | 'AVGRANSAD' | 'DIFFERENS' | 'SALDO_SAKNAS'
  text: string
}

export interface OpeningRow {
  id: string
  rowNo: number
  sourceId: string
  kind: 'RECEIVABLE' | 'DEPOSIT'
  tenantRef: string
  leaseRef: string | null
  propertyRef: string | null
  unitRef: string | null
  periodYear: number | null
  periodMonth: number | null
  dueDate: string | null
  receivedDate: string | null
  originalAmount: string
  openAmount: string
  tenantId: string | null
  leaseId: string | null
  errors: string[] | null
}

export interface OpeningPackageSummary {
  id: string
  status: PackageStatus
  version: number
  sourceName: string
  sourceSha256: string
  zeroOpening: boolean
  reconciliationStatus: ReconStatus
  createdAt: string
  executedAt: string | null
  _count?: { rows: number }
}

export interface ForstaPeriodRegister {
  sha256: string
  filnamn: string
  system: string
  ansvarig: string
  tackningFran: string
  tackningTill: string
  intaktskonton: number[]
  forskottskonton: number[]
  antal: number
}

export const REGISTER_MALL = 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt'
export const SPEC_MALL = 'postId;motpart;dokument;dokumentdatum;forfallodag;belopp'

export const setFirstPeriodRegister = (
  id: string,
  b: {
    filnamn: string
    innehall: string
    system: string
    ansvarig: string
    tackningFran: string
    tackningTill: string
    intaktskonton: number[]
    forskottskonton: number[]
  },
) =>
  api
    .put<OpeningPackage>(`/kundstart/opening-packages/${id}/first-period-register`, b)
    .then((r) => r.data)

export interface OpeningPackage extends OpeningPackageSummary {
  firstPeriodRegister: ForstaPeriodRegister | null
  cutoverDate: string
  orgNumber: string | null
  fortnoxReadRunId: string | null
  fortnoxBalance1510Ore: number | null
  fortnoxBalance2890Ore: number | null
  totals: { fordranOre: number; depositionOre: number; rader: number } | null
  reconciliation: { status: ReconStatus; konton: KontoAvstamning[]; beraknad: string } | null
  approvedAt: string | null
  approvedVersion: number | null
  invalidatedReason: string | null
  felrader: number
  rows: OpeningRow[]
}

export const fetchCutover = () => get<Cutover>('/kundstart/cutover')
export const saveCutover = (cutoverDate: string | null) =>
  api.put<Cutover>('/kundstart/cutover', { cutoverDate }).then((r) => r.data)

export const fetchPackages = () => get<OpeningPackageSummary[]>('/kundstart/opening-packages')
export const fetchPackage = (id: string) => get<OpeningPackage>(`/kundstart/opening-packages/${id}`)
export const uploadPackage = (b: { sourceName: string; innehall: string; nollOppning?: boolean }) =>
  post<OpeningPackageSummary>('/kundstart/opening-packages', b)
export const replacePackageSource = (
  id: string,
  b: { sourceName: string; innehall: string; nollOppning?: boolean },
) => api.put<OpeningPackage>(`/kundstart/opening-packages/${id}/source`, b).then((r) => r.data)
export const validatePackage = (id: string) =>
  post<OpeningPackage>(`/kundstart/opening-packages/${id}/validate`)
export const bindRead = (id: string, readRunId: string) =>
  post<OpeningPackage>(`/kundstart/opening-packages/${id}/fortnox-read`, { readRunId })
export const setSeparateLedger = (
  id: string,
  b: {
    konto: '1510' | '2890'
    beskrivning: string
    filnamn: string
    innehall: string | null
    system?: string
    ansvarig?: string
  },
) =>
  api
    .put<OpeningPackage>(`/kundstart/opening-packages/${id}/separate-ledger`, b)
    .then((r) => r.data)
export const approvePackage = (id: string, b: { version: number; sourceSha256: string }) =>
  post<OpeningPackage>(`/kundstart/opening-packages/${id}/approve`, b)
export const executePackage = (id: string) =>
  post<{ status: 'EXECUTED'; fordringar?: number; depositioner?: number }>(
    `/kundstart/opening-packages/${id}/execute`,
  )
export const discardPackage = (id: string) =>
  post<OpeningPackage>(`/kundstart/opening-packages/${id}/discard`)

export interface ActivationStatus {
  flaggaPa: boolean
  aktiv: { id: string; giltig: boolean } | null
  aktivHinder: string | null
  forslag: { ok: boolean; hinder: string[]; text: string | null; textSha256: string | null }
  historik: {
    id: string
    status: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED'
    fortnoxDatabaseNumber: number
    financialYearId: number
    voucherSeries: string
    approvedAt: string
    revokedAt: string | null
    supersededAt: string | null
    invalidatedReason: string | null
  }[]
}

export const fetchActivation = (financialYearId: number | null) =>
  get<ActivationStatus>(
    '/integrations/fortnox/customer-activation',
    financialYearId === null ? undefined : { financialYearId },
  )
export const approveActivation = (b: { financialYearId: number; consequencesSha256: string }) =>
  post<{ id: string; status: string }>('/integrations/fortnox/customer-activation/approve', b)
export const revokeActivation = () =>
  post<{ revoked: number }>('/integrations/fortnox/customer-activation/revoke')

export const kr = (ore: number | null | undefined) =>
  ore === null || ore === undefined
    ? '–'
    : `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`
