import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { NotificationsService } from '../notifications/notifications.service'
import { StorageService } from '../storage/storage.service'
import {
  validateUploadedFile,
  extensionForDetectedMime,
  DETECTED_TICKET_IMAGE_TYPES,
  MAX_TICKET_IMAGE_BYTES,
} from '../common/utils/file-validation'
import { CreateMaintenanceTicketDto } from './dto/create-maintenance-ticket.dto'
import { UpdateMaintenanceTicketDto } from './dto/update-maintenance-ticket.dto'
import type { MaintenanceStatus, MaintenancePriority, MaintenanceCategory } from '@prisma/client'

/**
 * Filuppladdning till maintenance. Controllern måste själv konsumera
 * varje del från `req.parts()` eftersom @fastify/multipart bara håller
 * stream:en levande inuti iterator-steget — annars dör `toBuffer()` med
 * "Cannot read properties of undefined (reading 'Symbol.asyncIterator')".
 */
interface UploadedImage {
  filename: string
  mimetype: string
  buffer: Buffer
}

const MAX_IMAGES_PER_TICKET = 10

export interface MaintenanceImageRecord {
  id: string
  ticketId: string
  filename: string
  storageKey: string
  storageUrl: string
  size: number
  createdAt: Date
}

interface TicketWithImages {
  images?: MaintenanceImageRecord[]
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * R2 presigned URLs har kort TTL (1h). Lagra-och-läs ger stale URLs som
   * inte funkar i admin-vyn. Generera färska URLs varje gång vi serverar
   * en ticket — samma mönster som OrganizationsService.findMyOrganization
   * gör för logoStorageUrl.
   */
  private async refreshImageUrls<T extends TicketWithImages | null>(ticket: T): Promise<T> {
    if (!ticket?.images?.length) return ticket
    const refreshed = await Promise.all(
      ticket.images.map(async (img) => {
        try {
          return { ...img, storageUrl: await this.storage.getPresignedUrl(img.storageKey) }
        } catch (err) {
          this.logger.warn(
            `Kunde inte signera URL för bild ${img.id} (${img.storageKey}): ${String(err)}`,
          )
          return img
        }
      }),
    )
    return { ...ticket, images: refreshed }
  }

