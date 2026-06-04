import { BadRequestException } from '@nestjs/common'
import { CreateLeaseWithTenantDto } from '../leases/dto/create-lease-with-tenant.dto'
import type { ScannedContract } from './contract-scanner.service'

/**
 * Bygg + OM-VALIDERA ett CreateLeaseWithTenantDto från (eventuellt redigerad)
 * skanningsdata innan commit (PR3). Speglar bankens sanitizeEdited: ingen
 * ovaliderad data når avtalsskapandet.
 *
 * Viktigt: ContractScanBatchService anropar LeasesService.createWithTenant
 * DIREKT (inte via en controller), så NestJS ValidationPipe körs ALDRIG på
 * detta DTO. Därför måste vi själva validera de fält som annars skyddas av
 * class-validator-dekoratorerna (e-postformat, månadshyra som tal > 0,
 * startdatum som giltigt datum, hyresgästnamn). createWithTenant lägger sedan
 * på sina egna kontroller (enhets-org-scope, dubblett-e-post, enhetskonflikt).
 *
 * Avtalet skapas som UTKAST (activate=false): en batch-import av redan ingångna
 * kontrakt ska inte massutlösa välkomstmejl/PDF-generering. Operatören aktiverar
 * varje avtal via det vanliga avtalsflödet — och enhetskonflikt-spärren i
 * createWithTenant fångar ändå en redan uthyrd (ACTIV-leasad) enhet direkt.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Rimlighetstak (skydd mot AI-feltolkning / operatörstryckfel som annars kan ge
// fakturor på orimliga belopp). Täcker även stora kommersiella lokaler.
const MAX_MONTHLY_RENT = 500_000
const MAX_DEPOSIT = MAX_MONTHLY_RENT * 6

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const t = Date.parse(s)
  return !Number.isNaN(t)
}

export function buildLeaseDtoFromScan(
  scan: ScannedContract,
  unitId: string,
): CreateLeaseWithTenantDto {
  if (!unitId || typeof unitId !== 'string') {
    throw new BadRequestException('Ingen enhet vald för raden.')
  }

  // ── Månadshyra ────────────────────────────────────────────────────────────
  const monthlyRent = scan.monthlyRent
  if (
    typeof monthlyRent !== 'number' ||
    !Number.isFinite(monthlyRent) ||
    monthlyRent <= 0 ||
    monthlyRent > MAX_MONTHLY_RENT
  ) {
    throw new BadRequestException(
      `Månadshyra måste vara mellan 1 och ${MAX_MONTHLY_RENT} kr för att skapa avtal.`,
    )
  }

  // ── Startdatum ────────────────────────────────────────────────────────────
  const startDate = scan.startDate?.trim() ?? ''
  if (!isValidDate(startDate)) {
    throw new BadRequestException('Giltigt startdatum (ÅÅÅÅ-MM-DD) krävs för att skapa avtal.')
  }

  // ── Hyresgäst ─────────────────────────────────────────────────────────────
  const email = scan.tenantEmail?.trim() ?? ''
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestException(
      'Hyresgästens e-post krävs och måste vara giltig — lägg till den i granskningen innan du godkänner.',
    )
  }

  const tenantType: 'INDIVIDUAL' | 'COMPANY' =
    scan.tenantType === 'COMPANY' ? 'COMPANY' : 'INDIVIDUAL'
  const newTenant: CreateLeaseWithTenantDto['newTenant'] = { type: tenantType, email }

  if (tenantType === 'INDIVIDUAL') {
    const name = (scan.tenantName ?? '').trim().replace(/\s+/g, ' ')
    const parts = name.split(' ').filter(Boolean)
    if (parts.length < 2) {
      throw new BadRequestException(
        'Förnamn och efternamn krävs för en privatperson — komplettera namnet i granskningen.',
      )
    }
    newTenant.firstName = parts[0]!
    newTenant.lastName = parts.slice(1).join(' ')
  } else {
    const companyName = (scan.companyName ?? scan.tenantName ?? '').trim()
    if (companyName === '') {
      throw new BadRequestException('Företagsnamn krävs för en företagshyresgäst.')
    }
    newTenant.companyName = companyName
  }

  if (scan.tenantPhone?.trim()) newTenant.phone = scan.tenantPhone.trim()
  if (scan.personalNumber?.trim()) newTenant.personalNumber = scan.personalNumber.trim()
  if (scan.orgNumber?.trim()) newTenant.orgNumber = scan.orgNumber.trim()

  // ── Avtalet ───────────────────────────────────────────────────────────────
  const dto: CreateLeaseWithTenantDto = {
    unitId,
    newTenant,
    monthlyRent,
    startDate,
    // Utkast — operatören aktiverar via det vanliga flödet.
    activate: false,
  }
  if (
    typeof scan.depositAmount === 'number' &&
    Number.isFinite(scan.depositAmount) &&
    scan.depositAmount >= 0 &&
    scan.depositAmount <= MAX_DEPOSIT
  ) {
    dto.depositAmount = scan.depositAmount
  }
  // endDate tas bara med om det är ett giltigt datum (annars INDEFINITE-utkast).
  if (scan.endDate?.trim() && isValidDate(scan.endDate.trim())) {
    dto.endDate = scan.endDate.trim()
    dto.leaseType = 'FIXED_TERM'
  }
  if (
    typeof scan.noticePeriodMonths === 'number' &&
    Number.isInteger(scan.noticePeriodMonths) &&
    scan.noticePeriodMonths >= 1 &&
    scan.noticePeriodMonths <= 60
  ) {
    dto.noticePeriodMonths = scan.noticePeriodMonths
  }

  return dto
}
