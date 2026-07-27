import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { normalizeEmail } from '../common/utils/normalize-email'
import { CreateCustomerDto } from './dto/create-customer.dto'
import { UpdateCustomerDto } from './dto/update-customer.dto'

/** Personnummer-kolumnerna får aldrig serialiseras — se mapCustomer. */
const CUSTOMER_PN_KEYS = ['personalNumberEnc', 'personalNumberHash'] as const

type CustomerPnKey = (typeof CUSTOMER_PN_KEYS)[number]

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pn: PersonalNumberService,
  ) {}

  /**
   * Byter ut chiffertext + blind-index mot klartext-personnumret i svaret.
   * Enda stället kunder dekrypteras för operatörs-API:t; alla läsvägar nedan
   * går igenom den här.
   */
  private mapCustomer<T extends { personalNumberEnc: string | null }>(
    customer: T,
  ): Omit<T, CustomerPnKey> & { personalNumber: string | null } {
    const rest = { ...customer } as Record<string, unknown>
    const personalNumber = this.pn.reveal(customer.personalNumberEnc)
    for (const key of CUSTOMER_PN_KEYS) delete rest[key]
    return { ...rest, personalNumber } as Omit<T, CustomerPnKey> & { personalNumber: string | null }
  }

  async findAll(
    organizationId: string,
    filters?: { search?: string; type?: 'INDIVIDUAL' | 'COMPANY'; isActive?: boolean },
  ) {
    const where: Prisma.CustomerWhereInput = {
      organizationId,
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.isActive != null ? { isActive: filters.isActive } : {}),
      ...(filters?.search
        ? {
            OR: [
              { firstName: { contains: filters.search, mode: 'insensitive' } },
              { lastName: { contains: filters.search, mode: 'insensitive' } },
              { companyName: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              { orgNumber: { contains: filters.search } },
            ],
          }
        : {}),
    }

    const customers = await this.prisma.customer.findMany({
      where,
      include: {
        _count: { select: { invoices: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return customers.map((c) => this.mapCustomer(c))
  }

  async findOne(id: string, organizationId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { lines: true },
        },
        _count: { select: { invoices: true } },
      },
    })
    if (!customer) throw new NotFoundException('Kunden hittades inte')
    return this.mapCustomer(customer)
  }

  async create(dto: CreateCustomerDto, organizationId: string) {
    if (dto.type === 'INDIVIDUAL' && (!dto.firstName?.trim() || !dto.lastName?.trim())) {
      throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
    }
    if (dto.type === 'COMPANY' && !dto.companyName?.trim()) {
      throw new BadRequestException('Företagsnamn krävs för företag')
    }

    const created = await this.prisma.customer.create({
      data: {
        organizationId,
        type: dto.type,
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...this.pn.protect(dto.personalNumber),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.contactPerson != null ? { contactPerson: dto.contactPerson } : {}),
        ...(dto.email != null ? { email: normalizeEmail(dto.email) } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
        ...(dto.country != null ? { country: dto.country } : {}),
        ...(dto.reference != null ? { reference: dto.reference } : {}),
        ...(dto.notes != null ? { notes: dto.notes } : {}),
      },
    })
    return this.mapCustomer(created)
  }

  async update(id: string, dto: UpdateCustomerDto, organizationId: string) {
    const existing = await this.prisma.customer.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Kunden hittades inte')

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...this.pn.protect(dto.personalNumber),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.contactPerson != null ? { contactPerson: dto.contactPerson } : {}),
        ...(dto.email != null ? { email: normalizeEmail(dto.email) } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
        ...(dto.country != null ? { country: dto.country } : {}),
        ...(dto.reference != null ? { reference: dto.reference } : {}),
        ...(dto.notes != null ? { notes: dto.notes } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
      },
    })
    return this.mapCustomer(updated)
  }

  /**
   * Soft delete: sätter isActive=false. Behåller historik så fakturor som
   * pekar på kunden förblir intakta. Faktiska radering sker bara om kunden
   * saknar fakturor helt.
   */
  async remove(id: string, organizationId: string): Promise<{ archived: boolean }> {
    const existing = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      include: { _count: { select: { invoices: true } } },
    })
    if (!existing) throw new NotFoundException('Kunden hittades inte')

    if (existing._count.invoices === 0) {
      await this.prisma.customer.delete({ where: { id } })
      return { archived: false }
    }

    await this.prisma.customer.update({
      where: { id },
      data: { isActive: false },
    })
    return { archived: true }
  }
}
