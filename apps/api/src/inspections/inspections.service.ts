import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
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
import { ordnaKedja, arSlutford, type VersionsRad, type VersionsLank } from './inspection-versions'
import {
  InspectionImageIntegrityService,
  type Bildkontroll,
  type BildkontrollUtfall,
} from './inspection-image-integrity.service'
import { CreateInspectionCorrectionDto } from './dto/create-inspection-correction.dto'

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
  // EFTERFÖLJAREN, I SAMMA FRÅGA. Listan måste kunna märka en rad som "rättad"
  // utan att slå en fråga per rad — och den enda uppgift som svarar på det är
  // om någon annan rad pekar hit med `correctionOfId`. En join är billig; N+1
  // över en lista är det inte.
  //
  // Fälten är avsiktligt få: listan ska kunna säga ATT en rättelse finns och om
  // den är slutförd, inte visa hela den.
  correction: {
    select: { id: true, version: true, status: true, signedAt: true, completedAt: true },
  },
} as const

/**
 * Kedjans rader, så lite av dem som versionslogiken behöver.
 *
 * Egen select och inte `FULL_INCLUDE`: kedjan hämtas en rad i taget och läses
 * bara för att ordnas. Att dra poster, bilder och hyresgästuppgifter för varje
 * länk hade varit att betala för data ingen läser.
 */
