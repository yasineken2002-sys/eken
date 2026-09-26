import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchInspections,
  fetchStats,
  fetchInspection,
  createInspection,
  updateInspection,
  updateInspectionItem,
  deleteInspection,
  downloadProtocolPdf,
  analyzeInspection,
  fetchInspectionVersions,
  fetchImageCheck,
  createInspectionCorrection,
} from '../api/inspections.api'
import type {
  CreateInspectionCorrectionInput,
  InspectionFilter,
  CreateInspectionInput,
  UpdateInspectionInput,
  UpdateInspectionItemInput,
  AnalyzeInspectionResult,
} from '../api/inspections.api'

export function useInspections(filters?: InspectionFilter) {
  return useQuery({
    queryKey: ['inspections', filters],
    queryFn: () => fetchInspections(filters),
    staleTime: 60_000,
  })
}

export function useInspectionStats() {
  return useQuery({
    queryKey: ['inspections', 'stats'],
    queryFn: fetchStats,
    staleTime: 60_000,
  })
}

export function useInspection(id: string | null) {
  return useQuery({
    queryKey: ['inspections', id],
    queryFn: () => fetchInspection(id!),
    enabled: !!id,
    staleTime: 60_000,
  })
}

export function useCreateInspection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateInspectionInput) => createInspection(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}

export function useUpdateInspection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateInspectionInput }) =>
      updateInspection(id, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}

export function useUpdateInspectionItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      inspectionId,
      itemId,
      dto,
    }: {
      inspectionId: string
      itemId: string
      dto: UpdateInspectionItemInput
    }) => updateInspectionItem(inspectionId, itemId, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}

export function useDeleteInspection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteInspection(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}

export function useInspectionVersions(id: string | null) {
  return useQuery({
    queryKey: ['inspections', id, 'versioner'],
    queryFn: () => fetchInspectionVersions(id!),
    enabled: !!id,
    staleTime: 60_000,
  })
}

/**
 * Bildkontrollen körs BARA när någon ber om den.
 *
 * `enabled: false` är inte en optimering utan en hållning: kontrollen läser
 * varje bilagas bytes ur lagringen, och ett resultat som dyker upp av sig självt
 * vid varje panelöppning hade blivit en siffra ingen beställt och ingen läser.
 * `refetch()` från knappen är vad som startar den.
 */
export function useImageCheck(id: string | null) {
  return useQuery({
    queryKey: ['inspections', id, 'bildkontroll'],
    queryFn: () => fetchImageCheck(id!),
    enabled: false,
    // Utfallet gäller den sekund det mättes. Att servera ett gammalt svar ur
    // cachen hade varit att visa en kontroll som inte utfördes nu.
    gcTime: 0,
    staleTime: 0,
  })
}

export function useCreateCorrection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: CreateInspectionCorrectionInput }) =>
      createInspectionCorrection(id, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}

export function useDownloadPdf() {
  return useMutation({
    mutationFn: (id: string) => downloadProtocolPdf(id),
  })
}

export function useAnalyzeInspection() {
  const qc = useQueryClient()
  return useMutation<
    AnalyzeInspectionResult,
    Error,
    { id: string; files: Array<{ file: File; caption?: string; nyckel?: string }> }
  >({
    mutationFn: ({ id, files }) => analyzeInspection(id, files),
    // onSettled, inte onSuccess: servern sparar bilderna FÖRE AI-anropet
    // (saveAnalysisImages → analyzeImages), så även ett misslyckat försök kan ha
    // lagt till bilagor. Utan omläsning syns de inte, och ett nytt försök laddar
    // upp samma bild igen.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}
