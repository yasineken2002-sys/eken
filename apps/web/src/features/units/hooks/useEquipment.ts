import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchEquipment,
  createEquipment,
  updateEquipment,
  registerReplacement,
} from '../api/equipment.api'
import type { CreateEquipmentInput, RegisterReplacementInput } from '../api/equipment.api'

// Disjunkta nycklar — utrustningen hör till EN lägenhet, och en mutation på en
// lägenhets utrustning får inte invalidera en annans.
const EQUIPMENT_LIST = (unitId: string) => ['equipment', 'list', unitId] as const

export function useEquipment(unitId: string | null) {
  return useQuery({
    queryKey: EQUIPMENT_LIST(unitId ?? '__disabled__'),
    queryFn: () => fetchEquipment(unitId!),
    enabled: !!unitId,
  })
}

export function useCreateEquipment(unitId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateEquipmentInput) => createEquipment(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EQUIPMENT_LIST(unitId) })
      // Historiken har fått en ny händelse — annars visar fliken en föråldrad bild.
      void qc.invalidateQueries({ queryKey: ['history'] })
    },
  })
}

export function useUpdateEquipment(unitId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string; label?: string }) => updateEquipment(id, dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: EQUIPMENT_LIST(unitId) }),
  })
}

export function useRegisterReplacement(unitId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & RegisterReplacementInput) =>
      registerReplacement(id, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EQUIPMENT_LIST(unitId) })
      void qc.invalidateQueries({ queryKey: ['history'] })
    },
  })
}
