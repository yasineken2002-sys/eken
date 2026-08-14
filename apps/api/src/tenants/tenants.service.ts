import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Tenant, Lease } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { normalizeEmail } from '../common/utils/normalize-email'
import { CreateTenantDto } from './dto/create-tenant.dto'
import { UpdateTenantDto } from './dto/update-tenant.dto'
import { TENANT_CREDENTIAL_KEYS, type TenantCredentialKey } from './tenant-credential-keys'

/**
 * Safe Prisma SELECT for tenant data exposed via API.
 *
 * Innehåller ALLA icke-känsliga Tenant-kolumner men ALDRIG portal-credentials
 * (passwordHash, *TokenHash, *TokenExpiresAt — se TENANT_CREDENTIAL_KEYS ovan).
 * Använd detta istället för `include: { tenant: true }` överallt en hyresgäst
 * returneras till ett hyresvärds-vänt endpoint — det är samma skydd som
 * mapTenant ger, fast på databas-nivå så hashen aldrig ens lämnar Postgres.
 *
 * PERSONNUMMER INGÅR INTE. Selecten delas av ett tjugotal ställen (fakturor,
 * depositioner, nycklar, besiktningar, dashboard, avisering …) där personnumret
 * aldrig behövdes — det åkte bara med. Den som verkligen ska visa numret väljer
 * `personalNumberEnc` explicit och dekrypterar vid användningstillfället.
 *
 * Behöver du fler icke-känsliga fält: LÄGG TILL dem här. Använd aldrig rå
 * `include: { tenant: true }` för Tenant. (Audit HIGH #2 — uppföljning PR #10.)
 */
export const SAFE_TENANT_SELECT = {
  id: true,
  organizationId: true,
  type: true,
  firstName: true,
  lastName: true,
  companyName: true,
  orgNumber: true,
  contactPerson: true,
  email: true,
  phone: true,
  street: true,
  city: true,
  postalCode: true,
  country: true,
  ocrNumber: true,

  // Portal-status (icke-känsligt — inga hemligheter)
  portalActivated: true,
  portalActivatedAt: true,
  activationReminderSentAt: true,

  // Tidsstämplar
  createdAt: true,
  updatedAt: true,

  // EXPLICIT EXKLUDERADE (LÄGG ALDRIG TILL — se TENANT_CREDENTIAL_KEYS):
  // - passwordHash
  // - activationTokenHash
  // - activationTokenExpiresAt
  // - passwordResetTokenHash
  // - passwordResetTokenExpiresAt
} as const satisfies Prisma.TenantSelect

type MappedTenant<T> = Omit<T, 'street' | 'city' | 'postalCode' | TenantCredentialKey> & {
  address?: { street: string; city: string; postalCode: string; country: string }
  personalNumber?: string | null
}

