import { toast } from 'sonner'
import { api, get, del, extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { sanitizeFilename, openPresignedDownload } from '@/lib/download'

export interface Document {
  id: string
  organizationId: string
  name: string
  description?: string
  storageKey: string
  storageUrl: string
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

// Backend returnerar { url, filename, mimeType } där `url` är en presigned
// R2-URL (~5 min TTL) som vi öppnar direkt — den är förautentiserad så
// webbläsaren behöver ingen Authorization-header. Den gamla lösningen försökte
// öppna /api/v1/documents/:id/download i ett nytt fönster utan auth-header
// och fick 401 UNAUTHORIZED.
export async function downloadDocument(id: string, name: string): Promise<void> {
  try {
    const { url, filename } = await get<{ url: string; filename: string; mimeType: string }>(
      `/documents/${id}/download`,
    )
    openPresignedDownload(url, sanitizeFilename(filename || name))
  } catch (err) {
    // Queries triggas inte av MutationCache, så fel skulle annars vara tysta.
    toast.error('Kunde inte ladda ner dokumentet', {
      description: extractApiError(err, 'Försök igen om en stund.'),
    })
    throw err
  }
}

export async function deleteDocument(id: string): Promise<void> {
  return del(`/documents/${id}`)
}
