import { Injectable, NotFoundException } from '@nestjs/common'
import { PropertiesService } from '../../properties/properties.service'
import { PrismaService } from '../../common/prisma/prisma.service'
import type { CreatePropertyInput } from '@eken/shared'

@Injectable()
export class PlatformPropertiesService {
  constructor(
    private readonly properties: PropertiesService,
    private readonly prisma: PrismaService,
  ) {}

  async listForOrganization(organizationId: string) {
    await this.ensureOrg(organizationId)
    return this.properties.findAll(organizationId)
  }

  async createForOrganization(organizationId: string, dto: CreatePropertyInput) {
    await this.ensureOrg(organizationId)
    return this.properties.create(organizationId, dto)
  }

  private async ensureOrg(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
  }
}
