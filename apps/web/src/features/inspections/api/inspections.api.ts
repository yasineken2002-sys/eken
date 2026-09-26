import { get, post, patch, del, api } from '@/lib/api'
import type {
  CreateInspectionInput,
  CreateInspectionCorrectionInput,
  UpdateInspectionInput,
  UpdateInspectionItemInput,
  InspectionTypeValue,
  InspectionStatusValue,
  InspectionItemConditionValue,
} from '@eken/shared'

/**
 * De tre enum-typerna kommer nu ur `@eken/shared`, som är bunden till Prismas
 * enums av `inspection-enum-source.spec.ts`. Här stod tre egna uppräkningar av
 * samma värden — rätt när de skrevs, men kopior utan bindning, och det är
 * precis den formen som gav felanmälan tre kategorier som inte finns i
 * databasen. Namnen behålls: hela besiktningsvyn importerar dem härifrån.
 */
export type InspectionType = InspectionTypeValue
export type InspectionStatus = InspectionStatusValue
export type InspectionItemCondition = InspectionItemConditionValue

export interface InspectionItem {
  id: string
  inspectionId: string
  room: string
  item: string
  condition: InspectionItemCondition
  notes: string | null
  repairCost: number | null
}

export interface InspectionImage {
  id: string
  inspectionId: string
  filename: string
  /** Lagringsnyckeln. För en bilaga från ett återförsök (OB5) innehåller den valets nyckel. */
  storageKey: string
  /** sha256 över de bytes servern tog emot; null för bilder före F025 v2. */
  contentSha256: string | null
  caption: string | null
  room: string | null
  size: number
  createdAt: string
}

export interface Inspection {
  id: string
  organizationId: string
  propertyId: string
  unitId: string
  leaseId: string | null
  tenantId: string | null
  inspectedById: string
  type: InspectionType
  status: InspectionStatus
  scheduledDate: string
  completedAt: string | null
  overallCondition: string | null
  notes: string | null
  tenantSignature: string | null
  landlordSignature: string | null
  signedAt: string | null
  /** Hashen som FRÖS vid signeringen. Null för osignerade protokoll. */
  signedContentHash: string | null
  /**
   * Hashen över protokollets innehåll NU, härledd av servern vid varje läsning.
   * Ekas tillbaka som `expectedContentHash` vid signering — det är så servern
   * vet vilken version användaren faktiskt såg.
   */
  contentHash: string
  createdAt: string
  updatedAt: string

  /** Kedjans ordningstal. 1 = originalet. */
  version: number
  /** Versionen den här raden rättar, eller null för ett original. */
  correctionOfId: string | null
  correctionReason: string | null
  correctedById: string | null
  correctedAt: string | null
  /**
   * Efterföljaren, när någon har rättat den här versionen. Null betyder att
   * raden är kedjans sista — inte att den gäller; det avgörs av `arGallande`.
   */
  correction: {
    id: string
    version: number
    status: InspectionStatus
    signedAt: string | null
    completedAt: string | null
  } | null
  /**
   * Hela kedjan. Följer BARA med detaljsvaret (`GET /inspections/:id`) — listan
   * får den inte, eftersom den hade blivit en fråga per rad.
   */
  versioner?: InspectionVersion[]
  /** Gäller den här versionen? Finns bara i detaljsvaret. */
  arGallande?: boolean
  /** Är den här versionen ett utkast? Finns bara i detaljsvaret. */
  arUtkast?: boolean

  property: { id: string; name: string; street: string; city: string }
  unit: { id: string; name: string; unitNumber: string }
  tenant: {
    id: string
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName?: string | null
    lastName?: string | null
    companyName?: string | null
    email: string
  } | null
  lease: { id: string } | null
  items: InspectionItem[]
  images: InspectionImage[]
}

/** En länk i versionskedjan, som servern härleder den. */
export interface InspectionVersion {
  id: string
  version: number
  status: InspectionStatus
  signedAt: string | null
  completedAt: string | null
  correctionOfId: string | null
  correctionReason: string | null
  correctedById: string | null
  correctedAt: string | null
  createdAt: string
  /** Exakt en länk i kedjan är sann — eller ingen, om inget slutförts. */
  arGallande: boolean
  arUtkast: boolean
}

/**
 * Utfallet av en FAKTISK kontroll av en bilagas bytes.
 *
 * `VERIFIERAD` betyder att innehållet lästes tillbaka ur lagringen och att
 * digesten stämde. De tre andra är skilda sorters okunskap och får aldrig
 * ritas som ett godkännande.
 */
export type BildkontrollUtfall = 'VERIFIERAD' | 'AVVIKANDE' | 'SAKNAS' | 'DIGEST_SAKNAS'

export interface Bildkontroll {
  imageId: string
  filename: string
  utfall: BildkontrollUtfall
  kontrolleradAt: string
  forvantadDigest: string | null
  faktiskDigest: string | null
}

export interface Bildkontrollsvar {
  inspectionId: string
  sammanfattning: BildkontrollUtfall | 'INGA_BILDER'
  kontrolleradAt: string
  bilder: Bildkontroll[]
}