// Maps flat Prisma address fields → nested Address object matching @eken/shared
// Tenant type, och strippar portal-credentials + personnummer-kolumnerna ur
// svaret.
//
// `personalNumber` läggs tillbaka BARA när anroparen skickar med klartexten den
// själv dekrypterat. Utelämnas argumentet finns fältet inte i svaret — det är
// avsikten: ett endpoint som inte aktivt bett om personnumret ska inte råka
// returnera det.
function mapTenant<T extends Pick<Tenant, 'street' | 'city' | 'postalCode'>>(
  t: T,
  personalNumber?: string | null,
): MappedTenant<T> {
  const { street, city, postalCode, ...rest } = t
  // SECURITY (audit HIGH #2): ta bort portal-credentials innan hyresgästen
  // serialiseras till det hyresvärds-vända API:t.
  for (const key of TENANT_CREDENTIAL_KEYS) {
    delete (rest as Record<string, unknown>)[key]
  }
  return {
    ...rest,
    ...(personalNumber !== undefined ? { personalNumber } : {}),
    ...(street != null
      ? { address: { street, city: city ?? '', postalCode: postalCode ?? '', country: 'SE' } }
      : {}),
  } as MappedTenant<T>
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pn: PersonalNumberService,
  ) {}

  async findAll(organizationId: string, search?: string) {
    const tenants = await this.prisma.tenant.findMany({
      where: {
        organizationId,
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { companyName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        _count: { select: { invoices: true } },
        leases: {
          where: { status: { in: ['ACTIVE', 'DRAFT'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { unit: { include: { property: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return tenants.map((t) => {
      const { leases, ...rest } = t
      return {
        // LISTAN BÄR INTE PERSONNUMMER (dataminimering, 2026-08-02).
        //
        // `mapTenant` anropas med null i stället för `this.pn.reveal(...)`:
        // fältet finns kvar i svaret men är alltid tomt, så formen är oförändrad
        // för varje anropare. Detaljvyn (`findOne`) avslöjar det fortfarande —
        // en enskild uppslagning av EN hyresgäst är ett berättigat behov
        // (fakturering, tvist, kravhantering), en lista över ALLA är det inte.
        //
        // Skillnaden är blottningsytan: ett `GET /tenants` lämnade ut samtliga
        // personnummer i organisationen i ett enda anrop — till varje
        // autentiserad roll, eftersom endpointen saknar rollgrind per R1:s
        // medvetna policy att läsning är öppen. Rätt svar på det är inte att
        // stänga listan för läsande roller, utan att listan slutar bära
        // uppgiften. Se launch-readiness #36.
        ...mapTenant(rest, null),
        activeLease: leases[0] ?? null,
      }
    })
  }

  async findOne(id: string, organizationId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, organizationId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { lines: true },
        },
        leases: {
          orderBy: { createdAt: 'desc' },
          include: { unit: { include: { property: true } } },
        },
        _count: { select: { invoices: true } },
      },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')
    const { leases, ...rest } = tenant
    return {
      ...mapTenant(rest, this.pn.reveal(rest.personalNumberEnc)),
      leases,
      activeLease: leases.find((l) => l.status === 'ACTIVE' || l.status === 'DRAFT') ?? null,
    }
  }

  async create(dto: CreateTenantDto, organizationId: string) {
    if (dto.type === 'INDIVIDUAL' && (!dto.firstName?.trim() || !dto.lastName?.trim())) {
      throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
    }
    if (dto.type === 'COMPANY' && !dto.companyName?.trim()) {
      throw new BadRequestException('Företagsnamn krävs för företag')
    }

    const email = normalizeEmail(dto.email)

    // Dubblett-check innan transaktionen så användaren får ett tydligt fel
    // istället för en rå P2002 från Postgres.
    const duplicate = await this.prisma.tenant.findFirst({
      where: { organizationId, email },
      select: { id: true },
    })
    if (duplicate) {
      throw new BadRequestException(
        'En hyresgäst med denna e-postadress finns redan i organisationen',
      )
    }

    // Verifiera att enheten finns och tillhör samma organisation.
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.lease.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    let result: { tenant: Tenant; lease: Lease }
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            organizationId,
            type: dto.type,
            email,
            ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
            ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
            ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
            ...(dto.phone != null ? { phone: dto.phone } : {}),
            ...this.pn.protect(dto.personalNumber),
            ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
            ...(dto.street != null ? { street: dto.street } : {}),
            ...(dto.city != null ? { city: dto.city } : {}),
            ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
          },
        })

        const lease = await tx.lease.create({
          data: {
            organizationId,
            unitId: dto.lease.unitId,
            tenantId: tenant.id,
            startDate: new Date(dto.lease.startDate),
            // T1.3b: första avtalet → kontinuitetsmarkör = startDate.
            tenancyStartDate: new Date(dto.lease.startDate),
            ...(dto.lease.endDate != null ? { endDate: new Date(dto.lease.endDate) } : {}),
            monthlyRent: dto.lease.monthlyRent,
            depositAmount: dto.lease.depositAmount ?? 0,
            ...(dto.lease.specialTerms?.trim()
              ? { specialTerms: dto.lease.specialTerms.trim() }
              : {}),
            status: 'DRAFT',
          },
        })

        return { tenant, lease }
      })
    } catch (err) {
      // P2002 = unique constraint violation. Race-skydd för dubblett-check
      // ovan om två förfrågningar skapar samma e-post samtidigt.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta as { target?: unknown } | undefined)?.target
        if (Array.isArray(target) && target.includes('email')) {
          throw new BadRequestException(
            'En hyresgäst med denna e-postadress finns redan i organisationen',
          )
        }
        throw new BadRequestException('Konflikt vid skapande – försök igen')
      }
      throw err
    }

    // Tenant skapas utan portalkonto — välkomstmejl med aktiveringslänk
    // skickas först när det första kontraktet aktiveras (lease → ACTIVE).
    return mapTenant(result.tenant, this.pn.reveal(result.tenant.personalNumberEnc))
  }

  async update(id: string, dto: UpdateTenantDto, organizationId: string) {
    const existing = await this.prisma.tenant.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Hyresgästen hittades inte')

    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.email != null ? { email: normalizeEmail(dto.email) } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...this.pn.protect(dto.personalNumber),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
      },
    })
    return mapTenant(tenant, this.pn.reveal(tenant.personalNumberEnc))
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const existing = await this.prisma.tenant.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Hyresgästen hittades inte')

    // Blockera om hyresgästen har aktiva eller pågående kontrakt – dessa måste
    // avslutas via /v1/leases först.
    const blockingLeaseCount = await this.prisma.lease.count({
      where: { tenantId: id, status: { in: ['ACTIVE', 'DRAFT'] } },
    })
    if (blockingLeaseCount > 0) {
      throw new BadRequestException(
        'Hyresgästen har aktiva eller pågående kontrakt och kan inte tas bort.',
      )
    }

    const activeInvoiceCount = await this.prisma.invoice.count({
      where: { tenantId: id, status: { notIn: ['VOID', 'DRAFT'] } },
    })
    if (activeInvoiceCount > 0) {
      throw new BadRequestException('Hyresgästen har aktiva fakturor och kan inte tas bort.')
    }

    await this.prisma.tenant.delete({ where: { id } })
  }
}
