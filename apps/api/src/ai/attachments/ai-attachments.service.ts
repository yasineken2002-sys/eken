import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { v4 as uuid } from 'uuid'
import * as path from 'path'
import type Anthropic from '@anthropic-ai/sdk'
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

/**
 * Tak på hur många MB bilagor som får läsas tillbaka ur R2 när en HISTORIK
 * rehydreras. Ett långt samtal kan bära 20 bilagor (konversationskvoten), och
 * utan tak hade varje ny fråga i det samtalet dragit ner alla 20 igen och
 * spräckt både Anthropics request-tak och tålamodet.
 *
 * Nyaste bilagor först — de äldsta faller bort till en textnotis så modellen
 * VET att något inte längre är bifogat i stället för att tro att det aldrig
 * fanns. Ett riktigt tak mot Anthropics 32 MB, med sidräkning, hör till B3.
 */
export const MAX_REHYDRATE_BYTES = 12 * 1024 * 1024

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
 * Det som PERSISTERAS i `AiMessage.blocks` för en bilaga — en REFERENS, aldrig
 * bytes.
 *
 * Att spara det färdiga Anthropic-blocket hade betytt base64 i en JSONB-kolumn:
 * en 20 MB PDF blir ~27 MB text, per meddelande, för alltid. Referensen är
 * några hundra byte, och innehållet hämtas ur R2 när historiken rehydreras
 * (`rehydrateHistoryBlocks`). Blocktypen är medvetet Eveno-egen så att en
 * oöversatt referens blir ett TYDLIGT fel mot Anthropics API i stället för att
 * tyst skickas vidare.
 */
export const ATTACHMENT_REF_BLOCK = 'eveno_attachment_ref' as const

export interface AttachmentRefBlock {
  type: typeof ATTACHMENT_REF_BLOCK
  attachmentId: string
  kind: AttachmentKind
  filename: string
  mimeType: string
}

export function isAttachmentRefBlock(block: unknown): block is AttachmentRefBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === ATTACHMENT_REF_BLOCK
  )
}

