import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import type { CreatePlatformInvoiceDto } from './dto/platform-invoice.dto'

type PlatformInvoiceStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'

@Injectable()
export class PlatformInvoicesService {
  constructor(private prisma: PrismaService) {}

  async list(params: {
    status?: PlatformInvoiceStatus
    organizationId?: string
    page?: number
    pageSize?: number
  }) {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
    const skip = (page - 1) * pageSize

    const where: Record<string, unknown> = {}
    if (params.status) where['status'] = params.status
    if (params.organizationId) where['organizationId'] = params.organizationId

    const [total, rows] = await Promise.all([
      this.prisma.platformInvoice.count({ where }),
      this.prisma.platformInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          organization: { select: { id: true, name: true, email: true } },
        },
      }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => this.map(r)),
    }
  }

  async create(dto: CreatePlatformInvoiceDto) {
    const org = await this.prisma.organization.findUnique({ where: { id: dto.organizationId } })
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    const invoiceNumber = dto.invoiceNumber ?? (await this.generateInvoiceNumber())

    const row = await this.prisma.platformInvoice.create({
      data: {
        organizationId: dto.organizationId,
        invoiceNumber,
        amount: dto.amount,
        dueDate: new Date(dto.dueDate),
        ...(dto.description ? { description: dto.description } : {}),
      },
      include: { organization: { select: { id: true, name: true, email: true } } },
    })
    return this.map(row)
  }

  async updateStatus(id: string, status: PlatformInvoiceStatus) {
    const existing = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Fakturan hittades inte')

    const data: Record<string, unknown> = { status }
    if (status === 'PAID') data['paidAt'] = new Date()
    else if (existing.status === 'PAID') data['paidAt'] = null

    const row = await this.prisma.platformInvoice.update({
      where: { id },
      data,
      include: { organization: { select: { id: true, name: true, email: true } } },
    })
    return this.map(row)
  }

  private async generateInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear()
    const count = await this.prisma.platformInvoice.count({
      where: { invoiceNumber: { startsWith: `PLT-${year}-` } },
    })
    return `PLT-${year}-${String(count + 1).padStart(5, '0')}`
  }

  private map(r: {
    id: string
    organizationId: string
    invoiceNumber: string
    amount: unknown
    status: PlatformInvoiceStatus
    description: string | null
    dueDate: Date
    paidAt: Date | null
    createdAt: Date
    updatedAt: Date
    organization: { id: string; name: string; email: string }
  }) {
    return {
      id: r.id,
      organizationId: r.organizationId,
      organization: r.organization,
      invoiceNumber: r.invoiceNumber,
      amount: Number(r.amount),
      status: r.status,
      description: r.description,
      dueDate: r.dueDate.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }
  }
}
