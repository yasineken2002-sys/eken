import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common'
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
  MAX_AI_PDF_PAGES,
} from '../../common/utils/file-validation'
import { countPdfPages } from './pdf-page-count'
import { ATTACHMENT_PAYLOAD_BUDGET_BYTES, base64Bytes, formatMb } from './request-size'

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
 * Bilagornas andel av Anthropics 32 MB-tak, i KODADE byte — se `request-size.ts`.
 *
 * Nya bilagor och rehydrerad historik delar på samma budget, och de NYA går
 * först: det användaren just bifogade är alltid viktigare än en fil från tio
 * meddelanden sedan. Vad historiken får kvar är alltså vad de nya lämnade
 * över.
 *
 * Historiken rehydreras dessutom NYASTE FÖRST inom sin del. Det som inte får
 * plats blir en textnotis, inte tystnad — modellen ska veta att en bilaga
 * funnits i stället för att tro att den aldrig fanns.
 */
export const MAX_ATTACHMENT_BUDGET_BYTES = ATTACHMENT_PAYLOAD_BUDGET_BYTES

/**
 * Hur länge en KONSUMERAD bilagas fil sparas efter att dess samtal senast
 * rördes. Motiveringen står vid `cleanupConsumedAttachments`.
 */
export const CONSUMED_RETENTION_DAYS = 90

/** Hur många bilagor en städkörning tar per kategori. */
export const CLEANUP_BATCH_SIZE = 500

/**
 * Bildformaten Anthropic tar emot. Listan speglar SDK:ns `Base64ImageSource`
 * och används för att SMALNA AV, inte för att påstå — se `toAnthropicBlock`.
 */
export const ANTHROPIC_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const
export type AnthropicImageMediaType = (typeof ANTHROPIC_IMAGE_MEDIA_TYPES)[number]

