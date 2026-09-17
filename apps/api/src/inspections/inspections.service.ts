import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { buildBrandedPdfHtml, escapeHtml, getLogoDataUrl } from '../common/branding'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { InspectionStatus, InspectionType, Prisma } from '@prisma/client'
import type { InspectionItemCondition } from '@prisma/client'
import { CreateInspectionDto } from './dto/create-inspection.dto'
import { UpdateInspectionDto } from './dto/update-inspection.dto'
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import {
  BESIKTNING_SIGNERAD_MEDDELANDE,
  computeSignedContentHash,
  type SignedContent,
} from './inspection-signature'

const DEFAULT_ITEMS: { room: string; item: string }[] = [
  { room: 'Hall', item: 'Golv' },
  { room: 'Hall', item: 'Väggar' },
  { room: 'Hall', item: 'Tak' },
  { room: 'Kök', item: 'Golv' },
  { room: 'Kök', item: 'Väggar' },
  { room: 'Kök', item: 'Vitvaror' },
  { room: 'Kök', item: 'Köksluckor' },
  { room: 'Kök', item: 'Bänkskiva' },
  { room: 'Badrum', item: 'Golv' },
  { room: 'Badrum', item: 'Väggar' },
  { room: 'Badrum', item: 'Toalett' },
  { room: 'Badrum', item: 'Dusch/Badkar' },
  { room: 'Vardagsrum', item: 'Golv' },
  { room: 'Vardagsrum', item: 'Väggar' },
  { room: 'Vardagsrum', item: 'Tak' },
  { room: 'Sovrum', item: 'Golv' },
  { room: 'Sovrum', item: 'Väggar' },
  { room: 'Övrigt', item: 'Fönster' },
  { room: 'Övrigt', item: 'Dörrar' },
  { room: 'Övrigt', item: 'Lås' },
]

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDateStr(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' })
}

function translateType(type: InspectionType): string {
  const m: Record<InspectionType, string> = {
    MOVE_IN: 'Inflyttningsbesiktning',
    MOVE_OUT: 'Utflyttningsbesiktning',
    PERIODIC: 'Periodisk besiktning',
    DAMAGE: 'Skadebesiktning',
  }
  return m[type]
}

function conditionColor(condition: InspectionItemCondition): string {
  switch (condition) {
    case 'GOOD':
      return '#059669'
    case 'ACCEPTABLE':
      return '#D97706'
    case 'DAMAGED':
      return '#DC2626'
    case 'MISSING':
      return '#DC2626'
  }
}

function conditionLabel(condition: InspectionItemCondition): string {
  const m: Record<InspectionItemCondition, string> = {
    GOOD: 'Bra',
    ACCEPTABLE: 'Acceptabelt',
    DAMAGED: 'Skadat',
    MISSING: 'Saknas',
  }
  return m[condition]
}

