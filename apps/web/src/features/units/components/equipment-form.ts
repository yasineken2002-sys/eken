import type {
  CreateEquipmentInput,
  EquipmentKind,
  RegisterReplacementInput,
} from '../api/equipment.api'

/**
 * FORMULÄRETS REGLER, SKILDA FRÅN DESS UTSEENDE.
 *
 * Reglerna bor här och inte i komponenten av ett mätbart skäl: en regel som
 * bara finns i JSX kan bara prövas genom att rendera, klicka och läsa DOM — och
 * ett sådant prov faller lika gärna på en klassändring som på en trasig regel.
 * Här är de rena funktioner, och provet kan inte bli grönt av fel skäl.
 *
 * VALIDERINGEN ÄR INTE SPÄRREN. Servern är spärren (`class-validator` på DTO:n,
 * org-scopning i tjänsten). Det här är att slippa skicka något man redan vet är
 * fel — samma sak som CLAUDE.md säger om förhandsbesked kontra grind.
 */

export interface EquipmentFormValues {
  kind: EquipmentKind | ''
  label: string
  installedAt: string
  expectedLifespanYears: string
  serviceIntervalMonths: string
}

export interface ReplacementFormValues {
  kind: EquipmentKind | ''
  label: string
  occurredAt: string
  performedById: string
  cost: string
  note: string
}

export type Fel = Partial<Record<string, string>>

/** Tom sträng betyder INTE ANGIVET, inte noll. Se kostnadens docblock i schemat. */
function taltEllerNull(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  // Svensk inmatning: "12 000,50" ska bli 12000.5, inte NaN.
  const n = Number(t.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function tolkaBelopp(v: string): number | null {
  return taltEllerNull(v)
}

export function validateEquipment(v: EquipmentFormValues): Fel {
  const fel: Fel = {}
  if (!v.kind) fel.kind = 'Välj vilken sorts utrustning det är'
  if (!v.installedAt) {
    fel.installedAt = 'Ange när den installerades'
  } else if (Number.isNaN(Date.parse(v.installedAt))) {
    fel.installedAt = 'Ogiltigt datum'
  }
  for (const [fält, etikett] of [
    ['expectedLifespanYears', 'Förväntad livslängd'],
    ['serviceIntervalMonths', 'Serviceintervall'],
  ] as const) {
    const rå = v[fält]
    if (rå.trim() === '') continue // TOMT ÄR GILTIGT — ingen förväntan är uttalad.
    const n = taltEllerNull(rå)
    if (n === null || !Number.isInteger(n) || n < 1) {
      fel[fält] = `${etikett} måste vara ett helt tal större än 0`
    }
  }
  return fel
}

export function validateReplacement(v: ReplacementFormValues): Fel {
  const fel: Fel = {}
  if (!v.occurredAt) {
    fel.occurredAt = 'Ange när bytet skedde'
  } else if (Number.isNaN(Date.parse(v.occurredAt))) {
    fel.occurredAt = 'Ogiltigt datum'
  }
  if (v.cost.trim() !== '') {
    const n = taltEllerNull(v.cost)
    if (n === null || n < 0) fel.cost = 'Kostnaden måste vara ett belopp om den anges'
  }
  return fel
}

/**
 * TOMMA FÄLT SKICKAS INTE ALLS.
 *
 * `exactOptionalPropertyTypes` skiljer på saknad och `undefined`, och servern
 * skiljer på "inte angivet" (= okänt) och ett värde. Ett tomt fält som blir
 * `label: ''` hade skrivit tom sträng där NULL betyder något.
 */
export function toCreatePayload(unitId: string, v: EquipmentFormValues): CreateEquipmentInput {
  const livslängd = taltEllerNull(v.expectedLifespanYears)
  const intervall = taltEllerNull(v.serviceIntervalMonths)
  return {
    unitId,
    kind: v.kind as EquipmentKind,
    installedAt: new Date(v.installedAt).toISOString(),
    ...(v.label.trim() ? { label: v.label.trim() } : {}),
    ...(livslängd !== null ? { expectedLifespanYears: livslängd } : {}),
    ...(intervall !== null ? { serviceIntervalMonths: intervall } : {}),
  }
}

export function toReplacementPayload(v: ReplacementFormValues): RegisterReplacementInput {
  const kostnad = taltEllerNull(v.cost)
  return {
    occurredAt: new Date(v.occurredAt).toISOString(),
    ...(v.kind ? { kind: v.kind } : {}),
    ...(v.label.trim() ? { label: v.label.trim() } : {}),
    ...(v.performedById ? { performedById: v.performedById } : {}),
    ...(kostnad !== null ? { cost: kostnad } : {}),
    ...(v.note.trim() ? { note: v.note.trim() } : {}),
  }
}

export const TOM_UTRUSTNING: EquipmentFormValues = {
  kind: '',
  label: '',
  installedAt: '',
  expectedLifespanYears: '',
  serviceIntervalMonths: '',
}

export const TOMT_BYTE: ReplacementFormValues = {
  kind: '',
  label: '',
  occurredAt: '',
  performedById: '',
  cost: '',
  note: '',
}