/** Filändelse per DETEKTERAD typ — aldrig ur klientens filnamn. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

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
  /** Antal sidor för PDF; null för bilder och oräkneliga PDF:er. */
  pageCount: number | null
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

    // B3: sidräkning för PDF. Anthropic tar max 600 sidor per dokument — utan
    // kontrollen här upptäcks en 700-sidig fil först vid modellanropet, efter
    // uppladdning och betald överföring.
    let pageCount: number | null = null
    if (detected === 'application/pdf') {
      pageCount = countPdfPages(file.buffer)
      if (pageCount !== null && pageCount > MAX_AI_PDF_PAGES) {
        throw new BadRequestException(
          `PDF:en har ${pageCount} sidor (max ${MAX_AI_PDF_PAGES}). Dela upp den eller skicka de sidor det gäller.`,
        )
      }
      if (pageCount === null) {
        // MEDVETET INTE ETT FEL: att avvisa en giltig PDF för att vår räknare
        // inte förstod dess sidträd vore värre än att i sällsynta fall låta
        // Anthropic avvisa den. Loggas så att mönstret syns om det blir vanligt.
        this.logger.warn(
          `Kunde inte räkna sidor i "${path.basename(file.filename)}" — släpps fram oräknad`,
        )
      }
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

    // Filändelsen härleds ur den DETEKTERADE typen, inte ur klientens filnamn.
    // Annars hade en PDF som klienten döpte till "faktura.exe" fått en
    // .exe-nyckel i lagringen — en fil vars namn säger emot dess verifierade
    // innehåll. Visningsnamnet (`filename`) behåller användarens original.
    const storageKey = `ai-chat/${organizationId}/${uuid()}${EXTENSION_BY_MIME[detected] ?? ''}`
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
        pageCount,
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
      pageCount: attachment.pageCount,
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
    /** Kodade byte de nya bilagorna upptar — dras av historikens budget. */
    encodedBytes: number
  }> {
    if (attachmentIds.length === 0) {
      return { contentBlocks: [], refBlocks: [], ids: [], encodedBytes: 0 }
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

    // B3 — PRE-FLIGHT MOT 32 MB-TAKET, före en enda byte lästs ur R2.
    //
    // `CHAT_MAX_ATTACHMENTS = 5` räcker inte som skydd: fem filer på 20 MB är
    // 100 MB råa och ~133 MB som base64. Taket måste ligga på TOTALA byte, och
    // det räknas i KODADE byte eftersom det är så de går på tråden.
    //
    // Kollen görs på `sizeBytes` ur databasen — den skrevs av uppladdningen
    // efter att filen validerats, så vi behöver inte hämta något för att veta
    // hur stort det blir.
    const encodedBytes = rows.reduce((sum, r) => sum + base64Bytes(r.sizeBytes), 0)
    if (encodedBytes > MAX_ATTACHMENT_BUDGET_BYTES) {
      throw new PayloadTooLargeException(
        `Bilagorna är tillsammans för stora (${formatMb(encodedBytes)} kodat, max ` +
          `${formatMb(MAX_ATTACHMENT_BUDGET_BYTES)}). Skicka färre eller mindre filer.`,
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

    // De nya bilagorna har första tjing på budgeten; historiken får resten.
    return {
      contentBlocks,
      refBlocks,
      ids: ordered.map((r) => r.id),
      encodedBytes,
    }
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
   *  • NYASTE FÖRST mot den budget som blev över efter de nya bilagorna. Det
   *    som inte får plats blir en textnotis, inte tystnad — modellen ska veta
   *    att en bilaga funnits.
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
      // Tom storageKey = filen är städad enligt retentionen. Raden finns kvar
      // så historiken kan säga att en bilaga funnits — men det finns inget att
      // hämta, så den faller till notisen längre ner.
      if (!row || row.storageKey === '') continue
      // Kodade byte, samma valuta som budgeten och som tråden.
      const cost = base64Bytes(row.sizeBytes)
      if (cost > budget.remainingBytes) continue
      try {
        const buffer = await this.storage.getFileBuffer(row.storageKey)
        loaded.set(ref.attachmentId, this.toAnthropicBlock(row.mimeType, buffer))
        budget.remainingBytes -= cost
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
      // B3: RIKTIG avsmalning i stället för en cast. Den gamla raden
      // (`mimeType as 'image/jpeg' | ...`) påstod en typ som TypeScript aldrig
      // kontrollerade — hade allowlisten någon gång vidgats, eller en rad i
      // databasen burit något annat, hade fel media_type gått till Anthropic
      // tyst. Nu kastar vi i stället, med värdet i felet.
      if (!ANTHROPIC_IMAGE_MEDIA_TYPES.includes(mimeType as AnthropicImageMediaType)) {
        throw new BadRequestException(`Bildformatet ${mimeType} stöds inte`)
      }
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType as AnthropicImageMediaType,
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
   * RETENTION — två skäl att ta bort en bilaga, med olika frister.
   *
   * 1. OANVÄND (`consumedAt = null`) efter 24 h. Varje påbörjat men avbrutet
   *    meddelande lämnar annars en fil i R2 för alltid.
   *
   * 2. KONSUMERAD men i ett samtal som legat stilla längre än
   *    `CONSUMED_RETENTION_DAYS`. B2 undantog konsumerade bilagor helt, vilket
   *    var rätt då (de behövs för rehydreringen) men gjorde lagringen
   *    obegränsat växande: en aktiv organisation som bifogar dagligen fyller
   *    R2 utan bortre gräns.
   *
   *    90 dagar valt så här: bilagan behövs bara så länge samtalet kan
   *    fortsätta. Glidfönstret behåller 20 meddelanden, och ett samtal som
   *    varit rört på ett kvartal återupptas i praktiken inte — men ett kvartal
   *    är också gott om tid för en hyresvärd att gå tillbaka till "det där
   *    kontoutdraget i maj". Kortare hade riskerat att kapa levande ärenden
   *    (en inkassotrappa löper över månader), längre hade inte tillfört något
   *    eftersom underlaget då hör hemma i dokumentarkivet, inte i en chatt.
   *
   *    Fristen räknas på samtalets `updatedAt`, inte bilagans ålder: ett samtal
   *    som fortfarande används behåller sina bilagor hur gamla de än är.
   *    RADEN blir kvar när filen städas — historiken visar då notisen
   *    "bifogades tidigare men är inte tillgänglig", vilket är sannare än att
   *    låtsas att bilagan aldrig funnits.
   */
  @Cron('0 4 * * *')
  async cleanupExpiredAttachments(): Promise<void> {
    const removedUnused = await this.cleanupUnusedAttachments()
    const removedConsumed = await this.cleanupConsumedAttachments()
    if (removedUnused + removedConsumed > 0) {
      this.logger.log(
        `Städade ${removedUnused} oanvända och ${removedConsumed} konsumerade AI-bilagor`,
      )
    }
  }

  /** Bilagor som laddades upp men aldrig skickades — rad och fil tas bort. */
  private async cleanupUnusedAttachments(): Promise<number> {
    const expired = await this.prisma.aiAttachment.findMany({
      where: { consumedAt: null, expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
      take: CLEANUP_BATCH_SIZE,
    })

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
    return removed
  }

  /**
   * Konsumerade bilagor i samtal som legat stilla längre än fristen. FILEN tas
   * bort ur R2 men RADEN blir kvar (med `storageKey` nollställd) — historiken
   * ska kunna berätta att en bilaga funnits.
   */
  private async cleanupConsumedAttachments(): Promise<number> {
    const cutoff = new Date(Date.now() - CONSUMED_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const stale = await this.prisma.aiAttachment.findMany({
      where: {
        consumedAt: { not: null },
        storageKey: { not: '' },
        conversation: { updatedAt: { lt: cutoff } },
      },
      select: { id: true, storageKey: true },
      take: CLEANUP_BATCH_SIZE,
    })

    let removed = 0
    for (const attachment of stale) {
      try {
        await this.storage.deleteFile(attachment.storageKey)
        // Tom nyckel = filen är städad. Rehydreringen hoppar över den och
        // lämnar sin textnotis; nästa städning plockar inte upp den igen.
        await this.prisma.aiAttachment.update({
          where: { id: attachment.id },
          data: { storageKey: '' },
        })
        removed++
      } catch (error) {
        this.logger.error(
          `Kunde inte städa konsumerad bilaga ${attachment.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    return removed
  }

  /**
   * Ta bort R2-objekten för ett samtals bilagor. Anropas INNAN samtalet
   * raderas.
   *
   * Utan det här läcker varje raderad konversation sina filer: `onDelete:
   * Cascade` tar bort AiAttachment-RADEN, men databasen vet ingenting om R2 —
   * objektet blir kvar utan att någon rad längre pekar på det, alltså utan att
   * någon städning någonsin kan hitta det. Städcronen letar via rader.
   */
  async deleteConversationFiles(conversationId: string): Promise<void> {
    const attachments = await this.prisma.aiAttachment.findMany({
      where: { conversationId, storageKey: { not: '' } },
      select: { id: true, storageKey: true },
    })
    for (const attachment of attachments) {
      try {
        await this.storage.deleteFile(attachment.storageKey)
      } catch (error) {
        // Loggas men stoppar inte raderingen: användaren har bett om att få
        // samtalet borttaget, och en R2-miss får inte hindra det.
        this.logger.error(
          `Kunde inte ta bort bilagefil ${attachment.id} vid radering av samtal: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
}