  // UPSERT med atomär increment — Postgres låser raden så samtidiga skapanden
  // av tickets aldrig kan dela ut samma nummer. Tidigare COUNT+1-mönstret
  // hade en race där två parallella requests fick samma värde.
  private async generateTicketNumber(organizationId: string): Promise<string> {
    const row = await this.prisma.maintenanceTicketSequence.upsert({
      where: { organizationId },
      create: { organizationId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
    return `UND-${row.lastNumber.toString().padStart(5, '0')}`
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
    const tickets = await this.prisma.maintenanceTicket.findMany({
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
    return Promise.all(tickets.map((t) => this.refreshImageUrls(t)))
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

    // Härled aktivt avtal för enheten (teknisk förvaltning, Spår A PR 4): frontend
    // behöver leaseId för "Debitera hyresgäst & bokför" — MaintenanceTicket har
    // unitId/tenantId men inget eget leaseId. chargeId följer redan med (skalär via
    // include) så knappen vet om ärendet redan debiterats. Org-scopat, ingen JOIN.
    const leaseId = ticket.unitId
      ? ((
          await this.prisma.lease.findFirst({
            where: { unitId: ticket.unitId, organizationId, status: 'ACTIVE' },
            orderBy: { startDate: 'desc' },
            select: { id: true },
          })
        )?.id ?? null)
      : null

    const withImages = await this.refreshImageUrls(ticket)
    return { ...withImages, leaseId }
  }

  // IDOR-spärr: varje klient-skickat relations-id måste tillhöra anropande org
  // INNAN det skrivs. Annars kan org A koppla sitt ärende till org B:s enhet/
  // hyresgäst → svaret (include → tenant-PII) läcker offrets data + korrumperar
  // kopplingen. Validerar bara icke-tomma id:n (null = medveten avkoppling).
  // (Launch-readiness #5/#19-klassen.)
  private async assertRelationsInOrg(
    organizationId: string,
    ids: {
      propertyId?: string | null | undefined
      unitId?: string | null | undefined
      tenantId?: string | null | undefined
    },
  ): Promise<void> {
    if (ids.propertyId) {
      const p = await this.prisma.property.findFirst({
        where: { id: ids.propertyId, organizationId },
        select: { id: true },
      })
      if (!p) throw new NotFoundException('Fastigheten hittades inte')
    }
    if (ids.unitId) {
      const u = await this.prisma.unit.findFirst({
        where: { id: ids.unitId, property: { organizationId } },
        select: { id: true },
      })
      if (!u) throw new NotFoundException('Enheten hittades inte')
    }
    if (ids.tenantId) {
      const t = await this.prisma.tenant.findFirst({
        where: { id: ids.tenantId, organizationId },
        select: { id: true },
      })
      if (!t) throw new NotFoundException('Hyresgästen hittades inte')
    }
  }

  async create(dto: CreateMaintenanceTicketDto, organizationId: string, userId: string) {
    await this.assertRelationsInOrg(organizationId, {
      propertyId: dto.propertyId,
      unitId: dto.unitId,
      tenantId: dto.tenantId,
    })
    const ticketNumber = await this.generateTicketNumber(organizationId)

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
        { relatedEntityType: 'MAINTENANCE_TICKET', relatedEntityId: ticket.id },
      )
      .catch((err) =>
        this.logger.error('Notification error', err instanceof Error ? err.stack : String(err)),
      )

    return ticket
  }

  async update(id: string, dto: UpdateMaintenanceTicketDto, organizationId: string) {
    await this.findOne(id, organizationId)
    await this.assertRelationsInOrg(organizationId, {
      unitId: dto.unitId,
      tenantId: dto.tenantId,
    })

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
          { relatedEntityType: 'MAINTENANCE_TICKET', relatedEntityId: result.id },
        )
        .catch((err) =>
          this.logger.error('Notification error', err instanceof Error ? err.stack : String(err)),
        )
    }

    return this.refreshImageUrls(result)
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

  /**
   * Ladda upp bilder till en felanmälan.
   *
   * ENDA anroparen i dag är `TenantPortalController` — alltså en HYRESGÄST, den
   * enda uppladdaren i systemet som inte är anställd hos kunden. Operatörens
   * maintenance-controller har ingen bild-route (bilder kommer in med
   * felanmälan från portalen). Det gör den här funktionen till systemets mest
   * exponerade uppladdningsväg, och skälet till att valideringen nedan är
   * strikt.
   *
   * Validerar MAGISKA BYTEN (inte klientens mimetype) + storlek, laddar till
   * R2 och sparar storageKey + initial presigned URL. URL:en regenereras vid
   * varje read i refreshImageUrls.
   */
  async addImages(ticketId: string, files: UploadedImage[]) {
    if (!files.length) throw new BadRequestException('Inga bilder bifogade')

    const existingCount = await this.prisma.maintenanceImage.count({ where: { ticketId } })
    if (existingCount + files.length > MAX_IMAGES_PER_TICKET) {
      throw new BadRequestException(
        `Max ${MAX_IMAGES_PER_TICKET} bilder per ärende (har redan ${existingCount})`,
      )
    }

    // SECURITY (H3): typen avgörs av filens FAKTISKA innehåll, aldrig av
    // `file.mimetype`. Den här vägen delas av operatörens felanmälan OCH
    // hyresgästportalen — portalen är den enda uppladdningsvägen i systemet där
    // uppladdaren inte är en anställd, och den satte tidigare bara sin egen
    // Content-Type-header. En omdöpt .html/.svg gick rakt igenom.
    //
    // ALLA filer valideras FÖRE den första laddas upp. Validerade vi inne i
    // loopen hade en avvisad fil sist i satsen lämnat de tidigare kvar i
    // lagringen, utan rader som pekar på dem — alltså skräp ingen städning
    // hittar.
    const detectedMimes = files.map((file) =>
      validateUploadedFile(file.buffer, {
        allowedDetectedMimes: DETECTED_TICKET_IMAGE_TYPES,
        maxBytes: MAX_TICKET_IMAGE_BYTES,
      }),
    )

    const created: MaintenanceImageRecord[] = []
    for (const [index, file] of files.entries()) {
      const buffer = file.buffer
      const detected = detectedMimes[index] ?? 'image/jpeg'

      // Nyckeln följer den VALIDERADE typen, inte klientens filnamn — annars
      // får en fil som heter "bild.exe" en .exe-nyckel i lagringen.
      const storageKey = `maintenance/${ticketId}/${crypto.randomUUID()}.${extensionForDetectedMime(detected)}`
      // Content-Type i lagringen sätts också till den detekterade typen: det är
      // den som gäller när objektet senare läses ut via presignerad URL.
      const storageUrl = await this.storage.uploadFile(buffer, storageKey, detected)

      const row = await this.prisma.maintenanceImage.create({
        data: {
          ticketId,
          filename: file.filename,
          storageKey,
          storageUrl,
          size: buffer.length,
        },
      })
      created.push(row)
    }
    return created
  }
}