const KEDJE_SELECT = {
  id: true,
  version: true,
  status: true,
  signedAt: true,
  completedAt: true,
  correctionOfId: true,
  correctionReason: true,
  correctedById: true,
  correctedAt: true,
  createdAt: true,
} as const

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
    private readonly bildkontroll: InspectionImageIntegrityService,
  ) {}

  /**
   * VERSIONEN KLIENTEN SÅG, HÄRLEDD AV SERVERN.
   *
   * `contentHash` är hashen över protokollets innehåll **just nu**, räknad med
   * samma funktion som signeringen använder. Den lagras inte — den härleds vid
   * varje läsning, och det är hela poängen: klienten ska inte kunna hitta på
   * ett jämförelsevärde, bara eka tillbaka det den fick.
   *
   * Skiljs från `signedContentHash`, som är värdet FRUSET vid signeringen. För
   * ett osignerat protokoll är `signedContentHash` null medan `contentHash`
   * alltid har ett värde; för ett orört signerat protokoll är de lika.
   */
  private medContentHash<T extends SignedContent>(rad: T): T & { contentHash: string } {
    return { ...rad, contentHash: computeSignedContentHash(rad) }
  }

  async findAll(
    orgId: string,
    filters?: {
      unitId?: string
      propertyId?: string
      type?: InspectionType
      status?: InspectionStatus
    },
  ) {
    const rader = await this.prisma.inspection.findMany({
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
    // Listan är den vy webben faktiskt signerar ifrån — panelen öppnas ur den.
    // Saknades hashen här hade klienten inte haft något att eka tillbaka.
    return rader.map((rad) => this.medContentHash(rad))
  }

  /**
   * Detaljvyn — med hela versionskedjan.
   *
   * Kedjan ligger HÄR och inte bakom en egen endpoint därför att frågan "vilken
   * version tittar jag på, och gäller den?" inte är en fördjupning. Den är en
   * förutsättning för att läsa svaret rätt. En detaljvy som visar ett protokoll
   * utan att säga att en nyare version gäller visar fel uppgift, inte mindre.
   *
   * Kostnaden är en enradig indexslagning per länk, och kedjor är korta. Listan
   * (`findAll`) får den INTE av samma skäl: där hade den blivit N+1.
   */
  async findOne(id: string, orgId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id, organizationId: orgId },
      include: FULL_INCLUDE,
    })
    if (!inspection) throw new NotFoundException('Besiktning hittades inte')

    const versioner = ordnaKedja(await this.hamtaKedja(this.prisma, id, orgId))
    return {
      ...this.medContentHash(inspection),
      versioner,
      // Den HÄR radens roll i kedjan, uträknad en gång så att klienten inte
      // behöver leta rätt på sig själv i listan.
      arGallande: versioner.find((v) => v.id === id)?.arGallande ?? false,
      arUtkast: versioner.find((v) => v.id === id)?.arUtkast ?? false,
    }
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

    // Samma form som läsvägarna: en nyskapad besiktning returneras med
    // `contentHash`, annars hade svaret på POST saknat ett fält som klientens
    // `Inspection`-typ säger alltid finns.
    const skapad = await this.prisma.inspection.findUnique({
      where: { id: inspection.id },
      include: FULL_INCLUDE,
    })
    if (!skapad) throw new NotFoundException('Besiktning hittades inte')
    return this.medContentHash(skapad)
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

  // ══ VISAD VERSION MOT SIGNERAD VERSION ════════════════════════════════════
  //
  // Radlåset serialiserar samtidiga skrivare. Det upptäcker INTE att den som
  // signerar läste protokollet för fem minuter sedan och inte har sett vad som
  // hänt sedan dess. Utan en förutsättning band signeringen därför alltid
  // serverns NUVARANDE innehåll — även innehåll signeraren aldrig fått se.
  //
  // `expectedContentHash` är det värde klienten fick ur `contentHash` vid
  // läsningen. Servern HÄRLEDER jämförelsevärdet själv ur radens eget innehåll
  // (`computeSignedContentHash`), under samma lås, i samma transaktion som
  // signeringen. Klienten kan alltså inte hitta på förutsättningen — bara eka
  // tillbaka den den fick.
  //
  // VAD DET SKYDDAR MOT, OCH INTE: det här skyddar mot att signera INAKTUELL
  // data, inte mot en illvillig anropare. Den som vill kan hämta protokollet
  // och signera med den färska hashen i nästa andetag, utan att någon människa
  // läst en rad. Förutsättningen gör signaturen till ett påstående om en
  // VERSION — den gör den inte till ett påstående om att någon granskat den.
  //
  // ── VAD JÄMFÖRELSEN OMFATTAR ──────────────────────────────────────────────
  //
  // Exakt `buildSignedContent`: typ, planerat datum, slutförande, övergripande
  // omdöme, anteckning, samtliga poster (rum, föremål, skick, anteckning,
  // reparationskostnad) och samtliga bilder (filnamn, lagringsnyckel, bildtext,
  // rum, storlek, innehållsdigest).
  //
  // UTANFÖR jämförelsen, och alltså INGEN konflikt: `status`, `signedAt`,
  // `signedContentHash`, `tenantSignature`, `landlordSignature`. De beskriver
  // radens livscykel, inte vad som besiktigades.
  //
  // ── ÄNDRING OCH SIGNERING I SAMMA ANROP ───────────────────────────────────
  //
  // Tillåtet, med ett uttalat kontrakt: förutsättningen jämförs mot innehållet
  // FÖRE det här anropets egna ändringar. Anroparens egen redigering är alltså
  // aldrig en konflikt med sig själv — den är avsiktlig och författad av den
  // som signerar — medan någon ANNANS ändring sedan läsningen fäller anropet.
  // Hashen som lagras räknas därefter på slutresultatet.
  //
  // ── EN SAKNAD FÖRUTSÄTTNING FÅR INTE TYST SIGNERA ─────────────────────────
  //
  // Utelämnad `expectedContentHash` vid signering är 400, inte "hoppa över
  // kontrollen". En spärr som går att tysta genom att utelämna ett fält är
  // ingen spärr, och äldre klienter ska fälla synligt i stället för att signera
  // data de inte sett.
  async update(id: string, dto: UpdateInspectionDto, orgId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Gäller ÄVEN ett andra signeringsförsök: en signerad besiktning är
      // stängd för all skrivning, och `status: 'SIGNED'` är ingen fribiljett.
      await this.lockAndAssertUnsigned(tx, id, orgId)

      const signerar = dto.status === InspectionStatus.SIGNED

      if (!signerar && dto.expectedContentHash !== undefined) {
        throw new BadRequestException(
          'expectedContentHash är endast meningsfull vid signering och får inte skickas annars.',
        )
      }
      if (signerar) {
        if (!dto.expectedContentHash) {
          throw new BadRequestException(
            'Signering kräver expectedContentHash — värdet ur contentHash på den version du läste.',
          )
        }
        // Innehållet FÖRE anropets egna ändringar, läst under låset.
        const före = await tx.inspection.findFirst({
          where: { id, organizationId: orgId },
          include: FULL_INCLUDE,
        })
        if (!före) throw new NotFoundException('Besiktning hittades inte')
        if (computeSignedContentHash(före) !== dto.expectedContentHash) {
          throw new ConflictException(
            'Protokollet har ändrats sedan du läste det. Läs om besiktningen, granska ändringen och signera därefter — inget har signerats.',
          )
        }
      }

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

      if (!signerar) return this.medContentHash(uppdaterad)

      // Hashen räknas över det innehåll som FAKTISKT står i protokollet efter
      // det här anropet — samma transaktion, samma lås, samma rader. Räknades
      // den på dto:n i stället hade den bundit vad anroparen SA, inte vad som
      // lagrades.
      const signerad = await tx.inspection.update({
        where: { id },
        data: {
          signedAt: new Date(),
          signedContentHash: computeSignedContentHash(uppdaterad),
        },
        include: FULL_INCLUDE,
      })
      return this.medContentHash(signerad)
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
      contentSha256: string
      /** Återförsöksnyckelns prefix (OB5). Finns en bilaga under det redan, återanvänds den. */
      aterforsokPrefix?: string
    }[],
  ): Promise<{ ids: string[]; foraldralosa: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAndAssertUnsigned(tx, inspectionId, orgId)
      const ids: string[] = []
      const foraldralosa: string[] = []
      for (const { aterforsokPrefix, ...bild } of bilder) {
        // Kontrollen görs om UNDER radlåset: två samtidiga försök med samma
        // nyckel passerar båda controllerns uppslag, men bara det första
        // skapar raden. Det andra återanvänder den och lämnar sitt objekt
        // till controllern att radera.
        if (aterforsokPrefix) {
          const befintlig = await tx.inspectionImage.findFirst({
            where: {
              inspectionId,
              inspection: { organizationId: orgId },
              storageKey: { startsWith: aterforsokPrefix },
            },
            select: { id: true, contentSha256: true },
          })
          if (befintlig) {
            if (befintlig.contentSha256 !== bild.contentSha256) {
              throw new ConflictException(
                'Återförsöksnyckeln hör redan till en annan bild. Välj bilden på nytt.',
              )
            }
            ids.push(befintlig.id)
            foraldralosa.push(bild.storageKey)
            continue
          }
        }
        const rad = await tx.inspectionImage.create({
          data: { inspectionId, ...bild },
          select: { id: true },
        })
        ids.push(rad.id)
      }
      return { ids, foraldralosa }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * Bilaga som redan sparats för en återförsöksnyckel (OB5), inom EN besiktning
   * i EN org. Används av analysvägen före uppladdning; kontrollen görs om under
   * lås i `saveAnalysisImages`.
   */
  async findRetryImage(inspectionId: string, orgId: string, prefix: string) {
    return this.prisma.inspectionImage.findFirst({
      where: {
        inspectionId,
        inspection: { organizationId: orgId },
        storageKey: { startsWith: prefix },
      },
      select: { id: true, contentSha256: true },
    })
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

  // ══ RÄTTELSEVERSIONER ═════════════════════════════════════════════════════

  /**
   * Hela versionskedjan raden ingår i, org-scopad, i versionsordning.
   *
   * Vandringen går först BAKÅT till roten via `correctionOfId` och sedan FRAMÅT
   * via det unika villkoret på samma kolumn. Båda stegen är enradiga
   * indexslagningar, och kedjor är korta — ett protokoll rättas en eller två
   * gånger, inte hundra.
   *
   * `sedda` är inte paranoia utan en terminationsgaranti: skulle data någon gång
   * bli cyklisk — genom rå SQL eller en återställd säkerhetskopia — ska den här
   * funktionen sluta, inte snurra. En vakt som aldrig löser ut kostar en
   * Set-slagning per länk.
   *
   * Org-scopet står i VARJE fråga och inte bara i den första: en kedja får inte
   * kunna vandras in i en annan organisations rader ens om en `correctionOfId`
   * pekar dit.
   */
  private async hamtaKedja(
    db: Prisma.TransactionClient | PrismaService,
    id: string,
    orgId: string,
  ): Promise<VersionsRad[]> {
    const start = await db.inspection.findFirst({
      where: { id, organizationId: orgId },
      select: KEDJE_SELECT,
    })
    if (!start) throw new NotFoundException('Besiktning hittades inte')

    const kedja: VersionsRad[] = [start]
    const sedda = new Set<string>([start.id])

    let bakat = start
    while (bakat.correctionOfId) {
      const foregaende = await db.inspection.findFirst({
        where: { id: bakat.correctionOfId, organizationId: orgId },
        select: KEDJE_SELECT,
      })
      if (!foregaende || sedda.has(foregaende.id)) break
      sedda.add(foregaende.id)
      kedja.push(foregaende)
      bakat = foregaende
    }

    let framat = start
    for (;;) {
      const efterfoljande = await db.inspection.findFirst({
        where: { correctionOfId: framat.id, organizationId: orgId },
        select: KEDJE_SELECT,
      })
      if (!efterfoljande || sedda.has(efterfoljande.id)) break
      sedda.add(efterfoljande.id)
      kedja.push(efterfoljande)
      framat = efterfoljande
    }

    return kedja
  }

  /**
   * Versionskedjan, märkt med vilken version som gäller och vilka som är utkast.
   *
   * Publik därför att BÅDE webbens detaljpanel och hyresgästportalen behöver
   * samma svar på samma fråga. Två härledningar av "vilken version gäller" hade
   * varit två tillfällen att svara olika.
   */
  async hamtaVersioner(id: string, orgId: string): Promise<VersionsLank<VersionsRad>[]> {
    return ordnaKedja(await this.hamtaKedja(this.prisma, id, orgId))
  }

  /**
   * Skapar en länkad rättelseversion av ett slutfört protokoll.
   *
   * ── VAD SOM ALDRIG HÄNDER HÄR ─────────────────────────────────────────────
   *
   * Originalet skrivs inte. Inte en kolumn, inte en post, inte en bild, inte
   * dess `signedAt` eller `signedContentHash`. Rättelsen är en NY rad; att den
   * finns ändrar ingenting om den gamla annat än att den gamla nu har en
   * efterföljare. Det är hela skillnaden mot att "låsa upp och redigera".
   *
   * Lagringsobjekten rörs inte heller: bildraderna KOPIERAS med samma
   * `storageKey` och samma `contentSha256`. Ingen fil laddas upp igen och ingen
   * fil raderas. Två rader som pekar på samma objekt är avsiktligt — objektet är
   * oförändrat, och det är just det digesten ska kunna visa.
   *
   * ── SAMTIDIGHET: TVÅ SPÄRRAR, INTE EN ────────────────────────────────────
   *
   * Radlåset på KÄLLAN serialiserar två samtidiga rättelseförsök. Det unika
   * villkoret på `correctionOfId` GARANTERAR utfallet. Låset räcker inom en
   * databas, men villkoret räcker även om en framtida skrivväg glömmer låset —
   * och det är den ordningen garantier ska staplas i.
   *
   * ── GAMMAL KLIENTVY ───────────────────────────────────────────────────────
   *
   * `expectedContentHash` jämförs under låset mot innehållet som det faktiskt
   * står, med samma funktion signeringen använder. Den som rättar ett protokoll
   * hen inte sett hela fälls — annars hade rättelsens orsak beskrivit en version
   * som inte längre fanns.
   *
   * ── DEPOSITIONEN RÖRS INTE, OCH DET SÄGS UT ───────────────────────────────
   *
   * Ett beslutat avdrag är bokfört: `Deposit.deductions` har ett verifikat bakom
   * sig (`createJournalEntryForDepositRefund`). Att låta en protokollrättelse
   * räkna om det hade varit att ändra bokförd räkenskapsinformation som en
   * sidoeffekt av en textändring. Rättelsen läser depositionen och VARNAR;
   * den skriver aldrig. Åtgärden är en egen, medveten handling i
   * depositionsvyn.
   */
  async skapaRattelse(
    id: string,
    dto: CreateInspectionCorrectionDto,
    orgId: string,
    userId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Låset tas FÖRE läsningen, av samma skäl som i `lockAndAssertUnsigned`:
      // annars läses ett värde som hinner bli inaktuellt.
      await tx.$queryRaw`SELECT id FROM "Inspection" WHERE id = ${id} AND "organizationId" = ${orgId} FOR UPDATE`

      const kalla = await tx.inspection.findFirst({
        where: { id, organizationId: orgId },
        include: FULL_INCLUDE,
      })
      if (!kalla) throw new NotFoundException('Besiktning hittades inte')

      // Bara ett SLUTFÖRT protokoll kan rättas. Ett utkast ändras på plats —
      // att ge det en rättelseversion hade skapat en kedja av halvfärdiga
      // protokoll där ingen någonsin varit gällande.
      if (!arSlutford(kalla)) {
        throw new ConflictException(
          'Bara ett slutfört eller signerat protokoll kan rättas. Ett pågående protokoll ändras direkt.',
        )
      }

      if (computeSignedContentHash(kalla) !== dto.expectedContentHash) {
        throw new ConflictException(
          'Protokollet har ändrats sedan du läste det. Läs om besiktningen, granska ändringen och skapa rättelsen därefter — ingen rättelse har skapats.',
        )
      }

      // Läst under låset. Det unika villkoret nedan är garantin; den här
      // kontrollen finns för att felmeddelandet ska säga VAD som hänt i stället
      // för att läcka ett databasfel.
      if (kalla.correction) {
        throw new ConflictException(
          `Den här versionen är redan rättad (version ${kalla.correction.version}). Rätta den senaste versionen i stället.`,
        )
      }

      const nu = new Date()
      let skapad
      try {
        skapad = await tx.inspection.create({
          data: {
            organizationId: kalla.organizationId,
            propertyId: kalla.propertyId,
            unitId: kalla.unitId,
            leaseId: kalla.leaseId,
            tenantId: kalla.tenantId,
            // Vem som UTFÖRDE besiktningen bärs över — det är samma besiktning,
            // rättad. Vem som RÄTTADE står i `correctedById` nedan, och de två
            // ska inte gå att blanda ihop.
            inspectedById: kalla.inspectedById,
            type: kalla.type,
            scheduledDate: kalla.scheduledDate,
            overallCondition: kalla.overallCondition,
            notes: kalla.notes,

            // UTKAST. Ingen `completedAt`, ingen `signedAt`, ingen
            // `signedContentHash` och inga signaturnamn: den nya versionen har
            // inte slutförts och får inte se ut som om den hade det.
            status: InspectionStatus.IN_PROGRESS,

            version: kalla.version + 1,
            correctionOfId: kalla.id,
            correctionReason: dto.orsak,
            correctedById: userId,
            correctedAt: nu,

            items: {
              create: kalla.items.map((post) => ({
                room: post.room,
                item: post.item,
                condition: post.condition,
                notes: post.notes,
                repairCost: post.repairCost,
              })),
            },
            images: {
              create: kalla.images.map((bild) => ({
                filename: bild.filename,
                // SAMMA nyckel och SAMMA digest. Originalets fil bevaras och
                // kopieras inte — objektet är oförändrat, och digesten ska
                // fortsätta beskriva exakt det objektet.
                storageKey: bild.storageKey,
                storageUrl: bild.storageUrl,
                caption: bild.caption,
                room: bild.room,
                size: bild.size,
                contentSha256: bild.contentSha256,
              })),
            },
          },
          include: FULL_INCLUDE,
        })
      } catch (fel) {
        // P2002 = det unika villkoret på `correctionOfId`. Den här grenen nås
        // när två transaktioner tagit sig förbi kontrollen ovan — alltså exakt
        // det fall låset ensamt inte kan utesluta.
        if (fel instanceof Prisma.PrismaClientKnownRequestError && fel.code === 'P2002') {
          throw new ConflictException(
            'En rättelse av den här versionen skapades precis av någon annan. Läs om besiktningen och utgå från den senaste versionen.',
          )
        }
        throw fel
      }

      return {
        ...this.medContentHash(skapad),
        rattelseAv: {
          id: kalla.id,
          version: kalla.version,
          status: kalla.status,
          signedAt: kalla.signedAt,
        },
        // LÄST, INTE SKRIVET. Se metodens huvud.
        depositionsvarning: await this.depositionsvarning(tx, kalla.leaseId, orgId),
      }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * Upplysning om att protokollet som rättas redan ligger bakom ett beslutat
   * depositionsavdrag eller en genomförd återbetalning.
   *
   * Returnerar `null` när det inte finns något att upplysa om — inte ett objekt
   * med nollor. Skillnaden syns i gränssnittet: en ruta som alltid visas med
   * "0 kr i avdrag" lär användaren att inte läsa den.
   *
   * Tjänsten SKRIVER aldrig något här. Den enda vägen som ändrar ett avdrag är
   * `DepositsService.refund`, och den ska förbli det.
   */
  private async depositionsvarning(
    db: Prisma.TransactionClient | PrismaService,
    leaseId: string | null,
    orgId: string,
  ): Promise<{
    depositId: string
    status: string
    avdragAntal: number
    refundAmount: string | null
    refundedAt: Date | null
  } | null> {
    if (!leaseId) return null

    const deposition = await db.deposit.findFirst({
      where: { leaseId, organizationId: orgId },
      select: {
        id: true,
        status: true,
        deductions: true,
        refundAmount: true,
        refundedAt: true,
      },
    })
    if (!deposition) return null

    const avdrag = Array.isArray(deposition.deductions) ? deposition.deductions.length : 0
    const reglerad = deposition.refundedAt !== null
    if (avdrag === 0 && !reglerad) return null

    return {
      depositId: deposition.id,
      status: deposition.status,
      avdragAntal: avdrag,
      refundAmount: deposition.refundAmount ? deposition.refundAmount.toFixed(2) : null,
      refundedAt: deposition.refundedAt,
    }
  }

  // ══ BILDKONTROLL ══════════════════════════════════════════════════════════

  /**
   * Läser tillbaka varje bilagas bytes ur lagringen och jämför med den lagrade
   * digesten.
   *
   * Det här är kontrollen `InspectionImage.contentSha256` skrevs för och som
   * kolumnens egen kommentar sa saknades: "ingen kod läser i dag tillbaka
   * objektet ur lagringen för att jämföra".
   *
   * Den ligger BAKOM en egen endpoint och inte i `findOne`, därför att den
   * kostar en nätverkshämtning per bilaga. En lista som tyst hämtade hundra
   * objekt ur R2 för att rita en badge hade varit en mätning ingen bett om.
   * Den körs alltså när någon faktiskt vill veta, och vid PDF-export.
   */
  async kontrolleraBilder(
    id: string,
    orgId: string,
  ): Promise<{
    inspectionId: string
    sammanfattning: BildkontrollUtfall | 'INGA_BILDER'
    kontrolleradAt: Date
    bilder: Bildkontroll[]
  }> {
    const besiktning = await this.prisma.inspection.findFirst({
      where: { id, organizationId: orgId },
      select: {
        id: true,
        images: { select: { id: true, filename: true, storageKey: true, contentSha256: true } },
      },
    })
    if (!besiktning) throw new NotFoundException('Besiktning hittades inte')

    const bilder = await this.bildkontroll.kontrolleraBilder(besiktning.images)
    return {
      inspectionId: besiktning.id,
      sammanfattning: this.bildkontroll.sammanfatta(bilder),
      kontrolleradAt: new Date(),
      bilder,
    }
  }

  async delete(id: string, orgId: string) {
    return this.prisma.$transaction(async (tx) => {
      // `onDelete: Cascade` tar poster OCH bilder med sig. Att radera en
      // signerad besiktning är därför inte en mildare variant av att ändra den
      // — det är att utplåna hela beviset, och till skillnad från en ändring
      // lämnar det ingenting kvar att jämföra med.
      await this.lockAndAssertUnsigned(tx, id, orgId)

      // ── EN VERSION MED EFTERFÖLJARE RADERAS INTE ────────────────────────
      //
      // Främmande nyckeln (`NO ACTION`) fäller redan den här raderingen i
      // databasen. Kontrollen finns ändå, av två skäl: felet blir ett begripligt
      // 409 i stället för ett rått databasfel, och kedjans invariant blir
      // LÄSBAR på det ställe den gäller. Att ett skydd finns två gånger är
      // billigare än att den som läser tjänsten måste gissa att det finns alls.
      //
      // Konsekvensen är avsiktlig: ett utkast till rättelse går att kasta, men
      // en version som någon HAR rättat går inte att radera under rättelsen.
      const efterfoljare = await tx.inspection.findFirst({
        where: { correctionOfId: id, organizationId: orgId },
        select: { id: true, version: true },
      })
      if (efterfoljare) {
        throw new ConflictException(
          `Besiktningen har en rättelseversion (version ${efterfoljare.version}) och kan inte raderas. Ta bort rättelsen först.`,
        )
      }

      return tx.inspection.delete({ where: { id } })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * ── `doljUtkast` FINNS FÖR HYRESGÄSTEN, INTE FÖR BEKVÄMLIGHET ─────────────
   *
   * Versionstabellen nedan ritas ur HELA kedjan, och kedjan innehåller
   * pågående rättelser. För hyresvärden är det rätt: att se att en rättelse är
   * påbörjad är en uppgift hen ska ha.
   *
   * För hyresgästen är det en läcka. Portalen filtrerar bort utkast ur sina
   * listor och sin detaljvy — men PDF:en renderades av samma metod och hade
   * burit utkastets versionsnummer OCH dess orsakstext rakt ut till motparten,
   * alltså hyresvärdens ofärdiga bedömning av en skada. Att spärren satt i tre
   * vyer men inte i den fjärde är den vanligaste formen: den väg som inte
   * byggdes för hyresgästen var den som släppte igenom.
   *
   * Flaggan är `false` som default. En spärr som måste slås PÅ glöms av den som
   * inte vet att den finns; den här ska slås på av precis en anropare, och den
   * anroparen är `TenantPortalService.getInspectionPdf`.
   */
  async generateProtocolPdf(
    id: string,
    orgId: string,
    val: { doljUtkast?: boolean } = {},
  ): Promise<Buffer> {
    const hamtad = await this.findOne(id, orgId)
    const inspection = val.doljUtkast
      ? { ...hamtad, versioner: hamtad.versioner.filter((v) => !v.arUtkast) }
      : hamtad
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    // ── EXPORTEN ÄR EN "RELEVANT VISNING", OCH DÄRFÖR KONTROLLERAS BILAGORNA ──
    //
    // PDF:en är det protokollet lämnas ut SOM — till hyresgästen, till en
    // motpart, till en hyresnämnd. Att exportera en bilageförteckning utan att
    // ha läst bilagorna hade varit att intyga något ingen kontrollerat.
    //
    // Kontrollen sker HÄR och inte i `findOne`, därför att exporten redan är en
    // tung, avsiktlig handling — en extra läsning per bilaga syns inte i den,
    // medan samma läsning i varje detaljvy hade gjort visningen dyr.
    const bildutfall = await this.bildkontroll.kontrolleraBilder(inspection.images)
    const bildsammanfattning = this.bildkontroll.sammanfatta(bildutfall)

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
                font-size: 12px; color: #6b7280; }
    .version-block { margin: 32px 0; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; }
    .block-title { font-size: 15px; font-weight: 700; color: ${brandColor}; margin-bottom: 12px; }
    .version-status { font-size: 13px; margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; }
    .version-status.gallande { background: #ecfdf5; color: #065f46; }
    .version-status.ersatt { background: #fef3c7; color: #92400e; }
    .block-note { font-size: 11px; color: #6b7280; margin-top: 12px; line-height: 1.5; }`

    // ── VILKEN VERSION DEN HÄR UTSKRIFTEN ÄR ──────────────────────────────
    //
    // Blocket ritas bara när det finns mer än en version. Ett original som
    // aldrig rättats ska inte bära en rubrik om rättelser — en tom sektion lär
    // läsaren att hoppa över den, och då missas den dagen den betyder något.
    //
    // Att utskriften säger om den är GÄLLANDE är hela poängen: en PDF vandrar
    // vidare utan sitt sammanhang, och en rättad version som ser ut som ett
    // giltigt protokoll är värre än inget protokoll.
    const versionHtml =
      inspection.versioner.length > 1
        ? `
  <div class="version-block">
    <div class="block-title">Versioner och rättelser</div>
    <div class="version-status ${inspection.arGallande ? 'gallande' : 'ersatt'}">
      ${
        inspection.arGallande
          ? `Denna utskrift är version ${inspection.version} och är den gällande versionen.`
          : inspection.arUtkast
            ? `Denna utskrift är version ${inspection.version} och är ett UTKAST som ännu inte slutförts. Den gäller inte.`
            : `Denna utskrift är version ${inspection.version} och har ersatts av en senare version.`
      }
    </div>
    <table class="items-table">
      <thead>
        <tr><th>Version</th><th>Status</th><th>Rättelsedatum</th><th>Orsak</th></tr>
      </thead>
      <tbody>
        ${inspection.versioner
          .map(
            (v) => `
        <tr>
          <td>${v.version}${v.arGallande ? ' (gäller)' : ''}${v.arUtkast ? ' (utkast)' : ''}</td>
          <td>${escapeHtml(v.status)}</td>
          <td>${v.correctedAt ? formatDateStr(v.correctedAt) : '—'}</td>
          <td>${v.correctionReason ? escapeHtml(v.correctionReason) : '—'}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`
        : ''

    // ── BILAGORNA OCH VAD KONTROLLEN FAKTISKT VISADE ──────────────────────
    //
    // Fyra utfall, fyra texter. Ordet "verifierad" står BARA där bytena lästes
    // och digesten stämde. En bilaga utan lagrad digest får sin egen rad som
    // säger att kontroll inte är möjlig — inte ett kryss, inte ett kors.
    const bilagetext: Record<string, string> = {
      VERIFIERAD: 'Verifierad — innehållet är oförändrat sedan uppladdningen',
      AVVIKANDE: 'AVVIKER — innehållet är INTE detsamma som vid uppladdningen',
      SAKNAS: 'Kunde inte läsas ur lagringen — innehållet är okänt',
      DIGEST_SAKNAS:
        'Ingen digest lagrad (uppladdad före kontrollen fanns) — kan inte kontrolleras',
    }
    const bilagefarg: Record<string, string> = {
      VERIFIERAD: '#059669',
      AVVIKANDE: '#DC2626',
      SAKNAS: '#D97706',
      DIGEST_SAKNAS: '#6b7280',
    }
    const bilageHtml =
      bildutfall.length > 0
        ? `
  <div class="version-block">
    <div class="block-title">Bilagor — integritetskontroll</div>
    <div class="version-status ${bildsammanfattning === 'VERIFIERAD' ? 'gallande' : 'ersatt'}">
      Kontrollen utfördes ${formatDateStr(new Date())} genom att varje bilagas
      innehåll lästes tillbaka ur lagringen och jämfördes med den digest som
      sparades vid uppladdningen. Sammantaget utfall: ${escapeHtml(bildsammanfattning)}.
    </div>
    <table class="items-table">
      <thead><tr><th>Filnamn</th><th>Utfall</th></tr></thead>
      <tbody>
        ${bildutfall
          .map(
            (b) => `
        <tr>
          <td>${escapeHtml(b.filename)}</td>
          <td style="color:${bilagefarg[b.utfall] ?? '#6b7280'};font-weight:600">${escapeHtml(bilagetext[b.utfall] ?? b.utfall)}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <div class="block-note">
      Kontrollen visar om innehållet ändrats. Den säger ingenting om vem som
      laddade upp bilagan eller vem som eventuellt ändrat den, och den är ingen
      utfästelse om att lagringen är oföränderlig.
    </div>
  </div>`
        : ''

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

  ${versionHtml}

  ${bilageHtml}

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