const FULL_INCLUDE = {
  property: true,
  unit: true,
  tenant: { select: SAFE_TENANT_SELECT },
  lease: true,
  items: true,
  images: true,
} as const

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
  ) {}

  async findAll(
    orgId: string,
    filters?: {
      unitId?: string
      propertyId?: string
      type?: InspectionType
      status?: InspectionStatus
    },
  ) {
    return this.prisma.inspection.findMany({
      where: {
        organizationId: orgId,
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      include: FULL_INCLUDE,
      orderBy: { scheduledDate: 'desc' },
    })
  }

  async findOne(id: string, orgId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id, organizationId: orgId },
      include: FULL_INCLUDE,
    })
    if (!inspection) throw new NotFoundException('Besiktning hittades inte')
    return inspection
  }

  // IDOR-spärr: varje klient-skickat relations-id måste tillhöra anropande org
  // INNAN besiktningen skrivs. Annars kan org A koppla en besiktning till org B:s
  // fastighet/enhet/avtal/hyresgäst → svaret (FULL_INCLUDE) läcker offrets data.
  // Validerar bara icke-tomma id:n. (Launch-readiness #5/#19-klassen.)
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

  async create(dto: CreateInspectionDto, orgId: string, userId: string) {
    await this.assertRelationsInOrg(orgId, {
      propertyId: dto.propertyId,
      unitId: dto.unitId,
      leaseId: dto.leaseId,
      tenantId: dto.tenantId,
    })
    const inspection = await this.prisma.inspection.create({
      data: {
        organizationId: orgId,
        inspectedById: userId,
        type: dto.type,
        scheduledDate: new Date(dto.scheduledDate),
        propertyId: dto.propertyId,
        unitId: dto.unitId,
        ...(dto.leaseId ? { leaseId: dto.leaseId } : {}),
        ...(dto.tenantId ? { tenantId: dto.tenantId } : {}),
      },
    })

    if (dto.type === InspectionType.MOVE_IN || dto.type === InspectionType.MOVE_OUT) {
      await this.prisma.inspectionItem.createMany({
        data: DEFAULT_ITEMS.map((i) => ({
          inspectionId: inspection.id,
          room: i.room,
          item: i.item,
        })),
      })
    }

    return this.prisma.inspection.findUnique({
      where: { id: inspection.id },
      include: FULL_INCLUDE,
    })
  }

  // ══ FRYSNINGEN AV DET SIGNERADE PROTOKOLLET ═══════════════════════════════
  //
  // Ett besiktningsprotokoll är partsbevisning. Det är huvudbeviset när ett
  // depositionsavdrag bestrids, och `InspectionItem.repairCost` är det belopp
  // avdraget vilar på. Fram till nu kunde varje uppgift i protokollet skrivas om
  // EFTER signeringen: `update`, `updateItem`, `analyze` och `delete` läste
  // aldrig status. En post kunde vändas GOOD → DAMAGED med ett belopp, och hela
  // protokollet kunde raderas spårlöst — medan `signedAt` stod kvar och påstod
  // att någon skrivit under.
  //
  // ── VARFÖR RADLÅS OCH INTE BARA EN IF-SATS ────────────────────────────────
  //
  // En läsning av `status` följd av en skrivning är en TOCTOU: två samtidiga
  // anrop läser båda "öppen" innan någon skriver. READ COMMITTED visar inte den
  // andres ocommittade signering. Utan lås hade spärren alltså skyddat mot den
  // långsamma användaren och inte mot den samtidiga — och det är den samtidiga
  // som är farlig, för AI-analysen håller sitt fönster öppet i flera sekunder.
  //
  // `FOR UPDATE` på BESIKTNINGSRADEN serialiserar båda riktningarna mot samma
  // rad, även när skrivningen gäller en BARNRAD:
  //
  //   redigering vinner  → ändringen committas, signeringen låser sedan, läser
  //                        det ändrade innehållet och binder DET. Signaturen
  //                        täcker alltså aldrig annan data än underlaget.
  //   signering vinner   → signeringen committas, redigeringen låser sedan,
  //                        läser SIGNED och nekas.
  //
  // Låsordningen är Inspection → InspectionItem, och ingen annan väg i kodbasen
  // tar lås på de här raderna, så ingen cykel kan uppstå.
  //
  // ── SPÄRREN NEKAR, DEN ÅTERÖPPNAR ALDRIG ──────────────────────────────────
  //
  // Det finns MED FLIT ingen väg att låsa upp ett signerat protokoll. Ett
  // "återöppna"-läge hade gjort spärren till en formalitet: den som ville ändra
  // hade tryckt på den knappen först. Att rätta ett signerat protokoll kräver
  // ett produktbeslut om en rättelse-/omprövningsfunktion (ny version med
  // hänvisning bakåt, inte överskrivning). Det beslutet är inte fattat och
  // fattas inte här.
  private async lockAndAssertUnsigned(
    tx: Prisma.TransactionClient,
    id: string,
    orgId: string,
  ): Promise<{ id: string; status: InspectionStatus; signedAt: Date | null }> {
    // Låset tas FÖRE statusläsningen — annars är låset verkningslöst och
    // kontrollen läser ett värde som hinner bli inaktuellt. Org-scopet ligger i
    // WHERE:n: en främmande orgs rad låses aldrig och hittas aldrig.
    await tx.$queryRaw`SELECT id FROM "Inspection" WHERE id = ${id} AND "organizationId" = ${orgId} FOR UPDATE`

    const besiktning = await tx.inspection.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, status: true, signedAt: true },
    })
    if (!besiktning) throw new NotFoundException('Besiktning hittades inte')

    // BÅDA villkoren prövas. `status` är vad produkten visar, `signedAt` är vad
    // som faktiskt påstår att någon skrivit under, och de kan gå isär i data som
    // skrevs innan den här spärren fanns. Att kräva båda är strängare än att
    // kräva ett av dem, och en besiktning som är signerad enligt endera
    // uppgiften ska inte gå att ändra.
    if (besiktning.status === InspectionStatus.SIGNED || besiktning.signedAt !== null) {
      throw new ConflictException(BESIKTNING_SIGNERAD_MEDDELANDE)
    }
    return besiktning
  }

  /**
   * Läser besiktningen och nekar tidigt om den är signerad.
   *
   * Används av analysvägen FÖRE uppladdning och modellanrop: den vägen kostar
   * lagring och pengar innan den skriver något, och ett 409 efter att tio bilder
   * laddats upp och en vision-modell fakturerats är ett sämre besked än ett 409
   * direkt. Den är ett FÖRSVAR I DJUPET, inte spärren — spärren är
   * `lockAndAssertUnsigned`, som körs om under lås vid varje faktisk skrivning.
   */
  async findOneUnsigned(id: string, orgId: string) {
    const besiktning = await this.findOne(id, orgId)
    if (besiktning.status === InspectionStatus.SIGNED || besiktning.signedAt !== null) {
      throw new ConflictException(BESIKTNING_SIGNERAD_MEDDELANDE)
    }
    return besiktning
  }

  async update(id: string, dto: UpdateInspectionDto, orgId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Gäller ÄVEN ett andra signeringsförsök: en signerad besiktning är
      // stängd för all skrivning, och `status: 'SIGNED'` är ingen fribiljett.
      await this.lockAndAssertUnsigned(tx, id, orgId)

      const signerar = dto.status === InspectionStatus.SIGNED

      const uppdaterad = await tx.inspection.update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.overallCondition !== undefined ? { overallCondition: dto.overallCondition } : {}),
          // TIDPUNKTEN ÄR SERVERNS. `dto.completedAt` fanns här på raden under och
          // skrev över värdet ovan — alltså kunde klienten datera slutförandet av
          // ett besiktningsprotokoll fritt. Fältet är borttaget ur DTO:n och ur
          // det delade schemat; se `update-inspection.dto.ts`.
          ...(dto.status === InspectionStatus.COMPLETED ? { completedAt: new Date() } : {}),
          // `dto.signedAt` LÄSES INTE LÄNGRE, och fältet är borttaget ur DTO:n
          // och det delade schemat av exakt samma skäl som `completedAt` en gång
          // togs bort: klienten kunde datera en underskrift fritt, bakåt eller
          // framåt. En signeringstidpunkt som en anropare väljer själv är ingen
          // uppgift om verkligheten. Servern stämplar nedan, ensam.
          ...(dto.tenantSignature !== undefined ? { tenantSignature: dto.tenantSignature } : {}),
          ...(dto.landlordSignature !== undefined
            ? { landlordSignature: dto.landlordSignature }
            : {}),
        },
        include: FULL_INCLUDE,
      })

      if (!signerar) return uppdaterad

      // Hashen räknas över det innehåll som FAKTISKT står i protokollet efter
      // det här anropet — samma transaktion, samma lås, samma rader. Räknades
      // den på dto:n i stället hade den bundit vad anroparen SA, inte vad som
      // lagrades.
      return tx.inspection.update({
        where: { id },
        data: {
          signedAt: new Date(),
          // KONTROLLERAD cast, inte `as unknown as`: Prismas payload-typ bär fler
          // fält än underlaget behöver, men de gemensamma måste stämma — ändrar
          // någon formen på `SignedContent` faller BYGGET här i stället för att
          // hashen tyst börjar räknas på `undefined`.
          signedContentHash: computeSignedContentHash(uppdaterad as SignedContent),
        },
        include: FULL_INCLUDE,
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async updateItem(
    inspectionId: string,
    itemId: string,
    dto: UpdateInspectionItemDto,
    orgId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Barnraden är den farligaste vägen: det är HÄR skicket vänds från GOOD
      // till DAMAGED och ett belopp sätts. Låset tas på FÖRÄLDERN, för det är
      // föräldern signeringen rör.
      await this.lockAndAssertUnsigned(tx, inspectionId, orgId)

      // Verifiera HELA kedjan i EN query: posten måste tillhöra den besiktning som anges
      // i URL:en, OCH den besiktningen måste tillhöra anroparens org (från JWT). Tidigare
      // scopades update:en enbart på itemId → en användare kunde ändra en post i en annan
      // besiktning/annan organisation genom att byta itemId (IDOR). Samma NotFound oavsett
      // om posten saknas, hör till en annan besiktning eller en annan org — läck aldrig
      // existens. organizationId kommer ALLTID från JWT, aldrig från klient-input.
      const item = await tx.inspectionItem.findFirst({
        where: { id: itemId, inspectionId, inspection: { organizationId: orgId } },
        select: { id: true },
      })
      if (!item) throw new NotFoundException('Besiktningsobjekt hittades inte')

      return tx.inspectionItem.update({
        where: { id: itemId },
        data: {
          ...(dto.condition !== undefined ? { condition: dto.condition } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.repairCost !== undefined ? { repairCost: dto.repairCost } : {}),
        },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * Bildraderna från en AI-analys, skrivna under samma spärr som allt annat.
   *
   * Bilderna ÄR en del av beviset — de är det protokollet hänvisar till — och de
   * ingår därför i signaturunderlaget. Att kunna lägga till en bild i ett
   * signerat protokoll hade varit samma brist en våning ned.
   */
  async saveAnalysisImages(
    inspectionId: string,
    orgId: string,
    bilder: {
      filename: string
      storageKey: string
      storageUrl: string
      caption: string | null
      room: string | null
      size: number
    }[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockAndAssertUnsigned(tx, inspectionId, orgId)
      for (const bild of bilder) {
        await tx.inspectionImage.create({ data: { inspectionId, ...bild } })
      }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * Analysens skrivning tillbaka in i protokollet.
   *
   * Låg tidigare rakt i controllern som fyra ogrindade prisma-anrop. Den ligger
   * här nu därför att fönstret mellan "läs besiktningen" och "skriv resultatet"
   * är HELA modellanropet — flera sekunder — och en signering hinner med i det
   * fönstret. Kontrollen måste alltså göras om under lås vid skrivningen, inte
   * bara när vägen började.
   *
   * Posterna läses om inne i transaktionen av samma skäl: listan controllern
   * hämtade innan analysen kan vara inaktuell när resultatet kommer tillbaka.
   */
  async applyAnalysis(
    inspectionId: string,
    orgId: string,
    analys: {
      overallCondition: string
      notes: string
      items: {
        room: string
        item: string
        condition: InspectionItemCondition
        notes: string | null
        repairCost: number | null
      }[]
    },
  ): Promise<{ updatedItems: number; createdItems: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAndAssertUnsigned(tx, inspectionId, orgId)

      // Org-scopningen står i FRÅGAN, inte bara i låset ovan. `lockAndAssertUnsigned`
      // har redan avvisat en främmande org, så villkoret är strikt sett
      // överflödigt — men en skrivning mot en förälder-scopad modell ska gå att
      // granska på plats, utan att läsaren först måste följa ett anrop uppåt.
      // `object-scope.spec.ts` mäter exakt det.
      const befintliga = await tx.inspectionItem.findMany({
        where: { inspectionId, inspection: { organizationId: orgId } },
        select: { id: true, room: true, item: true },
      })

      let updatedItems = 0
      let createdItems = 0
      for (const ai of analys.items) {
        const träff = befintliga.find((it) => it.room === ai.room && it.item === ai.item)
        if (träff) {
          await tx.inspectionItem.update({
            where: { id: träff.id },
            data: {
              condition: ai.condition,
              ...(ai.notes ? { notes: ai.notes } : {}),
              ...(ai.repairCost != null ? { repairCost: ai.repairCost } : {}),
            },
          })
          updatedItems++
        } else {
          await tx.inspectionItem.create({
            data: {
              inspectionId,
              room: ai.room,
              item: ai.item,
              condition: ai.condition,
              notes: ai.notes ?? null,
              repairCost: ai.repairCost ?? null,
            },
          })
          createdItems++
        }
      }

      await tx.inspection.update({
        where: { id: inspectionId },
        data: { overallCondition: analys.overallCondition, notes: analys.notes },
      })

      return { updatedItems, createdItems }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async delete(id: string, orgId: string) {
    return this.prisma.$transaction(async (tx) => {
      // `onDelete: Cascade` tar poster OCH bilder med sig. Att radera en
      // signerad besiktning är därför inte en mildare variant av att ändra den
      // — det är att utplåna hela beviset, och till skillnad från en ändring
      // lämnar det ingenting kvar att jämföra med.
      await this.lockAndAssertUnsigned(tx, id, orgId)
      return tx.inspection.delete({ where: { id } })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async generateProtocolPdf(id: string, orgId: string): Promise<Buffer> {
    const inspection = await this.findOne(id, orgId)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const tenantName = inspection.tenant
      ? inspection.tenant.type === 'INDIVIDUAL'
        ? `${inspection.tenant.firstName ?? ''} ${inspection.tenant.lastName ?? ''}`.trim()
        : (inspection.tenant.companyName ?? '')
      : 'Ej angiven'

    // Group items by room
    const rooms = new Map<string, typeof inspection.items>()
    for (const item of inspection.items) {
      if (!rooms.has(item.room)) rooms.set(item.room, [])
      rooms.get(item.room)!.push(item)
    }

    const damagedItems = inspection.items.filter(
      (i) => i.condition === 'DAMAGED' || i.condition === 'MISSING',
    )
    const totalRepairCost = inspection.items.reduce((sum, i) => sum + Number(i.repairCost ?? 0), 0)

    // Varumärkesfärg för rubriker (rumstitlar). Steg 3, PR 3b: ersätter tidigare
    // hårdkodade #2563EB (ett av de 14 ställena i branding.ts-kartan) med orgens
    // primärfärg → DEFAULT_BRAND_COLOR. Status-/summafärgerna nedan (grönt/rött
    // för skick och reparationskostnad) är SEMANTISKA, inte varumärke, och lämnas
    // oförändrade.
    const brandColor = org.invoiceColor ?? DEFAULT_BRAND_COLOR

    const roomHtml = Array.from(rooms.entries())
      .map(
        ([room, items]) => `
      <div class="room-section">
        <div class="room-title">${escapeHtml(room)}</div>
        <table class="items-table">
          <thead>
            <tr>
              <th>Föremål</th>
              <th>Kondition</th>
              <th>Anteckning</th>
              <th>Kostnad</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (item) => `
              <tr>
                <td>${escapeHtml(item.item)}</td>
                <td><span class="condition-badge" style="color:${conditionColor(item.condition as InspectionItemCondition)};background:${conditionColor(item.condition as InspectionItemCondition)}1a">${conditionLabel(item.condition as InspectionItemCondition)}</span></td>
                <td>${item.notes ? escapeHtml(item.notes) : '—'}</td>
                <td>${item.repairCost ? formatSek(Number(item.repairCost)) : '—'}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`,
      )
      .join('')

    // Innehålls-CSS för protokollet. Steg 3, PR 3b: protokollets egna outer-wrapper
    // (html/head/body), header och footer är borttagna — RAMEN (logga/header/footer/
    // typsnitt/varumärkesfärg) kommer nu från den gemensamma brandade shellen.
    // Övriga sektioner/data är oförändrade. brandColor styr rumstitlarna.
    const contentCss = `
    .protocol-sub { font-size: 14px; color: #6b7280; margin-bottom: 28px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 32px; margin-bottom: 32px;
                 background: #f9fafb; border-radius: 10px; padding: 20px 24px; }
    .info-label { font-size: 11px; font-weight: 600; text-transform: uppercase;
                  letter-spacing: 0.06em; color: #9ca3af; margin-bottom: 4px; }
    .info-value { font-size: 14px; font-weight: 500; }
    .room-section { margin-bottom: 24px; }
    .room-title { font-size: 15px; font-weight: 700; color: ${brandColor};
                  border-bottom: 2px solid ${brandColor}1a; padding-bottom: 8px; margin-bottom: 12px; }
    .items-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .items-table th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase;
                      letter-spacing: 0.05em; color: #9ca3af; padding: 6px 8px;
                      border-bottom: 1px solid #e5e7eb; }
    .items-table td { padding: 8px; border-bottom: 1px solid #f3f4f6; }
    .condition-badge { display: inline-block; border-radius: 9999px; padding: 2px 10px;
                       font-size: 12px; font-weight: 600; }
    .summary { background: #f9fafb; border-radius: 10px; padding: 20px 24px; margin: 32px 0;
               display: flex; gap: 32px; }
    .summary-item { flex: 1; }
    .summary-label { font-size: 12px; font-weight: 600; text-transform: uppercase;
                     color: #9ca3af; letter-spacing: 0.06em; margin-bottom: 6px; }
    .summary-value { font-size: 20px; font-weight: 700; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 48px; }
    .sig-box { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; }
    .sig-title { font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 32px; }
    .sig-line { border-top: 1px solid #374151; padding-top: 8px;
                font-size: 12px; color: #6b7280; }`

    const contentHtml = `<style>${contentCss}</style>
  <div class="protocol-sub">${translateType(inspection.type)}</div>

  <div class="info-grid">
    <div>
      <div class="info-label">Fastighet</div>
      <div class="info-value">${escapeHtml(inspection.property.name)}</div>
    </div>
    <div>
      <div class="info-label">Enhet</div>
      <div class="info-value">${escapeHtml(inspection.unit.name)}</div>
    </div>
    <div>
      <div class="info-label">Hyresgäst</div>
      <div class="info-value">${escapeHtml(tenantName)}</div>
    </div>
    <div>
      <div class="info-label">Datum</div>
      <div class="info-value">${formatDateStr(inspection.scheduledDate)}</div>
    </div>
  </div>

  ${roomHtml}

  <div class="summary">
    <div class="summary-item">
      <div class="summary-label">Skadade föremål</div>
      <div class="summary-value" style="color:${damagedItems.length > 0 ? '#DC2626' : '#059669'}">${damagedItems.length}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Bedömd reparationskostnad</div>
      <div class="summary-value" style="color:${totalRepairCost > 0 ? '#DC2626' : '#059669'}">${totalRepairCost > 0 ? formatSek(totalRepairCost) : '0 kr'}</div>
    </div>
    ${inspection.overallCondition ? `<div class="summary-item" style="flex:2"><div class="summary-label">Övergripande kommentar</div><div style="font-size:14px;margin-top:4px">${escapeHtml(inspection.overallCondition)}</div></div>` : ''}
  </div>

  <div class="signatures">
    <div class="sig-box">
      <div class="sig-title">Hyresvärd</div>
      <div class="sig-line">Namn och underskrift</div>
      <div style="margin-top:16px" class="sig-line">Datum</div>
    </div>
    <div class="sig-box">
      <div class="sig-title">Hyresgäst</div>
      <div class="sig-line">Namn och underskrift</div>
      <div style="margin-top:16px" class="sig-line">Datum</div>
    </div>
  </div>`

    // Hämtar orgens logga (R2 → data-URL) och renderar protokollet genom den
    // gemensamma brandade shellen — logga, primär-/sekundärfärg, typsnitt och
    // konsekvent header/footer kommer nu från orgens varumärke (samma väg som
    // månadsrapporten i PR 3a). Protokollets DATA är oförändrad — bara ramen.
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)

    const html = buildBrandedPdfHtml({
      org: {
        name: org.name,
        orgNumber: org.orgNumber ?? null,
        street: org.street ?? null,
        postalCode: org.postalCode ?? null,
        city: org.city ?? null,
        email: org.email ?? null,
        phone: org.phone ?? null,
        bankgiro: org.bankgiro ?? null,
        vatNumber: org.vatNumber ?? null,
      },
      logoDataUrl,
      primaryColor: org.invoiceColor ?? null,
      secondaryColor: org.brandSecondaryColor ?? null,
      brandFont: org.brandFont ?? null,
      title: 'Besiktningsprotokoll',
      contentHtml,
      footerNote: 'Powered by Eveno Fastighetsförvaltning',
    })

    return this.pdfService.generateFromHtml(html)
  }

  async getStats(orgId: string) {
    const [grouped, byType] = await Promise.all([
      this.prisma.inspection.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: true,
      }),
      this.prisma.inspection.groupBy({
        by: ['type'],
        where: { organizationId: orgId },
        _count: true,
      }),
    ])

    const byStatus: Record<string, number> = {}
    for (const g of grouped) byStatus[g.status] = g._count

    const byTypeMap: Record<string, number> = {}
    for (const g of byType) byTypeMap[g.type] = g._count

    const total = Object.values(byStatus).reduce((s, n) => s + n, 0)

    return {
      total,
      scheduled: byStatus['SCHEDULED'] ?? 0,
      inProgress: byStatus['IN_PROGRESS'] ?? 0,
      completed: byStatus['COMPLETED'] ?? 0,
      signed: byStatus['SIGNED'] ?? 0,
      byType: {
        MOVE_IN: byTypeMap['MOVE_IN'] ?? 0,
        MOVE_OUT: byTypeMap['MOVE_OUT'] ?? 0,
        PERIODIC: byTypeMap['PERIODIC'] ?? 0,
        DAMAGE: byTypeMap['DAMAGE'] ?? 0,
      },
    }
  }
}