/**
 * SPÅR B — bilagor till AI-chatten.
 *
 * B1 lade uppladdningen (`upload`/`remove` + städning). B2 lade vägen in till
 * modellen: `buildContentBlocks` gör id:n till Anthropic-innehållsblock,
 * `markConsumed` stänger dem för återanvändning, och `rehydrateHistoryBlocks`
 * hämtar tillbaka innehållet när ett gammalt meddelande läses in i historiken.
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

  /**
   * B2 — gör bilage-id:n till Anthropic-innehållsblock inför ett chattanrop.
   *
   * Returnerar BÅDE de färdiga blocken (bytes, går till modellen) och
   * referensblocken (går till `AiMessage.blocks`). De byggs på ett ställe så att
   * det som modellen fick och det som historiken minns aldrig kan divergera.
   *
   * Org-scopningen är hela poängen: `findMany` filtrerar på organizationId OCH
   * userId, och antalet träffar jämförs med antalet begärda id:n. En användare
   * som gissar ett id ur en annan organisation får ett fel, inte innehållet.
   */
  async buildContentBlocks(
    attachmentIds: string[],
    organizationId: string,
    userId: string,
  ): Promise<{
    contentBlocks: Anthropic.ContentBlockParam[]
    refBlocks: AttachmentRefBlock[]
    ids: string[]
  }> {
    if (attachmentIds.length === 0) {
      return { contentBlocks: [], refBlocks: [], ids: [] }
    }

    // Dedup: samma id två gånger ska inte betala för samma bytes två gånger.
    const uniqueIds = [...new Set(attachmentIds)]

    const rows = await this.prisma.aiAttachment.findMany({
      where: { id: { in: uniqueIds }, organizationId, userId },
    })

    if (rows.length !== uniqueIds.length) {
      const found = new Set(rows.map((r) => r.id))
      const missing = uniqueIds.filter((id) => !found.has(id))
      // Samma fel oavsett om bilagan inte finns eller tillhör någon annan —
      // svaret får inte gå att använda för att avgöra vilket av de två som gäller.
      throw new NotFoundException(
        `Bilagan hittades inte (${missing.length} av ${uniqueIds.length} id:n kunde inte användas)`,
      )
    }

    const alreadyUsed = rows.filter((r) => r.consumedAt)
    if (alreadyUsed.length > 0) {
      // En konsumerad bilaga ligger redan i historiken. Att skicka den igen
      // skulle dubbeldebitera tokens och göra samtalet motsägelsefullt.
      throw new BadRequestException(
        `${alreadyUsed.length} av bilagorna är redan skickade i konversationen`,
      )
    }

    // Behåll anroparens ordning — den speglar hur användaren bifogade filerna.
    const byId = new Map(rows.map((r) => [r.id, r]))
    const ordered = uniqueIds.map((id) => byId.get(id)!)

    const contentBlocks: Anthropic.ContentBlockParam[] = []
    const refBlocks: AttachmentRefBlock[] = []

    for (const row of ordered) {
      const buffer = await this.storage.getFileBuffer(row.storageKey)
      contentBlocks.push(this.toAnthropicBlock(row.mimeType, buffer))
      refBlocks.push({
        type: ATTACHMENT_REF_BLOCK,
        attachmentId: row.id,
        kind: attachmentKind(row.mimeType),
        filename: row.filename,
        mimeType: row.mimeType,
      })
    }

    return { contentBlocks, refBlocks, ids: ordered.map((r) => r.id) }
  }

  /**
   * B2 — markera bilagor som skickade. Anropas EFTER att meddelandet gått
   * igenom, av två skäl: cronen ska inte städa bort något som ligger i en
   * levande konversation, och samma bilaga ska inte kunna skickas en andra gång
   * (`buildContentBlocks` vägrar konsumerade).
   *
   * Sätter samtidigt `conversationId` om bilagan laddades upp innan samtalet
   * fanns — det är först nu vi vet vilket samtal det blev.
   */
  async markConsumed(attachmentIds: string[], conversationId: string): Promise<void> {
    if (attachmentIds.length === 0) return
    await this.prisma.aiAttachment.updateMany({
      where: { id: { in: attachmentIds }, consumedAt: null },
      data: { consumedAt: new Date(), conversationId },
    })
  }

  /**
   * B2 — översätt persisterade referensblock tillbaka till riktiga
   * innehållsblock genom att hämta bytes ur R2.
   *
   * Tre saker att veta:
   *  • NYASTE FÖRST mot `MAX_REHYDRATE_BYTES`. Det som inte får plats blir en
   *    textnotis, inte tystnad — modellen ska veta att en bilaga funnits.
   *  • En R2-miss (städad, borttagen, nere) blir också en notis. Historiken ska
   *    kunna läsas även när en gammal fil är borta.
   *  • Blocken går in i samma ordning de låg i meddelandet; det är bara
   *    INNEHÅLLET som kan degraderas.
   */
  async rehydrateHistoryBlocks(
    blocks: unknown[],
    budget: { remainingBytes: number },
  ): Promise<Anthropic.ContentBlockParam[]> {
    const refs = blocks.filter(isAttachmentRefBlock)
    if (refs.length === 0) {
      return blocks as Anthropic.ContentBlockParam[]
    }

    const rows = await this.prisma.aiAttachment.findMany({
      where: { id: { in: refs.map((r) => r.attachmentId) } },
      select: { id: true, storageKey: true, sizeBytes: true, mimeType: true },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))

    const loaded = new Map<string, Anthropic.ContentBlockParam>()
    for (const ref of refs) {
      const row = byId.get(ref.attachmentId)
      if (!row) continue
      if (row.sizeBytes > budget.remainingBytes) continue
      try {
        const buffer = await this.storage.getFileBuffer(row.storageKey)
        loaded.set(ref.attachmentId, this.toAnthropicBlock(row.mimeType, buffer))
        budget.remainingBytes -= row.sizeBytes
      } catch (error) {
        this.logger.warn(
          `Kunde inte läsa bilaga ${ref.attachmentId} för historiken: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    return blocks.map((block) => {
      if (!isAttachmentRefBlock(block)) return block as Anthropic.ContentBlockParam
      return (
        loaded.get(block.attachmentId) ?? {
          type: 'text' as const,
          text: `[Bilagan "${block.filename}" bifogades tidigare i samtalet men är inte tillgänglig i det här sammanhanget.]`,
        }
      )
    })
  }

  /**
   * Ett `image`- eller `document`-block, valt ur MIME-typen via samma
   * `attachmentKind` som uppladdningen använde. `media_type` är den DETEKTERADE
   * typen — klientens påstående kom aldrig så här långt.
   */
  private toAnthropicBlock(mimeType: string, buffer: Buffer): Anthropic.ContentBlockParam {
    const data = buffer.toString('base64')
    if (attachmentKind(mimeType) === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
          data,
        },
      }
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
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
