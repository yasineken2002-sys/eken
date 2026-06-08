import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { DocumentCategory } from '@prisma/client'
import { v4 as uuid } from 'uuid'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { MailService } from '../mail/mail.service'

/** Escape för text som infogas i HTML (notis-mejlets brödtext). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Tillåtna kategorier för portal-dokument. INVOICE är medvetet uteslutet —
 * portalen döljer den kategorin (getDocuments filtrerar bort INVOICE), så ett
 * dokument med den kategorin vore osynligt. Compile-time-grind mot felaktig
 * direktanvändning av primitiven.
 */
export type PortalDocumentCategory = Exclude<DocumentCategory, 'INVOICE'>

export interface DeliverDocumentToTenantInput {
  organizationId: string
  /** Måste vara en tenant inom organizationId — verifieras server-side här. */
  tenantId: string
  /** Filinnehållet (t.ex. en genererad PDF). */
  content: Buffer
  /** Filnamn för lagring (t.ex. "informationsbrev.pdf"). */
  fileName: string
  /** Visningsnamn på dokumentet i portalen. */
  name: string
  category?: PortalDocumentCategory
  mimeType?: string
  description?: string
  /** Skicka även en e-postnotis till hyresgästen ("nytt dokument i din portal"). */
  notify?: boolean
}

export interface DeliverDocumentResult {
  documentId: string
  tenantId: string
}

/**
 * Generisk primitiv: "lägg ett dokument i en hyresgästs portal".
 *
 * Laddar upp innehållet till R2 (StorageService) och skapar en Document-rad
 * med `tenantId` satt — det är `tenantId` som gör dokumentet synligt i
 * hyresgästportalen (`TenantPortalService.getDocuments` filtrerar strikt på
 * `where: { tenantId }`). Avsedd att återanvändas av AI-verktyget och alla
 * framtida vägar som behöver leverera ett dokument till en hyresgäst.
 *
 * SÄKERHET (egen grind, defense-in-depth): tenanten MÅSTE tillhöra
 * `organizationId`. Uppslagningen sker server-side och `tenantId` på
 * dokumentet härleds från den verifierade raden — aldrig direkt från
 * anroparens/AI:ns input. Det garanterar att ett dokument aldrig kan landa i
 * en portal i en annan organisation, oavsett vilken väg som anropar.
 */
@Injectable()
export class DocumentDeliveryService {
  private readonly logger = new Logger(DocumentDeliveryService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  async deliverToTenant(input: DeliverDocumentToTenantInput): Promise<DeliverDocumentResult> {
    const { organizationId, tenantId, content } = input

    // SÄKERHET: org-scoping. Tenanten måste finnas i anroparens organisation.
    // Annars kastas NotFound — inget laddas upp och inget dokument skapas.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
      select: {
        id: true,
        type: true,
        firstName: true,
        lastName: true,
        companyName: true,
        email: true,
      },
    })
    if (!tenant) {
      throw new NotFoundException(
        `Hyresgäst "${tenantId}" hittades inte i organisationen — dokumentet levererades inte.`,
      )
    }

    // INVOICE-kategorin döljs medvetet i portalen (getDocuments filtrerar bort
    // den). Att leverera ett portal-dokument med den kategorin vore en bugg —
    // coerca till OTHER så det faktiskt blir synligt.
    // Defense-in-depth utöver compile-time-typen: en anropare som kringgår
    // typen (as never) ska ändå aldrig kunna skapa ett INVOICE-dokument här.
    const category =
      !input.category || (input.category as DocumentCategory) === DocumentCategory.INVOICE
        ? DocumentCategory.OTHER
        : input.category

    const mimeType = input.mimeType ?? 'application/pdf'
    const storageKey = `documents/${organizationId}/${uuid()}_${input.fileName}`
    const storageUrl = await this.storage.uploadFile(content, storageKey, mimeType)

    const doc = await this.prisma.document.create({
      data: {
        organizationId,
        // tenantId härleds från den verifierade tenanten (server-side),
        // aldrig från rå input. Detta gör dokumentet portal-synligt för
        // EXAKT denna hyresgäst.
        tenantId: tenant.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        storageKey,
        storageUrl,
        fileSize: content.length,
        mimeType,
        category,
      },
    })

    if (input.notify) {
      // Best-effort: en misslyckad notis får aldrig blockera leveransen —
      // dokumentet ligger redan i portalen.
      await this.notifyTenant(organizationId, tenant, input.name, doc.id).catch((err) => {
        this.logger.warn(
          `Dokument ${doc.id} levererat men notis till hyresgäst ${tenant.id} misslyckades: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    }

    return { documentId: doc.id, tenantId: tenant.id }
  }

  private async notifyTenant(
    organizationId: string,
    tenant: {
      type: string
      firstName: string | null
      lastName: string | null
      companyName: string | null
      email: string
    },
    documentName: string,
    documentId: string,
  ): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    })
    const tenantName =
      tenant.type === 'INDIVIDUAL'
        ? `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
        : (tenant.companyName ?? '')

    // XSS-skydd: tenant-namn och dokumentnamn kommer ur DB (operatörssatt) och
    // infogas i mejlets HTML — escapa båda innan de renderas i en e-postklient.
    const safeTenantName = escapeHtml(tenantName)
    const safeDocName = escapeHtml(documentName)
    await this.mail.sendCustomEmail({
      to: tenant.email,
      subject: 'Nytt dokument i din hyresgästportal',
      tenantName,
      organizationName: org?.name ?? '',
      bodyHtml:
        `<p>Hej ${safeTenantName},</p>` +
        `<p>Ett nytt dokument har lagts till i din hyresgästportal:</p>` +
        `<p><strong>${safeDocName}</strong></p>` +
        `<p>Logga in på din portal för att läsa dokumentet.</p>`,
      idempotencyKey: `doc-portal-notify-${documentId}`,
    })
  }
}
