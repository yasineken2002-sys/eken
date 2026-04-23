import { Injectable, NotFoundException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import type { MaintenancePlanCategory, MaintenancePlanStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateMaintenancePlanDto } from './dto/create-maintenance-plan.dto'
import { UpdateMaintenancePlanDto } from './dto/update-maintenance-plan.dto'

const PROPERTY_SELECT = { id: true, name: true, street: true, city: true }

export interface YearSummary {
  year: number
  plans: Awaited<ReturnType<MaintenancePlanService['findAll']>>
  totalEstimated: number
  totalActual: number
  count: number
}

@Injectable()
export class MaintenancePlanService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    organizationId: string,
    filters?: {
      propertyId?: string
      year?: number
      status?: MaintenancePlanStatus
      category?: MaintenancePlanCategory
    },
  ) {
    return this.prisma.maintenancePlan.findMany({
      where: {
        organizationId,
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.year ? { plannedYear: filters.year } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.category ? { category: filters.category } : {}),
      },
      include: { property: { select: PROPERTY_SELECT } },
      orderBy: [{ plannedYear: 'asc' }, { priority: 'desc' }],
    })
  }

  async findOne(id: string, organizationId: string) {
    const plan = await this.prisma.maintenancePlan.findFirst({
      where: { id, organizationId },
      include: { property: { select: PROPERTY_SELECT } },
    })
    if (!plan) throw new NotFoundException('Underhållsplan hittades inte')
    return plan
  }

  async create(dto: CreateMaintenancePlanDto, organizationId: string) {
    const { estimatedCost, ...rest } = dto
    return this.prisma.maintenancePlan.create({
      data: {
        ...rest,
        organizationId,
        estimatedCost: new Decimal(estimatedCost),
      },
      include: { property: { select: PROPERTY_SELECT } },
    })
  }

  async update(id: string, dto: UpdateMaintenancePlanDto, organizationId: string) {
    const existing = await this.prisma.maintenancePlan.findFirst({
      where: { id, organizationId },
    })
    if (!existing) throw new NotFoundException('Underhållsplan hittades inte')

    const { estimatedCost, actualCost, completedAt, ...rest } = dto

    const autoComplete = dto.status === 'COMPLETED' && !existing.completedAt && !completedAt

    return this.prisma.maintenancePlan.update({
      where: { id },
      data: {
        ...rest,
        ...(estimatedCost !== undefined ? { estimatedCost: new Decimal(estimatedCost) } : {}),
        ...(actualCost !== undefined ? { actualCost: new Decimal(actualCost) } : {}),
        ...(completedAt ? { completedAt: new Date(completedAt) } : {}),
        ...(autoComplete ? { completedAt: new Date() } : {}),
      },
      include: { property: { select: PROPERTY_SELECT } },
    })
  }

  async delete(id: string, organizationId: string) {
    const existing = await this.prisma.maintenancePlan.findFirst({
      where: { id, organizationId },
    })
    if (!existing) throw new NotFoundException('Underhållsplan hittades inte')
    await this.prisma.maintenancePlan.delete({ where: { id } })
  }

  async getYearlySummary(
    organizationId: string,
    fromYear: number,
    toYear: number,
  ): Promise<YearSummary[]> {
    const plans = await this.prisma.maintenancePlan.findMany({
      where: {
        organizationId,
        plannedYear: { gte: fromYear, lte: toYear },
      },
      include: { property: { select: PROPERTY_SELECT } },
      orderBy: [{ plannedYear: 'asc' }, { priority: 'desc' }],
    })

    const byYear = new Map<number, YearSummary>()

    // Pre-fill all years in range
    for (let y = fromYear; y <= toYear; y++) {
      byYear.set(y, { year: y, plans: [], totalEstimated: 0, totalActual: 0, count: 0 })
    }

    for (const plan of plans) {
      const entry = byYear.get(plan.plannedYear)
      if (entry) {
        entry.plans.push(plan)
        entry.totalEstimated += Number(plan.estimatedCost)
        entry.totalActual += Number(plan.actualCost ?? 0)
        entry.count++
      }
    }

    return Array.from(byYear.values()).sort((a, b) => a.year - b.year)
  }

  async getTotalBudget(organizationId: string, fromYear: number, toYear: number) {
    const result = await this.prisma.maintenancePlan.groupBy({
      by: ['category'],
      where: { organizationId, plannedYear: { gte: fromYear, lte: toYear } },
      _sum: { estimatedCost: true },
      _count: { id: true },
    })

    const total = result.reduce((s, r) => s + Number(r._sum.estimatedCost ?? 0), 0)

    return {
      total,
      byCategory: result.map((r) => ({
        category: r.category,
        total: Number(r._sum.estimatedCost ?? 0),
        count: r._count.id,
      })),
    }
  }
}
