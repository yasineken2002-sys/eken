import { api, get, del } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

export interface Document {
  id: string
  organizationId: string
  name: string
  description?: string
  fileUrl: string
  fileSize: number
  mimeType: string
  category: string
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
  uploadedBy: { firstName: string; lastName: string }
  property?: { name: string } | null
  unit?: { name: string } | null
  lease?: { id: string } | null
  tenant?: { firstName?: string; lastName?: string; companyName?: string; type: string } | null
  createdAt: string
  updatedAt: string
}

export interface UploadDocumentInput {
  file: File
  name: string
  description?: string
  category?: string
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
}

export async function fetchDocuments(filters?: {
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
  category?: string
}): Promise<Document[]> {
  const params: Record<string, string> = {}
  if (filters?.propertyId) params['propertyId'] = filters.propertyId
  if (filters?.unitId) params['unitId'] = filters.unitId
  if (filters?.leaseId) params['leaseId'] = filters.leaseId
  if (filters?.tenantId) params['tenantId'] = filters.tenantId
  if (filters?.category) params['category'] = filters.category
  return get<Document[]>('/documents', params)
}

export async function uploadDocument(input: UploadDocumentInput): Promise<Document> {
  const formData = new FormData()
  formData.append('file', input.file)
  formData.append('name', input.name)
  if (input.description) formData.append('description', input.description)
  if (input.category) formData.append('category', input.category)
  if (input.propertyId) formData.append('propertyId', input.propertyId)
  if (input.unitId) formData.append('unitId', input.unitId)
  if (input.leaseId) formData.append('leaseId', input.leaseId)
  if (input.tenantId) formData.append('tenantId', input.tenantId)

  const token = useAuthStore.getState().accessToken
  const { data } = await api.post<{ data: Document }>('/documents', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return data.data
}

export function downloadDocument(id: string, _name: string): void {
  const token = useAuthStore.getState().accessToken
  // Open download in new tab — browser will handle the attachment
  const url = `/api/v1/documents/${id}/download`
  // Append token as query param since we can't set headers on window.open
  const fullUrl = token ? `${url}?_t=${Date.now()}` : url
  window.open(fullUrl, '_blank')
}

export async function deleteDocument(id: string): Promise<void> {
  return del(`/documents/${id}`)
}