/** Upplysningen om att ett avdrag redan är beslutat. Null = inget att säga. */
export interface Depositionsvarning {
  depositId: string
  status: string
  avdragAntal: number
  refundAmount: string | null
  refundedAt: string | null
}

export interface RattelseSvar extends Inspection {
  rattelseAv: { id: string; version: number; status: InspectionStatus; signedAt: string | null }
  depositionsvarning: Depositionsvarning | null
}

export interface InspectionStats {
  total: number
  scheduled: number
  inProgress: number
  completed: number
  signed: number
  byType: { MOVE_IN: number; MOVE_OUT: number; PERIODIC: number; DAMAGE: number }
}

export interface InspectionFilter {
  unitId?: string
  propertyId?: string
  type?: InspectionType | ''
  status?: InspectionStatus | ''
}

/**
 * NYTTOLASTERNA ÄR DELADE — de tre interfacen som stod här är borta.
 *
 * De beskrev samma kroppar som API:ts DTO:er, utan att någon av beskrivningarna
 * visste om den andra. `UpdateInspectionInput` saknade dessutom `completedAt`,
 * som DTO:n tog emot och lät skriva över serverns egen tidsstämpel — glidningen
 * fanns alltså på riktigt. Typerna re-exporteras för att vyerna importerar dem
 * härifrån.
 */
export type {
  CreateInspectionInput,
  CreateInspectionCorrectionInput,
  UpdateInspectionInput,
  UpdateInspectionItemInput,
}

export function fetchInspections(filters?: InspectionFilter) {
  const params = new URLSearchParams()
  if (filters?.unitId) params.set('unitId', filters.unitId)
  if (filters?.propertyId) params.set('propertyId', filters.propertyId)
  if (filters?.type) params.set('type', filters.type)
  if (filters?.status) params.set('status', filters.status)
  const q = params.toString()
  return get<Inspection[]>(`/inspections${q ? `?${q}` : ''}`)
}

export function fetchStats() {
  return get<InspectionStats>('/inspections/stats')
}

export function fetchInspection(id: string) {
  return get<Inspection>(`/inspections/${id}`)
}

export function createInspection(dto: CreateInspectionInput) {
  return post<Inspection>('/inspections', dto)
}

export function updateInspection(id: string, dto: UpdateInspectionInput) {
  return patch<Inspection>(`/inspections/${id}`, dto)
}

export function updateInspectionItem(
  inspectionId: string,
  itemId: string,
  dto: UpdateInspectionItemInput,
) {
  return patch<InspectionItem>(`/inspections/${inspectionId}/items/${itemId}`, dto)
}

export function fetchInspectionVersions(id: string) {
  return get<InspectionVersion[]>(`/inspections/${id}/versioner`)
}

/**
 * Begär en FAKTISK kontroll av bilagornas bytes.
 *
 * Anropas bara när någon ber om den: kontrollen hämtar varje objekt ur
 * lagringen, och en vy som gjorde det automatiskt hade betalat för en mätning
 * ingen frågat efter.
 */
export function fetchImageCheck(id: string) {
  return get<Bildkontrollsvar>(`/inspections/${id}/bildkontroll`)
}

export function createInspectionCorrection(id: string, dto: CreateInspectionCorrectionInput) {
  return post<RattelseSvar>(`/inspections/${id}/rattelse`, dto)
}

export function deleteInspection(id: string) {
  return del(`/inspections/${id}`)
}

export async function downloadProtocolPdf(id: string) {
  const res = await api.get(`/inspections/${id}/pdf`, { responseType: 'blob' })
  const url = window.URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'besiktningsprotokoll.pdf'
  a.click()
  window.URL.revokeObjectURL(url)
}

export interface AnalysisResultItem {
  room: string
  item: string
  condition: InspectionItemCondition
  notes: string | null
  repairCost: number | null
}

export interface AnalysisResult {
  overallCondition: string
  notes: string
  urgentIssues: string[]
  estimatedTotalCost: number
  items: AnalysisResultItem[]
}

export interface AnalyzeInspectionResult {
  analysis: AnalysisResult
  updatedItems: number
  createdItems: number
  /** Bilagornas id i samma ordning som filerna — återanvända vid återförsök. */
  bildIds: string[]
}

export async function analyzeInspection(
  id: string,
  files: Array<{ file: File; caption?: string; nyckel?: string }>,
): Promise<AnalyzeInspectionResult> {
  const formData = new FormData()
  files.forEach(({ file, caption, nyckel }, i) => {
    formData.append('images', file)
    if (caption) formData.append(`caption_${i}`, caption)
    // Återförsöksnyckeln för VALET (OB5): samma val som skickas igen återanvänder
    // den bilaga servern redan sparat, i stället för att lagra bilden en gång till.
    if (nyckel) formData.append(`uploadKey_${i}`, nyckel)
  })
  const res = await api.post<{ success: boolean; data: AnalyzeInspectionResult }>(
    `/inspections/${id}/analyze`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return res.data.data
}
