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
} from '../api/inspections.api'
import type {
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
    { id: string; files: Array<{ file: File; caption?: string }> }
  >({
    mutationFn: ({ id, files }) => analyzeInspection(id, files),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] })
    },
  })
}
