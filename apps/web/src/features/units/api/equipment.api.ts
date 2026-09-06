import { get, post, patch } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { CreateEquipmentSchema, RegisterReplacementSchema, EQUIPMENT_KINDS } from '@eken/shared'
import type { CreateEquipmentInput, RegisterReplacementInput, EquipmentKind } from '@eken/shared'
export type { CreateEquipmentInput, RegisterReplacementInput }
export { EQUIPMENT_KINDS }
export type { EquipmentKind }

// EQUIPMENT_KINDS och EquipmentKind kommer nu från @eken/shared. Listan stod i
// TVÅ oberoende deklarationer (här och i create-equipment.dto.ts) som ingenting
// höll lika — identiska när jag mätte, men en typ tillagd på ena stället hade
// gett ett värde gränssnittet erbjuder och servern avvisar.

export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = {
  REFRIGERATOR: 'Kylskåp',
  FREEZER: 'Frys',
  STOVE: 'Spis',
  DISHWASHER: 'Diskmaskin',
  WASHING_MACHINE: 'Tvättmaskin',
  DRYER: 'Torktumlare',
  BOILER: 'Värmepanna',
  HEAT_PUMP: 'Värmepump',
  VENTILATION: 'Ventilation',
  ELEVATOR: 'Hiss',
  BATHROOM_FIXTURE: 'Badrumsinredning',
  KITCHEN_FIXTURE: 'Köksinredning',
  FLOORING: 'Golv',
  WINDOW: 'Fönster',
  DOOR: 'Dörr',
  LOCK: 'Lås',
  OTHER: 'Övrigt',
}

export interface EquipmentEvent {
  id: string
  type: 'INSTALLED' | 'SERVICED' | 'REPAIRED' | 'REPLACED' | 'REMOVED'
  occurredAt: string
  note: string | null
  cost: number | null
  attachmentUrl: string | null
  correctsId: string | null
  performedBy: { id: string; firstName: string; lastName: string } | null
}

export interface Equipment {
  id: string
  kind: EquipmentKind
  label: string | null
  installedAt: string
  removedAt: string | null
  replacedById: string | null
  expectedLifespanYears: number | null
  serviceIntervalMonths: number | null
  events: EquipmentEvent[]
}

/**
 * TYPERNA KOMMER NU FRÅN @eken/shared.
 *
 * `RegisterReplacementInput` saknade `maintenanceTicketId` — fältet finns i
 * DTO:n och kopplar bytet till felanmälan som föranledde det. Kopplingen gick
 * alltså inte att sätta från gränssnittet.
 */
export function fetchEquipment(unitId: string): Promise<Equipment[]> {
  return get<Equipment[]>(`/equipment/unit/${unitId}`)
}

export function createEquipment(dto: CreateEquipmentInput): Promise<Equipment> {
  const kontrakt = kontraktsfel(CreateEquipmentSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return post<Equipment>('/equipment', dto)
}

export function updateEquipment(
  id: string,
  dto: { label?: string; expectedLifespanYears?: number; serviceIntervalMonths?: number },
): Promise<Equipment> {
  return patch<Equipment>(`/equipment/${id}`, dto)
}

export function registerReplacement(
  id: string,
  dto: RegisterReplacementInput,
): Promise<{ replacement: Equipment; event: EquipmentEvent }> {
  const kontrakt = kontraktsfel(RegisterReplacementSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return post(`/equipment/${id}/replacement`, dto)
}
