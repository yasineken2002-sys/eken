import { get, post, patch } from '@/lib/api'

export const EQUIPMENT_KINDS = [
  'REFRIGERATOR',
  'FREEZER',
  'STOVE',
  'DISHWASHER',
  'WASHING_MACHINE',
  'DRYER',
  'BOILER',
  'HEAT_PUMP',
  'VENTILATION',
  'ELEVATOR',
  'BATHROOM_FIXTURE',
  'KITCHEN_FIXTURE',
  'FLOORING',
  'WINDOW',
  'DOOR',
  'LOCK',
  'OTHER',
] as const

export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number]

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

export interface CreateEquipmentInput {
  unitId: string
  kind: EquipmentKind
  label?: string
  installedAt: string
  expectedLifespanYears?: number
  serviceIntervalMonths?: number
}

export interface RegisterReplacementInput {
  kind?: EquipmentKind
  label?: string
  occurredAt: string
  performedById?: string
  cost?: number
  attachmentUrl?: string
  note?: string
  expectedLifespanYears?: number
  serviceIntervalMonths?: number
}

export function fetchEquipment(unitId: string): Promise<Equipment[]> {
  return get<Equipment[]>(`/equipment/unit/${unitId}`)
}

export function createEquipment(dto: CreateEquipmentInput): Promise<Equipment> {
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
  return post(`/equipment/${id}/replacement`, dto)
}
