import { BadRequestException } from '@nestjs/common'
import type { TenancyRegime, UnitType } from '@prisma/client'

// JB 12 kap 4 § — minsta uppsägningstid från hyresvärden.
// Bostad (APARTMENT): 3 mån. Lokal (övriga): 9 mån.
// Tvingande till hyresgästens förmån (1 § 5 st) — kortare avtal är ogiltigt.
export function minNoticePeriodMonths(unitType: UnitType): number {
  return unitType === 'APARTMENT' ? 3 : 9
}

export type TerminationInitiator = 'LANDLORD' | 'TENANT'

// Privatuthyrningslagen (2012:978) omfattar bara BOSTAD upplåten av en privatperson.
// Endast APARTMENT kan därför lyda under PRIVATE_RENTAL — lokaler faller alltid
// under hyreslagen oavsett fältets värde (defensivt).
export function isPrivateHomeRental(regime: TenancyRegime, unitType: UnitType): boolean {
  return regime === 'PRIVATE_RENTAL' && unitType === 'APARTMENT'
}

// Default-regelverk vid kontraktsskapande: ALLTID hyreslagen (JB 12 kap).
// Privatuthyrningslagen (2012:978) gäller bara uthyrning av EGEN bostad UTANFÖR
// näringsverksamhet (§ 1) och kan INTE härledas från enhetstyp — Evenos kundbas
// är näringsidkare (CompanyForm = enbart bolagsformer). PRIVATE_RENTAL är därför
// ett MEDVETET opt-in per kontrakt (CreateLeaseDto.tenancyRegime), aldrig default.
// Asymmetrin i felriktning avgör: default TENANCY_ACT kan ALDRIG ge en ogiltig
// (för kort, besittningsskydds-kringgående) uppsägning — en ev. felklassning ger
// bara överskydd åt hyresgästen. Default PRIVATE_RENTAL skulle kunna ge ett
// olagligt avslut mot en besittningsskyddad hyresgäst. (Hyresjurist + användar-
// beslut 2026-07-08.)
export function defaultTenancyRegime(): TenancyRegime {
  return 'TENANCY_ACT'
}

// Antal månaders uppsägningstid för ETT uppsägningstillfälle, beroende på regelverk
// OCH vem som säger upp (#69). Returnerar månader som sedan rundas till månadsskifte
// via endOfNoticePeriod (@eken/shared) i terminate()/suggestEndDate.
//
//   • PRIVATE_RENTAL (bostad, lag 2012:978 § 3):
//       hyresgäst → 1 mån  (TVINGANDE golv — får aldrig tvingas längre),
//       hyresvärd → minst 3 mån (kan förlängas via avtal, aldrig kortare).
//   • TENANCY_ACT (hyreslagen JB 12 kap) — OFÖRÄNDRAT F2-beteende:
//       avtalets noticePeriodMonths (valideras ≥ JB-min vid skapande), samma
//       oavsett vem som säger upp. (Hyresvärds/hyresgäst-asymmetrin under JB är
//       en separat uppföljning, #71/hyresjurist — INTE del av #69.)
export function terminationNoticeMonths(input: {
  regime: TenancyRegime
  initiator: TerminationInitiator
  unitType: UnitType
  contractualNoticeMonths: number
}): number {
  if (isPrivateHomeRental(input.regime, input.unitType)) {
    return input.initiator === 'TENANT' ? 1 : Math.max(3, input.contractualNoticeMonths)
  }
  return input.contractualNoticeMonths
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
