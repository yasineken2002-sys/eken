import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateReadingInput } from '@eken/shared'
import { fetchReadings, createReading } from '../api/readings.api'
import type { ReadingFilters } from '../api/readings.api'

// Disjunkt list-nyckel ['readings', filters]. Append-only underlag — ingen
// detalj-/uppdaterings-query finns (rättning = ny rad i backend).
const READINGS_LIST = (filters?: ReadingFilters) => ['readings', filters ?? {}] as const

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useReadings(filters?: ReadingFilters) {
  return useQuery({
    queryKey: READINGS_LIST(filters),
    queryFn: () => fetchReadings(filters),
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateReading() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateReadingInput) => createReading(dto),
    onSuccess: () => {
      // En ny avläsning kan skapa en förbrukningspost (utkast) → invalidera både
      // hela readings-listan och charges-listan (1.5 läser den).
      void qc.invalidateQueries({ queryKey: ['readings'] })
      void qc.invalidateQueries({ queryKey: ['charges'] })
    },
  })
}
