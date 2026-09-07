import { get, post, patch, del, api } from '@/lib/api'
import type {
  CreateInspectionInput,
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
  path: string
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
  createdAt: string
  updatedAt: string
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
export type { CreateInspectionInput, UpdateInspectionInput, UpdateInspectionItemInput }

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
}

export async function analyzeInspection(
  id: string,
  files: Array<{ file: File; caption?: string }>,
): Promise<AnalyzeInspectionResult> {
  const formData = new FormData()
  files.forEach(({ file, caption }, i) => {
    formData.append('images', file)
    if (caption) formData.append(`caption_${i}`, caption)
  })
  const res = await api.post<{ success: boolean; data: AnalyzeInspectionResult }>(
    `/inspections/${id}/analyze`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return res.data.data
}
