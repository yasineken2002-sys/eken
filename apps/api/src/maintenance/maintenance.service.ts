import { Injectable, NotFoundException } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { CreateMaintenanceTicketDto } from './dto/create-maintenance-ticket.dto'
import type { UpdateMaintenanceTicketDto } from './dto/update-maintenance-ticket.dto'
import type { MaintenanceStatus, MaintenancePriority, MaintenanceCategory } from '@prisma/client'

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async generateTicketNumber(organizationId: string): Promise<string> {
    const count = await this.prisma.maintenanceTicket.count({ where: { organizationId } })
    return `UND-${(count + 1).toString().padStart(5, '0')}`
  }

  async findAll(
    organizationId: string,
    filters?: {
      status?: MaintenanceStatus
      priority?: MaintenancePriority
      category?: MaintenanceCategory
      propertyId?: string
      unitId?: string
    },
  ) {
    return this.prisma.maintenanceTicket.findMany({
      where: {
        organizationId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.priority ? { priority: filters.priority } : {}),
        ...(filters?.category ? { category: filters.category } : {}),
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
      },
      include: {
        property: { select: { id: true, name: true, city: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        tenant: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            type: true,
            email: true,
          },
        },
        images: true,
        comments: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    })
  }

  async findOne(id: string, organizationId: string) {
    const ticket = await this.prisma.maintenanceTicket.findFirst({
      where: { id, organizationId },
      include: {
        property: { select: { id: true, name: true, city: true, street: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        tenant: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            type: true,
            email: true,
            phone: true,
          },
        },
        images: true,
        comments: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!ticket) throw new NotFoundException('Underhållsärende hittades inte')
    return ticket
  }

  async create(dto: CreateMaintenanceTicketDto, organizationId: string, userId: string) {
    const ticketNumber = await this.generateTicketNumber(organizationId)
    const tenantToken = crypto.randomUUID()

    const ticket = await this.prisma.maintenanceTicket.create({
      data: {
        ticketNumber,
        organizationId,
        propertyId: dto.propertyId,
        ...(dto.unitId ? { unitId: dto.unitId } : {}),
        ...(dto.tenantId ? { tenantId: dto.tenantId } : {}),
        ...(userId ? { reportedById: userId } : {}),
        title: dto.title,
        description: dto.description,
        category: dto.category ?? 'OTHER',
        priority: dto.priority ?? 'NORMAL',
        ...(dto.scheduledDate ? { scheduledDate: new Date(dto.scheduledDate) } : {}),
        ...(dto.estimatedCost != null ? { estimatedCost: dto.estimatedCost } : {}),
        tenantToken,
      },
      include: {
        property: { select: { id: true, name: true, city: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        tenant: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            type: true,
            email: true,
          },
        },
        images: true,
        comments: true,
      },
    })

    void this.notificationsService
      .createForAllOrgUsers(
        organizationId,
        'MAINTENANCE_NEW',
        'Nytt underhållsärende',
        `Ärende ${ticket.ticketNumber}: ${dto.title}`,
        '/maintenance',
      )
      .catch((err) => console.error('[maintenance] notification error', String(err)))

    return ticket
  }

  async update(id: string, dto: UpdateMaintenanceTicketDto, organizationId: string) {
    await this.findOne(id, organizationId)

    const completedAt = dto.status === 'COMPLETED' ? new Date() : undefined

    const result = await this.prisma.maintenanceTicket.update({
      where: { id },
      data: {
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.description ? { description: dto.description } : {}),
        ...(dto.unitId !== undefined ? { unitId: dto.unitId } : {}),
        ...(dto.tenantId !== undefined ? { tenantId: dto.tenantId } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(dto.scheduledDate ? { scheduledDate: new Date(dto.scheduledDate) } : {}),
        ...(dto.estimatedCost != null ? { estimatedCost: dto.estimatedCost } : {}),
        ...(dto.actualCost != null ? { actualCost: dto.actualCost } : {}),
        ...(dto.tenantNotified != null ? { tenantNotified: dto.tenantNotified } : {}),
      },
      include: {
        property: { select: { id: true, name: true, city: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        tenant: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            type: true,
            email: true,
          },
        },
        images: true,
        comments: { orderBy: { createdAt: 'asc' } },
      },
    })

    if (dto.status === 'COMPLETED') {
      void this.notificationsService
        .createForAllOrgUsers(
          organizationId,
          'MAINTENANCE_UPDATED',
          'Underhållsärende slutfört',
          `Ärende ${result.ticketNumber} har markerats som åtgärdat`,
          '/maintenance',
        )
        .catch((err) => console.error('[maintenance] notification error', String(err)))
    }

    return result
  }

  async addComment(
    ticketId: string,
    content: string,
    isInternal: boolean,
    organizationId: string,
    userId?: string,
  ) {
    await this.findOne(ticketId, organizationId)
    await this.prisma.maintenanceComment.create({
      data: { ticketId, content, isInternal, ...(userId ? { userId } : {}) },
    })
    return this.findOne(ticketId, organizationId)
  }

  async deleteTicket(id: string, organizationId: string) {
    await this.findOne(id, organizationId)
    await this.prisma.maintenanceTicket.delete({ where: { id } })
  }

  async getStats(organizationId: string) {
    const [total, byStatus, byPriority, byCategory, urgentCount, openCostsResult] =
      await Promise.all([
        this.prisma.maintenanceTicket.count({ where: { organizationId } }),
        this.prisma.maintenanceTicket.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: { id: true },
        }),
        this.prisma.maintenanceTicket.groupBy({
          by: ['priority'],
          where: { organizationId },
          _count: { id: true },
        }),
        this.prisma.maintenanceTicket.groupBy({
          by: ['category'],
          where: { organizationId },
          _count: { id: true },
        }),
        this.prisma.maintenanceTicket.count({
          where: {
            organizationId,
            priority: 'URGENT',
            status: { notIn: ['COMPLETED', 'CLOSED', 'CANCELLED'] },
          },
        }),
        this.prisma.maintenanceTicket.aggregate({
          where: {
            organizationId,
            status: { notIn: ['COMPLETED', 'CLOSED', 'CANCELLED'] },
          },
          _sum: { estimatedCost: true },
        }),
      ])

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count.id])),
      byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r._count.id])),
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r._count.id])),
      urgent: urgentCount,
      openCosts: Number(openCostsResult._sum.estimatedCost ?? 0),
    }
  }

  async findByTenantToken(token: string) {
    return this.prisma.maintenanceTicket.findUnique({
      where: { tenantToken: token },
      include: {
        property: { select: { id: true, name: true, city: true, street: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        comments: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
  }

  async addTenantComment(token: string, content: string) {
    const ticket = await this.prisma.maintenanceTicket.findUnique({ where: { tenantToken: token } })
    if (!ticket) throw new NotFoundException('Ärende hittades inte')
    await this.prisma.maintenanceComment.create({
      data: { ticketId: ticket.id, content, isInternal: false },
    })
    return this.findByTenantToken(token)
  }
}
