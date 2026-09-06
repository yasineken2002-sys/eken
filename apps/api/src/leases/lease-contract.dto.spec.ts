/**
 * HYRESAVTALETS KROPPAR — mot den RIKTIGA ValidationPipe.
 *
 * ── VAD DEN HÄR FILEN MÄTER ─────────────────────────────────────────────────
 *
 * Att de åtta kontraktsbärande endpointerna godtar den form webben skickar, och
 * avvisar den den inte ska godta. Pipen konfigureras med SAMMA flaggor som
 * `main.ts` (`whitelist`, `forbidNonWhitelisted`, `transform`) — avviker de är
 * provet en attrapp av produktionen i stället för en mätning av den.
 *
 * `forbidNonWhitelisted` är skälet till att ett fält som finns i schemat men
 * SAKNAS i DTO:n inte är en skönhetsfläck: ett schematroget anrop får 400.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * De regler som kräver DATABASEN: uppsägningstidens minimum per enhetstyp (3
 * mån bostad, 9 mån lokal — JB 12 kap 4 §) och depositionstaket, som båda läser
 * `unit.type`. De ägs av `leases.service.ts` via `leases.compliance.ts` och
 * mäts av tjänstens egna prov. Här mäts bara vad som tar sig FÖRBI pipen.
 */
import { ValidationPipe } from '@nestjs/common'

import { CreateLeaseDto } from './dto/create-lease.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { TransitionLeaseStatusDto } from './dto/transition-status.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { UpdateAppendixDto } from '../contracts/dto/update-appendix.dto'
import { CreateSigningRequestDto } from '../signing/dto/create-signing-request.dto'

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
const validera = (kropp: unknown, metatype: unknown) =>
  pipe.transform(kropp, { type: 'body', metatype: metatype as never })

const UNIT = '11111111-2222-4333-8444-555555555555'
const TENANT = '22222222-3333-4444-8555-666666666666'
const DOK = '33333333-4444-4555-8666-777777777777'

const avtal = (over: Record<string, unknown> = {}) => ({
  unitId: UNIT,
  tenantId: TENANT,
  startDate: '2026-01-01',
  monthlyRent: 12000,
  ...over,
})

describe('POST /leases — kroppen mot ValidationPipe', () => {
  it('godtar minimikroppen: enhet, hyresgäst, startdatum, hyra', async () => {
    await expect(validera(avtal(), CreateLeaseDto)).resolves.toMatchObject({ monthlyRent: 12000 })
  })

  // ── EN KROPP PER HYRESREGIM ───────────────────────────────────────────────
  //
  // Båda regimerna går genom SAMMA DTO. Det är inte en lucka: mätt mot
  // `leases.compliance.ts` finns ingen regimberoende regel VID SKAPANDET —
  // `minNoticePeriodMonths` och `maxDepositAmount` läser `unit.type`, inte
  // regimen, och skillnaden mellan hyreslagen och privatuthyrningslagen
  // (2012:978) ligger i UPPSÄGNINGENS mekanik. Proven nedan fastnaglar att
  // båda regimerna tar sig igenom, så att den dag en regimberoende regel
  // införs faller det prov vars regim inte längre passerar.
  it('TENANCY_ACT (hyreslagen) passerar', async () => {
    await expect(
      validera(avtal({ tenancyRegime: 'TENANCY_ACT' }), CreateLeaseDto),
    ).resolves.toMatchObject({ tenancyRegime: 'TENANCY_ACT' })
  })

  it('PRIVATE_RENTAL (privatuthyrningslagen) passerar', async () => {
    await expect(
      validera(avtal({ tenancyRegime: 'PRIVATE_RENTAL' }), CreateLeaseDto),
    ).resolves.toMatchObject({ tenancyRegime: 'PRIVATE_RENTAL' })
  })

  it('avvisar en regim som inte finns', async () => {
    await expect(validera(avtal({ tenancyRegime: 'ANDRAHAND' }), CreateLeaseDto)).rejects.toThrow()
  })

  it('avvisar noll månaders uppsägningstid — det är ingen uppsägningstid', async () => {
    await expect(validera(avtal({ noticePeriodMonths: 0 }), CreateLeaseDto)).rejects.toThrow()
  })

  it('godtar hela villkorsblocket — inget av fälten faller på forbidNonWhitelisted', async () => {
    const villkor = {
      includesHeating: true,
      includesWater: true,
      includesHotWater: true,
      includesElectricity: false,
      includesInternet: false,
      includesCleaning: false,
      includesParking: false,
      includesStorage: false,
      includesLaundry: true,
      parkingFee: 500,
      storageFee: 200,
      garageFee: 900,
      usagePurpose: 'Bostad',
      petsAllowed: 'REQUIRES_APPROVAL',
      petsApprovalNotes: 'Katt tillåten efter besked',
      sublettingAllowed: false,
      requiresHomeInsurance: true,
      indexClauseType: 'KPI',
      indexBaseYear: 2026,
      indexAdjustmentDate: '2027-01-01',
      indexMaxIncrease: 5,
      indexMinIncrease: 0,
      indexNotes: 'KPI oktober',
      specialTerms: 'Garaget ingår inte',
    }
    await expect(validera(avtal(villkor), CreateLeaseDto)).resolves.toMatchObject({
      indexClauseType: 'KPI',
      specialTerms: 'Garaget ingår inte',
    })
  })

  it('DEN AVGÖRANDE: ett fält som inte står i DTO:n avvisas (forbidNonWhitelisted)', async () => {
    await expect(validera(avtal({ indexClause: true }), CreateLeaseDto)).rejects.toThrow()
  })
})

