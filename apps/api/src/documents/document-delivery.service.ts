import { createHash } from 'node:crypto'

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { DocumentCategory } from '@prisma/client'
import { extensionForDetectedMime } from '../common/utils/file-validation'
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

    // ── NYCKELN HÄRLEDS UR MOTTAGAREN OCH INNEHÅLLET ────────────────────────
    //
    // Nyckeln var `documents/<org>/<uuid()>_<filnamn>`. `Document` bär
    // `@@unique([organizationId, storageKey])`, men en färsk uuid per anrop gör
    // att det villkoret aldrig kan slå till: spärren var inte frånvarande, den
    // var BESEGRAD av nyckelvalet. Varje omkörning gav ett nytt dokument i
    // hyresgästens portal.
    //
    // MOTTAGAREN MÅSTE IN, och det är inte en detalj. En ren innehållshash
    // kolliderar när SAMMA fil skickas till TVÅ hyresgäster — ett
    // informationsbrev till alla i huset är normalfallet, inte undantaget — och
    // hyresgäst nummer två hade då aldrig fått sitt dokument. Det är exakt den
    // "för grova nämnare" som är värre än ingen nämnare alls: ett legitimt
    // dokument som tyst försvinner.
    //
    // FILNAMNET STÅR HELT UTANFÖR NYCKELN, och det är kodbasens redan fattade
    // beslut och inte mitt: `documents.service.ts` slutade använda klientens
    // filnamn med motiveringen "ett fält uppladdaren styr, använt som om det
    // vore verifierat". Ändelsen härleds därför ur mimetypen via den delade
    // `extensionForDetectedMime`. `Document.name` bär det användarsynliga
    // namnet ändå, så ingenting går förlorat.
    //
    // Samma felklass som den nyss borttagna kontraktsnyckeln, där ett
    // företagsnamn med snedstreck skrev ett extra katalogsteg in i sökvägen.
    const innehållsfingeravtryck = createHash('sha256').update(content).digest('hex').slice(0, 16)
    const storageKey =
      `documents/${organizationId}/${tenant.id}/` +
      `${innehållsfingeravtryck}.${extensionForDetectedMime(mimeType)}`

    // ── RADEN FÖRST, BYTESEN SEDAN (samma ordning som #641) ─────────────────
    //
    // Ordningen var ofarlig så länge nyckeln var slumpad: två anrop kunde per
    // konstruktion aldrig träffa samma objekt. Att göra nyckeln härledd INFÖR
    // kollisionen som möjlighet, och därmed också behovet av att ta anspråket
    // före bytesen. Utan den här ändringen hade nyckelfixen byggt in #641:s
    // överskrivning i den här vägen i stället för att hålla den borta.
    //
    // `getPresignedUrl` signerar en sökväg och kräver inte att objektet finns,
    // så raden kan bära sin `storageUrl` innan uppladdningen.
    const storageUrl = await this.storage.getPresignedUrl(storageKey)

    let doc: { id: string }
    let redanLevererat = false
    try {
      doc = await this.prisma.document.create({
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
        select: { id: true },
      })
    } catch (err) {
      // Bara DEN HÄR kollisionen. Andra unika index på Document betyder något
      // annat och ska fortsätta upp — aldrig en blind P2002-fångst.
      const p2002 = err as { code?: string; meta?: { target?: unknown } }
      const fält = Array.isArray(p2002.meta?.target) ? p2002.meta.target.map(String) : []
      if (p2002.code !== 'P2002' || !fält.includes('storageKey')) throw err

      // Samma mottagare, samma byten: dokumentet finns redan. Vi laddade inte
      // upp något, så ingenting kan ha skrivits över.
      const befintlig = await this.prisma.document.findFirstOrThrow({
        where: { organizationId, storageKey },
        select: { id: true },
      })
      doc = befintlig
      redanLevererat = true
    }

    if (!redanLevererat) {
      // Anspråket är vårt. Nu, och först nu, får bytesen skrivas.
      try {
        await this.storage.uploadFile(content, storageKey, mimeType)
      } catch (err) {
        // Raden tas bort igen — en rad mot ett objekt som aldrig laddades upp
        // visar ett dokument som inte går att öppna, och blockerar nästa försök
        // med sitt eget spöke.
        await this.prisma.document.delete({ where: { id: doc.id } }).catch(() => undefined)
        throw err
      }
    }

    // NOTISEN FÖLJER DOKUMENTET. Skapades inget nytt dokument finns det
    // ingenting att meddela — och ett andra mejl om samma dokument är precis
    // den dubblett en människa utanför systemet ser. Nyckeln hade dedupat
    // raden men lämnat utskicket odedupat, vilket är halva jobbet.
    if (input.notify && !redanLevererat) {
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
      organizationId,
      subject: 'Nytt dokument i din hyresgästportal',
      tenantName,
      organizationName: org?.name ?? '',
      bodyHtml:
        `<p>Hej ${safeTenantName},</p>` +
        `<p>Ett nytt dokument har lagts till i din hyresgästportal:</p>` +
        `<p><strong>${safeDocName}</strong></p>` +
        `<p>Logga in på din portal för att läsa dokumentet.</p>`,
      // ⚠️ DEN HÄR NYCKELN DEDUPAR MINDRE ÄN DEN SER UT ATT GÖRA.
      //
      // Vad den GÖR: `documentId` blir Bulls `jobId` och Resends
      // `Idempotency-Key`. En Bull-retry av samma jobb, eller två anrop för ett
      // REDAN BEFINTLIGT dokument, skickar alltså ett mejl — inte två.
      //
      // Vad den INTE gör: skydda mot ett AGENTOMFÖRSÖK. `documentId` MYNTAS i
      // samma körning som mejlet — AI-vägen `send_document_to_tenant` renderar
      // en ny PDF och skapar en ny `Document`-rad innan den kallar hit. Ett
      // omtag får därför ett NYTT documentId, en NY nyckel, och hyresgästen får
      // brevet en andra gång. Nyckeln kan per konstruktion aldrig kollidera med
      // sig själv över ett omförsök.
      //
      // Det är därför `send_document_to_tenant` står som DEDUPLICERBAR med
      // `traceDurability.plats: 'INGET'` i `ai/tools/effect-idempotency.ts` —
      // inte som IDEMPOTENT. En spärr man TROR finns kostar lika mycket som en
      // som saknas, men ger aldrig ett felmeddelande.
      //
      // Rätt nyckel vore innehållsderiverad (dokumentets `contentHash` +
      // mottagare), så att samma brev om samma innehåll bär samma nyckel oavsett
      // hur många gånger PDF:en renderas om. Det är nästa steg, inte det här.
      idempotencyKey: `doc-portal-notify-${documentId}`,
    })
  }
}
