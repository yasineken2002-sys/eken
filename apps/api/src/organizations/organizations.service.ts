import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { UserRole } from '@prisma/client'

import { DelegationService } from '../ai/delegation/delegation.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { SAFE_ORGANIZATION_SELECT } from './organization-select'
import { StorageService } from '../storage/storage.service'
import { UpdateOrganizationDto } from './dto/update-organization.dto'
import {
  validateUploadedFile,
  extensionForDetectedMime,
  DETECTED_WEB_IMAGE_TYPES,
  MAX_LOGO_BYTES,
} from '../common/utils/file-validation'

interface MultipartFile {
  toBuffer(): Promise<Buffer>
}

/**
 * ROLLER SOM FÅR SLÅ PÅ SKUGGAGENTEN.
 *
 * Bara ägaren. `PATCH /organizations/me` är i övrigt ADMIN + OWNER, och det ska
 * den förbli — men att ge en maskin rätt att föreslå åtgärder på hyresgästernas
 * ärenden är ett ägarbeslut, inte en inställning bland andra.
 */
const FAR_SLA_PA_SKUGGAGENT: readonly UserRole[] = ['OWNER']

/**
 * Vem som får slå på SKARPT LÄGE — att agenten utför delegerade åtgärder själv.
 *
 * EGEN lista trots samma värde som ovan, av samma skäl som
 * `FAR_ANDRA_VASENTLIGHETSGRANS`: två gränser som ska kunna ändras var för sig
 * är inte en gräns. Och de här två är olika beslut i sak — det ena låter en
 * maskin FÖRESLÅ, det andra låter den HANDLA.
 */
const FAR_SLA_PA_SKARPT_LAGE: readonly UserRole[] = ['OWNER']

/**
 * Vem som får ändra väsentlighetsgränsen för sen bokföring.
 *
 * EGEN lista trots samma värde som ovan. De två svarar på olika frågor — "får
 * slå på en agent" och "får bestämma vad en revisor ser i efterhand" — och två
 * gränser som ska kunna ändras var för sig är inte en gräns.
 */
