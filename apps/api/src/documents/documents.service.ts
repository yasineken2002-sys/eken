import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DocumentCategory } from '@prisma/client'
import { v4 as uuid } from 'uuid'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { DocumentDeliveryService } from './document-delivery.service'
import type { PortalDocumentCategory } from './document-delivery.service'
import {
  validateUploadedFile,
  extensionForDetectedMime,
  DETECTED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
} from '../common/utils/file-validation'
import {
  assertMayAccessContractDocument,
  mayAccessContractDocuments,
} from '../common/authz/documents-authz'
import type { UserRole } from '@prisma/client'

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
]

const MAX_FILE_SIZE = MAX_DOCUMENT_BYTES // 20 MB (delad konstant, se file-validation.ts)

export interface UploadFileData {
  buffer: Buffer
  filename: string
  mimetype: string
  size: number
}

export interface UploadDocumentInput {
  name: string
  description?: string | undefined
  category?: DocumentCategory | undefined
  propertyId?: string | undefined
  unitId?: string | undefined
  leaseId?: string | undefined
  tenantId?: string | undefined
}

@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private storage: StorageService,
    private delivery: DocumentDeliveryService,
  ) {}

  /**
   * SKICKA ETT BEFINTLIGT DOKUMENT TILL EN HYRESGÄSTS PORTAL.
   *
   * ── VARFÖR METODEN FINNS ──────────────────────────────────────────────────
   *
   * `DocumentDeliveryService.deliverToTenant` hade exakt EN anropare i hela
   * kodbasen, och det var AI-verktyget `send_document_to_tenant`. Att ladda upp
   * ett dokument och att skicka det till en hyresgäst är två olika saker, och
   * bara den första fanns för människan — verktyget stod därför i
   * `tool-human-path.baseline.json`.
   *
   * ── SAMMA PRIMITIV, INTE EN KOPIA ─────────────────────────────────────────
   *
   * Leveransen går genom `deliverToTenant`, precis som verktyget. Den äger
   * org-scopingen av mottagaren, INVOICE-coercningen (kategorin döljs i
   * portalen), den innehålls- och mottagarhärledda lagringsnyckeln och
   * notisen. Inget av det upprepas här.
   *
   * ── SKILLNADEN MOT VERKTYGET, OCH VARFÖR DEN INTE ÄR ETT UNDERSKOTT ───────
   *
   * Verktyget KOMPONERAR ett dokument: det tar en titel och en text, renderar
   * en PDF och levererar den. Den här vägen tar ett dokument som REDAN finns.
   * Människan kommer alltså åt samma förmåga — leverera till portalen — via en
   * fil hon laddat upp själv, vilket är minst lika mycket: uppladdningen
   * accepterar fler filtyper än den genererade PDF:en verktyget kan bygga.
   *
   * ── 404, ALDRIG 403 ───────────────────────────────────────────────────────
   *
   * `findOne` slår upp med `{ id, organizationId }` och kastar NotFound. Ett
   * 403 hade avslöjat att dokumentet FINNS i någon annan organisation — en
   * skillnad som går att räkna på utifrån.
   */
  async sendToTenant(params: {
    documentId: string
    tenantId: string
    organizationId: string
    notify?: boolean
  }): Promise<{ documentId: string }> {
    const { documentId, tenantId, organizationId } = params

    // Kastar NotFound om dokumentet inte finns i anroparens organisation.
    const document = await this.findOne(documentId, organizationId)

    const content = await this.storage.getFileBuffer(document.storageKey)

    // Kategorin ärvs från källdokumentet när den är en portal-kategori.
    // INVOICE tas om hand av leveranstjänsten (coercas till OTHER) — vi
    // upprepar inte den regeln här, för då hade det funnits två.
    return this.delivery.deliverToTenant({
      organizationId,
      tenantId,
      content,
      // `Document` HAR INGEN `fileName`-kolumn — bara `name`, `storageKey`,
      // `mimeType` och `fileSize`. Och `deliverToTenant` LÄSER inte fältet:
      // uppmätt, det förekommer exakt en gång i filen, i typdeklarationen.
      // Lagringsnyckeln härleds numera ur mottagaren och innehållet, med
      // ändelsen ur mimetypen — filnamnet togs medvetet ur nyckeln (se
      // docblocket där). Fältet är alltså en kvarleva som typen fortfarande
      // kräver. Vi skickar visningsnamnet, inte ett påhittat filnamn, och
      // städningen av det obrukade fältet hör till en egen ändring: den rör
      // också AI-verktygets anrop.
      fileName: document.name,
      name: document.name,
      category: document.category as PortalDocumentCategory,
      mimeType: document.mimeType,
      ...(params.notify === undefined ? {} : { notify: params.notify }),
    })
  }

  async findAll(
    organizationId: string,
    filters?: {
      propertyId?: string
      unitId?: string
      leaseId?: string
      tenantId?: string
      category?: DocumentCategory
    },
    actorRole?: UserRole,
  ) {
    // Hyreskontrakt bär personnummer. Roller som inte får se dem ska inte heller
    // få veta att de finns — listan delar annars ut dokument-id:t, som är allt
    // nedladdningen behöver. Se documents-authz.ts.
    const döljKontrakt = !mayAccessContractDocuments(actorRole)
    // Uttrycklig ?category=CONTRACT från en roll som inte får se dem: tom lista.
    // Måste ligga FÖRE where-bygget — filtret nedan spreds annars efter grinden
    // och skrev över den, så just den som frågade rakt ut fick svaret.
    if (döljKontrakt && filters?.category === DocumentCategory.CONTRACT) return []
    const documents = await this.prisma.document.findMany({
      where: {
        organizationId,
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
        ...(filters?.tenantId ? { tenantId: filters.tenantId } : {}),
        // Kategorivillkoret sist och som ETT uttryck: antingen den begärda
        // kategorin, eller — för roller utan kontraktsbehörighet — allt utom
        // CONTRACT. Två separata spreadar hade låtit det ena skriva över det andra.
        ...(filters?.category
          ? { category: filters.category }
          : döljKontrakt
            ? { category: { not: DocumentCategory.CONTRACT } }
            : {}),
      },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
        property: { select: { name: true } },
        unit: { select: { name: true } },
        lease: { select: { id: true } },
        tenant: { select: { firstName: true, lastName: true, companyName: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return documents
  }

  async findOne(id: string, organizationId: string) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
      },
    })
    if (!document) throw new NotFoundException('Dokumentet hittades inte')
    return document
  }

  // IDOR-spärr: varje klient-skickat relations-id måste tillhöra anropande org
  // INNAN dokumentet skrivs. Annars kan org A koppla ett dokument till org B:s
  // fastighet/enhet/avtal/hyresgäst. Validerar bara icke-tomma id:n.
  // (Launch-readiness #5/#19-klassen.)
  private async assertRelationsInOrg(
    organizationId: string,
    ids: {
      propertyId?: string | null | undefined
      unitId?: string | null | undefined
      leaseId?: string | null | undefined
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
    if (ids.leaseId) {
      const l = await this.prisma.lease.findFirst({
        where: { id: ids.leaseId, organizationId },
        select: { id: true },
      })
      if (!l) throw new NotFoundException('Hyresavtalet hittades inte')
    }
    if (ids.tenantId) {
      const t = await this.prisma.tenant.findFirst({
        where: { id: ids.tenantId, organizationId },
        select: { id: true },
      })
      if (!t) throw new NotFoundException('Hyresgästen hittades inte')
    }
  }

  async upload(
    file: UploadFileData,
    dto: UploadDocumentInput,
    organizationId: string,
    uploadedById: string,
  ) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Filtypen stöds inte. Tillåtna format: PDF, Word, Excel, JPG, PNG',
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor. Maximal filstorlek är 20 MB.')
    }

    // SECURITY (H3): verifiera filens FAKTISKA innehåll (magiska byten) — den
    // deklarerade mimetype:n ovan kan vara förfalskad. Avvisar t.ex. en
    // omdöpt .exe/.html som påstår sig vara en PDF/bild.
    // #476: returvärdet är den DETEKTERADE typen, och det är den som används
    // nedan — inte `file.mimetype`. Klientens påstående grindas fortfarande av
    // ALLOWED_MIME_TYPES (ett tidigt, begripligt fel), men det når varken
    // lagringsnyckeln, R2:s Content-Type eller `Document.mimeType`.
    //
    // Utan det här kunde en äkta PDF laddas upp deklarerad som `image/webp`:
    // magic-byte-kontrollen passerade — filen ÄR en tillåten typ — och arkivet
    // fick en rad som sa emot sina egna byte. Ett felaktigt fält är sämre än ett
    // saknat: det saknade vet man att man måste ta reda på.
    const detected = validateUploadedFile(file.buffer, {
      allowedDetectedMimes: DETECTED_DOCUMENT_TYPES,
      maxBytes: MAX_FILE_SIZE,
    })
    // Null kan inte nå hit: allowlisten kastar på okänd signatur. Men en TYST
    // fallback till `file.mimetype` vore precis den defekt vi stänger, så det
    // onåbara fallet kastar i stället för att gissa.
    if (!detected) {
      throw new BadRequestException('Filtypen kunde inte fastställas ur filens innehåll')
    }
    const mimeType = detected

    // Org-scopa relations-id INNAN vi lägger något i R2 (fail fast + ingen läcka).
    await this.assertRelationsInOrg(organizationId, {
      propertyId: dto.propertyId,
      unitId: dto.unitId,
      leaseId: dto.leaseId,
      tenantId: dto.tenantId,
    })

    // Filändelsen togs tidigare ur KLIENTENS filnamn. Samma felklass som typen:
    // ett fält uppladdaren styr, använt som om det vore verifierat.
    const safeName = `${uuid()}.${extensionForDetectedMime(mimeType)}`
    const storageKey = `documents/${organizationId}/${safeName}`

    const storageUrl = await this.storage.uploadFile(file.buffer, storageKey, mimeType)

    const document = await this.prisma.document.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        storageKey,
        storageUrl,
        fileSize: file.size,
        mimeType,
        category: dto.category ?? DocumentCategory.OTHER,
        propertyId: dto.propertyId ?? null,
        unitId: dto.unitId ?? null,
        leaseId: dto.leaseId ?? null,
        tenantId: dto.tenantId ?? null,
        uploadedById,
      },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
      },
    })

    return document
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const document = await this.findOne(id, organizationId)
    // Bevisintegritet: ett låst eller signerat kontrakt är räkenskaps-/juridiskt
    // underlag och får ALDRIG hårdraderas — det skulle förstöra beviskedjan bakom
    // en BankID-signatur (SignatureEvidence pekar på detta Document). Signering-
    // härdningen (Item 4, S1).
    if (document.locked || (document.category === 'CONTRACT' && document.signedAt !== null)) {
      throw new ForbiddenException(
        'Ett signerat/låst kontrakt kan inte raderas — det är juridiskt bevisunderlag.',
      )
    }
    await this.storage.deleteFile(document.storageKey)
    await this.prisma.document.delete({ where: { id } })
  }

  async getDownloadUrl(
    id: string,
    organizationId: string,
    actorRole?: UserRole,
  ): Promise<{ url: string; document: Awaited<ReturnType<DocumentsService['findOne']>> }> {
    const document = await this.findOne(id, organizationId)
    // Nekandet sker FÖRE den presignerade URL:en skapas — en URL som hunnit
    // genereras är en nyckel som redan lämnat systemet, oavsett vad vi svarar.
    if (document.category === DocumentCategory.CONTRACT) {
      assertMayAccessContractDocument(actorRole)
    }
    const url = await this.storage.getPresignedUrl(document.storageKey, 300)
    return { url, document }
  }
}
