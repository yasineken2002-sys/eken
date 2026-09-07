import { Injectable, NotFoundException } from '@nestjs/common'
import type { Contractor, MaintenanceCategory, Prisma } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import { CreateContractorDto, UpdateContractorDto } from './dto/contractor.dto'

/**
 * HANTVERKARREGISTRET.
 *
 * Allt är org-scopat på samma sätt som resten av kodbasen: `organizationId`
 * kommer ur JWT via `@OrgId()` och läggs i varje `where`. Ett id från klienten
 * slår aldrig upp något utan den avgränsningen — annars hade en hantverkare i
 * en annan organisation gått att läsa och ändra genom att gissa ett uuid.
 */
@Injectable()
export class ContractorsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    organizationId: string,
    filter: { category?: MaintenanceCategory; activeOnly?: boolean } = {},
  ): Promise<Contractor[]> {
    const where: Prisma.ContractorWhereInput = { organizationId }
    // `has` på en enum-array: hantverkare som BÄR kategorin. En hantverkare utan
    // kategorier matchar då inget filter — det är rätt, och det är också varför
    // webbens väljare visar "alla" som eget val.
    if (filter.category) where.categories = { has: filter.category }
    if (filter.activeOnly) where.isActive = true
    return this.prisma.contractor.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    })
  }

  async findOne(id: string, organizationId: string): Promise<Contractor> {
    const contractor = await this.prisma.contractor.findFirst({ where: { id, organizationId } })
    if (!contractor) throw new NotFoundException('Hantverkaren hittades inte')
    return contractor
  }

  async create(
    dto: CreateContractorDto,
    organizationId: string,
    createdById: string,
  ): Promise<Contractor> {
    return this.prisma.contractor.create({
      data: {
        organizationId,
        createdById,
        name: dto.name,
        ...(dto.contactPerson ? { contactPerson: dto.contactPerson } : {}),
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.phone ? { phone: dto.phone } : {}),
        ...(dto.orgNumber ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.categories ? { categories: dto.categories } : {}),
        ...(dto.notes ? { notes: dto.notes } : {}),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      },
    })
  }

  async update(id: string, dto: UpdateContractorDto, organizationId: string): Promise<Contractor> {
    await this.findOne(id, organizationId)
    return this.prisma.contractor.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.contactPerson === undefined ? {} : { contactPerson: dto.contactPerson }),
        ...(dto.email === undefined ? {} : { email: dto.email }),
        ...(dto.phone === undefined ? {} : { phone: dto.phone }),
        ...(dto.orgNumber === undefined ? {} : { orgNumber: dto.orgNumber }),
        ...(dto.categories === undefined ? {} : { categories: dto.categories }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      },
    })
  }

  /**
   * HÅRD RADERING — och det är GDPR-steget.
   *
   * `isActive = false` är det mjuka steget och betyder "anlitas inte längre":
   * raden finns kvar så att gamla ärenden kan visa vem som utförde arbetet.
   * Det räcker inte som radering: för en enskild firma ÄR `name`, `email` och
   * `phone` personuppgifter, och en begäran om radering ska kunna verkställas.
   *
   * Ärendets FK är `SetNull`, så ärendena överlever med tilldelningen tömd.
   * Det är avsiktligt: att kaskadradera hade tagit bort felanmälningar — alltså
   * hyresgästens historik — därför att en hantverkare bad om att bli struken.
   */
  async remove(id: string, organizationId: string): Promise<{ id: string; ärendenTömda: number }> {
    await this.findOne(id, organizationId)
    const ärendenTömda = await this.prisma.maintenanceTicket.count({
      where: { assignedContractorId: id, organizationId },
    })
    await this.prisma.contractor.delete({ where: { id } })
    return { id, ärendenTömda }
  }
}
