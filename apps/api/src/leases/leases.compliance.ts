import { BadRequestException } from '@nestjs/common'
import type { UnitType } from '@prisma/client'

// JB 12 kap 4 § — minsta uppsägningstid från hyresvärden.
// Bostad (APARTMENT): 3 mån. Lokal (övriga): 9 mån.
// Tvingande till hyresgästens förmån (1 § 5 st) — kortare avtal är ogiltigt.
export function minNoticePeriodMonths(unitType: UnitType): number {
  return unitType === 'APARTMENT' ? 3 : 9
}

export function noticePeriodErrorMessage(unitType: UnitType): string {
  return unitType === 'APARTMENT'
    ? 'Uppsägningstid för bostad får inte vara kortare än 3 månader (JB 12 kap 4 § 1 st p 1)'
    : 'Uppsägningstid för lokal får inte vara kortare än 9 månader (JB 12 kap 4 § 1 st p 2)'
}

// Praxis (hyresnämnden + Konsumentverket): deposition för bostad får inte
// överstiga 3 månadshyror — högre belopp betraktas som otillåten förskotts-
// hyra och kan ogiltigförklaras. Lokalhyra har fri depositionsbestämning.
export function maxDepositAmount(monthlyRent: number, unitType: UnitType): number | null {
  if (unitType !== 'APARTMENT') return null
  return monthlyRent * 3
}

export function depositErrorMessage(max: number): string {
  return `Deposition för bostad får enligt praxis inte överstiga 3 månadshyror (${max.toLocaleString(
    'sv-SE',
  )} kr). Högre belopp kan ogiltigförklaras som otillåten förskottshyra.`
}

// Validerar uppsägningstid + depositionstak och kastar BadRequestException
// vid lagstridig kombination. Returnerar inget vid godkänd validering.
export function assertLeaseLegalLimits(input: {
  unitType: UnitType
  monthlyRent: number
  noticePeriodMonths: number
  depositAmount: number
}): void {
  const minNotice = minNoticePeriodMonths(input.unitType)
  if (input.noticePeriodMonths < minNotice) {
    throw new BadRequestException(noticePeriodErrorMessage(input.unitType))
  }
  const cap = maxDepositAmount(input.monthlyRent, input.unitType)
  if (cap != null && input.depositAmount > cap) {
    throw new BadRequestException(depositErrorMessage(cap))
  }
}
