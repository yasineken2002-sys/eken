import { get, post } from '@/lib/api'
import type { MeterReading, CreateReadingInput } from '@eken/shared'

// Tunna helpers mot /v1/consumption/readings. Egen subdomän-fil (inte gemensam).
// GET stöder 1.1:s filter (meterId/unitId/periodStart/periodEnd — period matchar
// avläsningens slutdatum). POST går genom motorns källagnostiska recordReading
// (MANUAL här). Rör aldrig debiterings-/bokföringskedjan.

export interface ReadingFilters {
  meterId?: string
  unitId?: string
  periodStart?: string
  periodEnd?: string
}

// recordReading returnerar avläsningen + ev. skapad förbrukningspost (utkast) +
// idempotens-flagga. charge typas minimalt här (full ConsumptionCharge ägs av 1.5).
export interface RecordReadingResult {
  reading: MeterReading
  charge: { id: string; status: string; totalAmount: number | string } | null
  idempotent: boolean
}

export function fetchReadings(filters?: ReadingFilters): Promise<MeterReading[]> {
  return get<MeterReading[]>(
    '/consumption/readings',
    filters as Record<string, unknown> | undefined,
  )
}

export function createReading(dto: CreateReadingInput): Promise<RecordReadingResult> {
  return post<RecordReadingResult>('/consumption/readings', dto)
}