const FAR_ANDRA_VASENTLIGHETSGRANS: readonly UserRole[] = ['OWNER']

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    /**
     * DELEGATIONERNA, för att kunna PAUSA dem när skuggan stängs av.
     *
     * Beroendet går åt det här hållet med flit: organisationens växel är
     * orsaken, pausen är följden. Att i stället låta delegationstjänsten läsa
     * flaggan hade gjort varje `assertDelegated` beroende av en extra fråga, och
     * invarianten hade blivit något som kontrolleras vid varje användning i
     * stället för att upprättas en gång.
     */
    private readonly delegations: DelegationService,
  ) {}

  // Returtypen härleds UR SELECTEN (`OrganizationGetPayload`), inte skrivs
  // separat. Då snävas typen i takt med queryn: läser en anropare ett fält som
  // lyfts ur selecten faller `pnpm typecheck`, i stället för att fältet tyst blir
  // `undefined` i runtime. Samma mekanik som avslöjade fyra vägar i #349.
  async findMyOrganization(
    organizationId: string,
  ): Promise<Prisma.OrganizationGetPayload<{ select: typeof SAFE_ORGANIZATION_SELECT }>> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      // Prenumerations- och faktureringsblocket lämnar inte den här endpointen.
      // Se organization-select.ts för hela resonemanget.
      select: SAFE_ORGANIZATION_SELECT,
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    // logoStorageUrl i databasen är en presignerad R2-URL från upload-tillfället
    // (TTL 1h) och blir därför stale. Skriv över med en färsk presigned URL
    // varje gång org:t hämtas så att <img src> i settings/PDF-genereringen
    // alltid funkar oavsett när logon laddades upp.
    if (org.logoStorageKey) {
      try {
        return { ...org, logoStorageUrl: await this.storage.getPresignedUrl(org.logoStorageKey) }
      } catch {
        // Faller tillbaka på lagrad URL om R2 är otillgängligt — bättre att
        // visa en eventuellt utgången URL än att hela settings-sidan kraschar.
        return org
      }
    }
    return org
  }

  async update(
    organizationId: string,
    dto: UpdateOrganizationDto,
    /**
     * Anroparens roll. VALFRI med flit: befintliga anropare (och prov) som inte
     * rör `shadowAgentEnabled` ska inte behöva ändras. Utelämnas den OCH fältet
     * sätts, faller det stängt — se nedan.
     */
    rollHosAnroparen?: UserRole,
  ) {
    // ── FÄLTNIVÅGRIND ─────────────────────────────────────────────────────
    //
    // FAIL-CLOSED: en anropare som inte lämnat sin roll får inte sätta fältet.
    // Alternativet — att låta ett `undefined` passera — hade gjort grinden
    // beroende av att varje framtida anropare kommer ihåg att skicka rollen,
    // och den sortens spärr slutar gälla tyst.
    if (dto.shadowAgentEnabled !== undefined) {
      if (!rollHosAnroparen || !FAR_SLA_PA_SKUGGAGENT.includes(rollHosAnroparen)) {
        throw new ForbiddenException('Bara organisationens ägare får slå på eller av skuggagenten.')
      }
    }

    // ── SKARPT LÄGE: SAMMA FÄLTNIVÅGRIND, SAMMA FAIL-CLOSED ────────────────
    if (dto.agentExecutionEnabled !== undefined) {
      if (!rollHosAnroparen || !FAR_SLA_PA_SKARPT_LAGE.includes(rollHosAnroparen)) {
        throw new ForbiddenException(
          'Bara organisationens ägare får slå på eller av att agenten utför åtgärder själv.',
        )
      }
    }

    // ── INVARIANTEN: SKARPT LÄGE KRÄVER SKUGGAN ───────────────────────────
    //
    // Läses ur DATABASEN och inte bara ur nyttolasten. Slås bara skarpt läge på,
    // utan att `shadowAgentEnabled` nämns i samma anrop, är det lagrade värdet
    // det enda som säger något — och en kontroll som bara tittar på DTO:t hade
    // släppt igenom exakt det anropet.
    //
    // Båda i samma anrop hanteras också: `dto.shadowAgentEnabled` vinner över
    // det lagrade värdet, eftersom det är det som gäller efter skrivningen.
    const nuvarande = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { shadowAgentEnabled: true, agentExecutionEnabled: true },
    })
    if (!nuvarande) throw new NotFoundException('Organisationen hittades inte')

    const skuggaEfter = dto.shadowAgentEnabled ?? nuvarande.shadowAgentEnabled
    if (dto.agentExecutionEnabled === true && !skuggaEfter) {
      throw new BadRequestException(
        'Skarpt läge kräver att skuggagenten är på. Agenten kan inte utföra något den ' +
          'inte har föreslagit.',
      )
    }

    // ── SKUGGAN AV ⇒ SKARPT LÄGE MED, OCH DELEGATIONERNA PAUSAS ───────────
    //
    // Att stänga av skuggan och lämna utförandet på hade varit ett tillstånd där
    // agenten handlar utan att någon längre ser vad den föreslår. Följdändringen
    // görs därför HÄR och inte som en förväntan på läsytan.
    //
    // PAUSAD och inte återkallad: att stänga av en växel är inte att ta tillbaka
    // en rättighet. Hyresvärden som slår på den igen ska få tillbaka det hen gav.
    // Historiken visar att pausen var SYSTEMETS — se `pausaAlla`.
    const stängerAvSkuggan = dto.shadowAgentEnabled === false && nuvarande.shadowAgentEnabled
    const skarptEfter = stängerAvSkuggan ? false : (dto.agentExecutionEnabled ?? undefined)
    if (stängerAvSkuggan && nuvarande.agentExecutionEnabled) {
      await this.delegations.pausaAlla(organizationId)
    }

    // SAMMA FÄLTNIVÅGRIND, samma fail-closed. Väsentlighetsgränsen avgör vilka
    // sent bokförda poster en revisor får syn på i efterhand — den hör till
    // samma familj av beslut som att slå på en agent, inte till förvaltningen.
    // Att den delar rollista med skuggagenten är ett sammanträffande i värde,
    // inte i sak, och listan är därför EGEN: de två ska kunna glida isär.
    if (dto.lateBookingMaterialityThreshold !== undefined) {
      if (!rollHosAnroparen || !FAR_ANDRA_VASENTLIGHETSGRANS.includes(rollHosAnroparen)) {
        throw new ForbiddenException(
          'Bara organisationens ägare får ändra väsentlighetsgränsen för sen bokföring.',
        )
      }
    }

    // F-skatt-datum: bara meningsfullt när hasFSkatt = true. Om
    // användaren bockar av F-skatt nollställer vi datumet samtidigt.
    const fSkattDateUpdate = (() => {
      if (dto.hasFSkatt === false) return { fSkattApprovedDate: null }
      if (dto.fSkattApprovedDate != null) {
        return { fSkattApprovedDate: new Date(dto.fSkattApprovedDate) }
      }
      return {}
    })()

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(dto.lateBookingMaterialityThreshold != null
          ? { lateBookingMaterialityThreshold: dto.lateBookingMaterialityThreshold }
          : {}),
        ...(dto.bankgiro != null ? { bankgiro: dto.bankgiro } : {}),
        ...(dto.paymentTermsDays != null ? { paymentTermsDays: dto.paymentTermsDays } : {}),
        ...(dto.invoiceColor != null ? { invoiceColor: dto.invoiceColor } : {}),
        ...(dto.invoiceTemplate != null ? { invoiceTemplate: dto.invoiceTemplate } : {}),
        ...(dto.brandFont != null ? { brandFont: dto.brandFont } : {}),
        ...(dto.brandSecondaryColor != null
          ? { brandSecondaryColor: dto.brandSecondaryColor }
          : {}),
        ...(dto.morningReportEnabled != null
          ? { morningReportEnabled: dto.morningReportEnabled }
          : {}),
        ...(dto.shadowAgentEnabled != null ? { shadowAgentEnabled: dto.shadowAgentEnabled } : {}),
        ...(skarptEfter !== undefined ? { agentExecutionEnabled: skarptEfter } : {}),
        ...(dto.remindersEnabled != null ? { remindersEnabled: dto.remindersEnabled } : {}),
        ...(dto.reminderFeeSek != null ? { reminderFeeSek: dto.reminderFeeSek } : {}),
        ...(dto.reminderFormalDay != null ? { reminderFormalDay: dto.reminderFormalDay } : {}),
        ...(dto.reminderCollectionDay != null
          ? { reminderCollectionDay: dto.reminderCollectionDay }
          : {}),
        ...(dto.collectionAgencyName != null
          ? { collectionAgencyName: dto.collectionAgencyName }
          : {}),
        ...(dto.hasFSkatt != null ? { hasFSkatt: dto.hasFSkatt } : {}),
        ...fSkattDateUpdate,
        ...(dto.vatNumber != null ? { vatNumber: dto.vatNumber } : {}),
        ...(dto.vatReportingPeriod != null ? { vatReportingPeriod: dto.vatReportingPeriod } : {}),
        ...(dto.daysBeforeMoveInForFirstPayment != null
          ? { daysBeforeMoveInForFirstPayment: dto.daysBeforeMoveInForFirstPayment }
          : {}),
        ...(dto.maxBankTxAmount != null ? { maxBankTxAmount: dto.maxBankTxAmount } : {}),
      },
    })
  }

  async uploadLogo(organizationId: string, file: MultipartFile) {
    // SECURITY (H3): buffra FÖRST, validera sedan mot innehållet. Den gamla
    // koden avgjorde både typ och filändelse på `file.mimetype` — en header
    // klienten sätter själv — så en omdöpt .svg eller .html blev
    // organisationens logotyp och renderades sedan i fakturor och PDF:er.
    const buffer = await file.toBuffer()
    const detected = validateUploadedFile(buffer, {
      allowedDetectedMimes: DETECTED_WEB_IMAGE_TYPES,
      maxBytes: MAX_LOGO_BYTES,
    })

    // Ändelsen (och därmed nyckeln) följer den validerade typen.
    const storageKey = `logos/${organizationId}.${extensionForDetectedMime(detected)}`

    const existing = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoStorageKey: true },
    })
    if (existing?.logoStorageKey && existing.logoStorageKey !== storageKey) {
      await this.storage.deleteFile(existing.logoStorageKey)
    }

    const storageUrl = await this.storage.uploadFile(buffer, storageKey, detected ?? 'image/png')

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoStorageKey: storageKey, logoStorageUrl: storageUrl },
    })

    // Returnera samma färska URL som findMyOrganization annars genererar — så
    // att frontend kan visa logon direkt efter upload utan att behöva göra
    // en extra refetch först.
    return { ...updated, logoStorageUrl: await this.storage.getPresignedUrl(storageKey) }
  }
}
