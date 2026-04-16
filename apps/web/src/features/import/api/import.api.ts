import { api, get } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportError {
  row: number
  message: string
}

export interface PreviewResult {
  type: string
  filename: string
  totalRows: number
  validRows: number
  errorRows: number
  headers: string[]
  detectedMappings: Record<string, string>
  preview: Record<string, string>[]
  errors: ImportError[]
}

export interface ImportJob {
  id: string
  organizationId: string
  type: 'PROPERTIES' | 'UNITS' | 'TENANTS' | 'LEASES'
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  filename: string
  totalRows: number
  processedRows: number
  successRows: number
  errorRows: number
  errors: ImportError[]
  createdById: string
  createdAt: string
  completedAt: string | null
}

export interface ScannedContract {
  tenantName: string | null
  tenantType: 'INDIVIDUAL' | 'COMPANY' | null
  tenantEmail: string | null
  tenantPhone: string | null
  personalNumber: string | null
  companyName: string | null
  orgNumber: string | null
  propertyAddress: string | null
  unitDescription: string | null
  monthlyRent: number | null
  depositAmount: number | null
  startDate: string | null
  endDate: string | null
  noticePeriodMonths: number | null
  confidence: number
  rawText: string
}

// ─── API Functions ────────────────────────────────────────────────────────────

export async function previewImport(file: File, type: string): Promise<PreviewResult> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('type', type)

  const token = useAuthStore.getState().accessToken
  const { data } = await api.post<{ data: PreviewResult }>('/import/preview', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return data.data
}

export async function executeImport(file: File, type: string): Promise<ImportJob> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('type', type)

  const token = useAuthStore.getState().accessToken
  const { data } = await api.post<{ data: ImportJob }>('/import/execute', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return data.data
}

export async function scanContract(file: File): Promise<ScannedContract> {
  const formData = new FormData()
  formData.append('file', file)

  const token = useAuthStore.getState().accessToken
  const { data } = await api.post<{ data: ScannedContract }>('/import/scan-contract', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return data.data
}

export function getImportJobs(): Promise<ImportJob[]> {
  return get<ImportJob[]>('/import/jobs')
}

// ─── Template Downloads ───────────────────────────────────────────────────────

const TEMPLATES: Record<string, { headers: string; filename: string }> = {
  PROPERTIES: {
    headers: 'Namn,Fastighetsbeteckning,Typ,Gatuadress,Postnummer,Stad,Yta m²,Byggår',
    filename: 'eken-mall-fastigheter.csv',
  },
  UNITS: {
    headers: 'Enhetsnamn,Enhetsnummer,Fastighet,Typ,Status,Yta m²,Våning,Antal rum,Månadshyra',
    filename: 'eken-mall-enheter.csv',
  },
  TENANTS: {
    headers:
      'Typ,Förnamn,Efternamn,Företagsnamn,E-post,Telefon,Personnummer,Org.nummer,Gatuadress,Postnummer,Stad',
    filename: 'eken-mall-hyresgaster.csv',
  },
  LEASES: {
    headers: 'Hyresgäst e-post,Enhetsnummer,Startdatum,Slutdatum,Månadshyra,Deposition,Status',
    filename: 'eken-mall-kontrakt.csv',
  },
}

export function downloadTemplate(type: string): void {
  const template = TEMPLATES[type.toUpperCase()]
  if (!template) return

  // BOM for Excel Swedish char compatibility
  const bom = '\uFEFF'
  const content = bom + template.headers + '\n'

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = template.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