describe('POST /leases/with-tenant', () => {
  const medBefintlig = {
    unitId: UNIT,
    existingTenantId: TENANT,
    startDate: '2026-01-01',
    monthlyRent: 12000,
  }

  it('godtar befintlig hyresgäst', async () => {
    await expect(validera(medBefintlig, CreateLeaseWithTenantDto)).resolves.toMatchObject({
      unitId: UNIT,
    })
  })

  it('godtar en ny hyresgäst med NÄSTAD kropp', async () => {
    await expect(
      validera(
        {
          unitId: UNIT,
          startDate: '2026-01-01',
          monthlyRent: 12000,
          newTenant: { type: 'INDIVIDUAL', firstName: 'Anna', lastName: 'Ek', email: 'a@ek.se' },
        },
        CreateLeaseWithTenantDto,
      ),
    ).resolves.toMatchObject({ newTenant: { firstName: 'Anna' } })
  })

  it('avvisar ett okänt fält i den NÄSTADE hyresgästen', async () => {
    await expect(
      validera(
        {
          unitId: UNIT,
          startDate: '2026-01-01',
          monthlyRent: 12000,
          newTenant: { type: 'INDIVIDUAL', email: 'a@ek.se', personnummer: '19900101-1234' },
        },
        CreateLeaseWithTenantDto,
      ),
    ).rejects.toThrow()
  })

  it('godtar activate — kontraktet aktiveras i samma anrop', async () => {
    await expect(
      validera({ ...medBefintlig, activate: true }, CreateLeaseWithTenantDto),
    ).resolves.toMatchObject({ activate: true })
  })
})

describe('de sex övriga kropparna', () => {
  it('PATCH /leases/:id godtar en partiell kropp', async () => {
    await expect(validera({ monthlyRent: 13000 }, UpdateLeaseDto)).resolves.toMatchObject({
      monthlyRent: 13000,
    })
  })

  it('PATCH /leases/:id/status godtar de fyra tillstånden och inget femte', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'TERMINATED', 'EXPIRED']) {
      await expect(validera({ status }, TransitionLeaseStatusDto)).resolves.toMatchObject({
        status,
      })
    }
    await expect(validera({ status: 'AKTIV' }, TransitionLeaseStatusDto)).rejects.toThrow()
  })

  it('PATCH /leases/:id/terminate kräver ISO-datum, inte fritext', async () => {
    await expect(
      validera({ terminationReason: 'Flytt', effectiveDate: '2026-06-30' }, TerminateLeaseDto),
    ).resolves.toMatchObject({ effectiveDate: '2026-06-30' })
    await expect(validera({ effectiveDate: '30 juni 2026' }, TerminateLeaseDto)).rejects.toThrow()
  })

  it('PATCH /leases/:id/renew avvisar negativ hyra', async () => {
    await expect(
      validera({ newEndDate: '2027-12-31', monthlyRent: 13000 }, RenewLeaseDto),
    ).resolves.toMatchObject({ monthlyRent: 13000 })
    await expect(validera({ monthlyRent: -1 }, RenewLeaseDto)).rejects.toThrow()
  })

  it('PATCH /contracts/:leaseId/appendices/:documentId avvisar negativ ordning', async () => {
    await expect(
      validera(
        { attachedToLeaseAsAppendix: true, category: 'ENERGY_DECLARATION', appendixOrder: 1 },
        UpdateAppendixDto,
      ),
    ).resolves.toMatchObject({ appendixOrder: 1 })
    await expect(validera({ appendixOrder: -1 }, UpdateAppendixDto)).rejects.toThrow()
  })

  it('POST /signing/requests kräver ett UUID', async () => {
    await expect(validera({ documentId: DOK }, CreateSigningRequestDto)).resolves.toMatchObject({
      documentId: DOK,
    })
    await expect(
      validera({ documentId: 'inte-ett-uuid' }, CreateSigningRequestDto),
    ).rejects.toThrow()
  })
})
