import { get, post, patch, del, api } from '@/lib/api'

export type InspectionType = 'MOVE_IN' | 'MOVE_OUT' | 'PERIODIC' | 'DAMAGE'
export type InspectionStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'SIGNED'
export type InspectionItemCondition = 'GOOD' | 'ACCEPTABLE' | 'DAMAGED' | 'MISSING'

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

export interface CreateInspectionInput {
  type: InspectionType
  scheduledDate: string
  propertyId: string
  unitId: string
  leaseId?: string
  tenantId?: string
}

export interface UpdateInspectionInput {
  status?: InspectionStatus
  notes?: string
  overallCondition?: string
  signedAt?: string
  tenantSignature?: string
  landlordSignature?: string
}

export interface UpdateInspectionItemInput {
  condition?: InspectionItemCondition
  notes?: string
  repairCost?: number | null
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
