import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import type { CreateFrontendErrorDto } from './dto/error-log.dto'

type Severity = 'CRITICAL' | 'ERROR' | 'WARNING'
type Source = 'API' | 'WEB' | 'PORTAL' | 'ADMIN'

@Injectable()
export class PlatformErrorsService {
  constructor(private prisma: PrismaService) {}

  async logInternalError(params: {
    severity: Severity
    source: Source
    message: string
    stack?: string
    context?: Record<string, unknown>
    organizationId?: string
  }) {
    try {
      await this.prisma.errorLog.create({
        data: {
          severity: params.severity,
          source: params.source,
          message: params.message,
          ...(params.stack ? { stack: params.stack } : {}),
          context: (params.context ?? {}) as object,
          ...(params.organizationId ? { organizationId: params.organizationId } : {}),
        },
      })
    } catch (err) {
      // Om ErrorLog själv failar (t.ex. DB nere) — skriv till stderr och gå vidare.
      console.error('[PlatformErrorsService] Kunde inte skriva till ErrorLog:', err)
    }
  }

  async logFrontendError(dto: CreateFrontendErrorDto) {
    return this.logInternalError({
      severity: dto.severity,
      source: dto.source,
      message: dto.message,
      ...(dto.stack ? { stack: dto.stack } : {}),
      ...(dto.context ? { context: dto.context } : {}),
      ...(dto.organizationId ? { organizationId: dto.organizationId } : {}),
    })
  }

  async list(params: {
    severity?: Severity
    source?: Source
    resolved?: boolean
    organizationId?: string
    page?: number
    pageSize?: number
  }) {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
    const skip = (page - 1) * pageSize

    const where: Record<string, unknown> = {}
    if (params.severity) where['severity'] = params.severity
    if (params.source) where['source'] = params.source
    if (params.resolved !== undefined) where['resolved'] = params.resolved
    if (params.organizationId) where['organizationId'] = params.organizationId

    const [total, rows] = await Promise.all([
      this.prisma.errorLog.count({ where }),
      this.prisma.errorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          organization: { select: { id: true, name: true } },
        },
      }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => ({
        id: r.id,
        organization: r.organization,
        severity: r.severity,
        source: r.source,
        message: r.message,
        stack: r.stack,
        context: r.context,
        resolved: r.resolved,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    }
  }

  async resolve(id: string) {
    const existing = await this.prisma.errorLog.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Fel-loggen hittades inte')
    return this.prisma.errorLog.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    })
  }

  async summary() {
    const [critical, error, warning, unresolvedCritical] = await Promise.all([
      this.prisma.errorLog.count({ where: { severity: 'CRITICAL' } }),
      this.prisma.errorLog.count({ where: { severity: 'ERROR' } }),
      this.prisma.errorLog.count({ where: { severity: 'WARNING' } }),
      this.prisma.errorLog.count({ where: { severity: 'CRITICAL', resolved: false } }),
    ])
    return {
      total: { CRITICAL: critical, ERROR: error, WARNING: warning },
      unresolvedCritical,
    }
  }
}
