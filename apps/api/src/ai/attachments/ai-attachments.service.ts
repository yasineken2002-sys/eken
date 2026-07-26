import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { v4 as uuid } from 'uuid'
import * as path from 'path'
import { PrismaService } from '../../common/prisma/prisma.service'
import { StorageService } from '../../storage/storage.service'
import {
  validateUploadedFile,
  DETECTED_AI_CHAT_TYPES,
  MAX_AI_ATTACHMENT_BYTES,
  MAX_AI_IMAGE_BYTES,
} from '../../common/utils/file-validation'

/** Hur länge en oanvänd bilaga får ligga kvar innan cronen städar bort den. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Kvot per användare på bilagor som ligger och väntar (uppladdade men aldrig
 * skickade). Taket finns för att uppladdningsvägen inte ska gå att använda som
 * gratis fillagring: den som laddar upp utan att någonsin skicka stoppas efter
 * 10 filer, inte efter 10 000.
 */
export const MAX_PENDING_ATTACHMENTS_PER_USER = 10

/**
 * Kvot per konversation. Kan bara tillämpas när klienten VET vilket samtal
 * bilagan hör till — ett nytt samtal finns inte förrän första meddelandet
 * skickas, så `conversationId` är valfritt vid uppladdning. Användarkvoten
 * ovan är därför den som alltid gäller; den här är ett extra tak för långa
 * samtal.
 */
export const MAX_ATTACHMENTS_PER_CONVERSATION = 20

export type AttachmentKind = 'image' | 'document'

/**
 * Bild eller dokument HÄRLEDS ur den detekterade MIME-typen — det finns ingen
 * `kind`-kolumn som kan säga emot innehållet. B2 använder samma funktion när
 * den avgör om bilagan ska bli ett `image`- eller `document`-block.
 */
export function attachmentKind(mimeType: string): AttachmentKind {
  return mimeType.startsWith('image/') ? 'image' : 'document'
}

export interface UploadedAttachmentFile {
  buffer: Buffer
  filename: string
}

export interface AttachmentResponse {
  id: string
  kind: AttachmentKind
  filename: string
  mimeType: string
  sizeBytes: number
  expiresAt: Date
}

/**
 * SPÅR B1 — uppladdning av bilagor till AI-chatten.
 *
 * Den här tjänsten LAGRAR bara. Ingenting av det som laddas upp når Anthropic
 * i den här PR:n: chatten bygger fortfarande `content` som en sträng, så en
 * bilaga är i dag en rad i databasen och ett objekt i R2 och inget mer.
 * Multimodal input är B2.
 *
 * Anledningen till att uppladdningen är sin EGEN endpoint, i stället för ett
 * fält i chatt-anropet: SSE-vägen tar sitt meddelande som query-parameter, och
 * base64 får inte plats i en URL. Genom att ladda upp separat och skicka bara
 * id:n behöver strömtransporten aldrig byggas om till POST.
 */
@Injectable()
export class AiAttachmentsService {
  private readonly logger = new Logger(AiAttachmentsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    file: UploadedAttachmentFile,
    organizationId: string,
    userId: string,
    conversationId?: string,
  ): Promise<AttachmentResponse> {
    // SECURITY (H3): typen bestäms av filens FAKTISKA innehåll. Klientens
    // deklarerade Content-Type läses aldrig — den kan vara vad som helst, och
    // det är just den lögnen magic-byte-kontrollen finns för.
    const detected = validateUploadedFile(file.buffer, {
      allowedDetectedMimes: DETECTED_AI_CHAT_TYPES,
      maxBytes: MAX_AI_ATTACHMENT_BYTES,
    })
    // `allowTextWithoutSignature` är inte satt → validateUploadedFile kastar
    // hellre än att returnera null. Kontrollen finns för typens skull.
    if (detected === null) {
      throw new BadRequestException('Filinnehållet kunde inte verifieras')
    }

    const kind = attachmentKind(detected)
    if (kind === 'image' && file.buffer.length > MAX_AI_IMAGE_BYTES) {
      const mb = (MAX_AI_IMAGE_BYTES / 1024 / 1024).toFixed(0)
      throw new BadRequestException(`Bilden är för stor (max ${mb} MB)`)
    }

    // Kvoterna kollas FÖRE R2-uppladdningen: en avvisad fil ska inte hinna
    // lägga ett objekt i lagringen som ingen sedan städar.
    await this.assertWithinQuota(organizationId, userId, conversationId)

    // Org-scopa samtalet innan bilagan knyts till det — annars går det att
    // hänga en bilaga på en annan organisations konversation.
    if (conversationId) {
      const conversation = await this.prisma.aiConversation.findFirst({
        where: { id: conversationId, organizationId, userId },
        select: { id: true },
      })
      if (!conversation) {
        throw new NotFoundException('Konversationen hittades inte')
      }
    }

    const ext = path.extname(file.filename)
    const storageKey = `ai-chat/${organizationId}/${uuid()}${ext}`
    await this.storage.uploadFile(file.buffer, storageKey, detected)

    const attachment = await this.prisma.aiAttachment.create({
      data: {
        organizationId,
        userId,
        conversationId: conversationId ?? null,
        // Originalnamnet visas för användaren; sökvägsdelar kastas så att ett
        // filnamn aldrig kan läsas som en sökväg någon annanstans.
        filename: path.basename(file.filename),
        mimeType: detected,
        sizeBytes: file.buffer.length,
        storageKey,
        expiresAt: new Date(Date.now() + ATTACHMENT_TTL_MS),
      },
    })

    return {
      id: attachment.id,
      kind,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      expiresAt: attachment.expiresAt,
    }
  }

