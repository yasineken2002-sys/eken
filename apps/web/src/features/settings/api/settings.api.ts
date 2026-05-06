import { get, patch, api } from '@/lib/api'
import type { Organization } from '@eken/shared'

export interface UpdateOrganizationInput {
  bankgiro?: string
  paymentTermsDays?: number
  invoiceColor?: string
  invoiceTemplate?: string
  morningReportEnabled?: boolean
  remindersEnabled?: boolean
  reminderFeeSek?: number
  reminderFormalDay?: number
  reminderCollectionDay?: number
  collectionAgencyName?: string
  hasFSkatt?: boolean
  fSkattApprovedDate?: string
  vatNumber?: string
}

export function getOrganization(): Promise<Organization> {
  return get<Organization>('/organizations/me')
}

export function updateOrganization(dto: UpdateOrganizationInput): Promise<Organization> {
  return patch<Organization>('/organizations/me', dto)
}

export async function uploadLogo(file: File): Promise<Organization> {
  const formData = new FormData()
  formData.append('logo', file)
  const { data } = await api.patch<{ data: Organization }>('/organizations/me/logo', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}