  /** Ta bort en bilaga som ännu inte skickats (B4:s "ta bort före sändning"). */
  async remove(id: string, organizationId: string, userId: string): Promise<void> {
    const attachment = await this.prisma.aiAttachment.findFirst({
      where: { id, organizationId, userId },
    })
    if (!attachment) {
      throw new NotFoundException('Bilagan hittades inte')
    }
    if (attachment.consumedAt) {
      // En bilaga som redan skickats till modellen ingår i samtalets historik.
      // Att radera den ur lagringen skulle göra historiken oläsbar i efterhand.
      throw new BadRequestException('Bilagan är redan skickad och kan inte tas bort')
    }

    await this.storage.deleteFile(attachment.storageKey)
    await this.prisma.aiAttachment.delete({ where: { id: attachment.id } })
  }

  private async assertWithinQuota(
    organizationId: string,
    userId: string,
    conversationId?: string,
  ): Promise<void> {
    const pending = await this.prisma.aiAttachment.count({
      where: { organizationId, userId, consumedAt: null, expiresAt: { gt: new Date() } },
    })
    if (pending >= MAX_PENDING_ATTACHMENTS_PER_USER) {
      throw new BadRequestException(
        `Du har ${pending} bilagor som väntar på att skickas (max ${MAX_PENDING_ATTACHMENTS_PER_USER}). ` +
          'Skicka eller ta bort några först.',
      )
    }

    if (!conversationId) return

    const inConversation = await this.prisma.aiAttachment.count({
      where: { organizationId, conversationId },
    })
    if (inConversation >= MAX_ATTACHMENTS_PER_CONVERSATION) {
      throw new BadRequestException(
        `Konversationen har redan ${inConversation} bilagor (max ${MAX_ATTACHMENTS_PER_CONVERSATION}).`,
      )
    }
  }

  /**
   * Städar bilagor som laddades upp men aldrig skickades. Utan den här cronen
   * vore uppladdnings-endpointen en lagringssänka som bara växer: varje
   * påbörjat men avbrutet meddelande hade lämnat en fil i R2 för alltid.
   *
   * KONSUMERADE bilagor rörs INTE — de ingår i ett samtals historik, och hur
   * länge den historiken ska leva är en egen fråga (B3).
   */
  @Cron('0 4 * * *')
  async cleanupExpiredAttachments(): Promise<void> {
    const expired = await this.prisma.aiAttachment.findMany({
      where: { consumedAt: null, expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
      take: 500,
    })
    if (expired.length === 0) return

    let removed = 0
    for (const attachment of expired) {
      try {
        await this.storage.deleteFile(attachment.storageKey)
        await this.prisma.aiAttachment.delete({ where: { id: attachment.id } })
        removed++
      } catch (error) {
        // En enskild R2-miss får inte stoppa resten av städningen. Raden ligger
        // kvar och plockas upp i nästa körning.
        this.logger.error(
          `Kunde inte städa bilaga ${attachment.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    this.logger.log(`Städade ${removed} av ${expired.length} utgångna AI-bilagor`)
  }
}
