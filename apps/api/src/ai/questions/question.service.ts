import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { upsertAiMemoryWithSubjects } from '../../common/ai-subjects/ai-subject-writer'

import { Prisma } from '@prisma/client'
import { FRAGEBARA_FALT, ärGiltigFråga, type FragansInnehall } from './question-fields'

/** Hur länge en fråga står öppen innan den förfaller. */
const FRAGANS_FRIST_DAGAR = 7

/** Minnesnyckelns form. EN plats, läst av både skrivningen och uppslaget. */
export function svarsNyckel(sourceKind: string, sourceId: string, fält: string): string {
  return `svar:${sourceKind}:${sourceId}:${fält}`
}

export type FragaUtfall =
  | { utfall: 'STÄLLD'; assignmentId: string }
  | { utfall: 'REDAN_ÖPPEN' }
  | { utfall: 'REDAN_BESVARAD'; svar: string }
  | { utfall: 'OGILTIG'; skäl: string }

/**
 * AGENTENS FRÅGOR — planens *"den frågar innan du frågar"*.
 *
 * ── EN FRÅGA ÄR INTE ETT FÖRSLAG MED LÅG KONFIDENS ──────────────────────────
 *
 * Skuggagenten hade två utfall: ett förslag, eller ingen åtgärd. Var den osäker
 * föreslog den ändå, med lägre konfidens — den GISSADE. Skillnaden mot en fråga
 * är inte grad utan art: konfidens är hur säker agenten är på sin BEDÖMNING, en
 * fråga ställs när en UPPGIFT saknas och ingen bedömning kan göras.
 *
 * Den skillnaden är hela poängen. Låg konfidens som utlösare hade gjort frågan
 * till en utväg vid varje tveksamhet, och planens Del 11 kräver motsatsen: varje
 * fråga måste låsa upp något.
 *
 * ── FRÅGOR KOSTAR UPPMÄRKSAMHET, OCH BUDGETEN ÄR MEKANISK ──────────────────
 *
 * 1. HÖGST EN öppen fråga per ärende. Två frågor om samma ärende är inte två
 *    frågor för den som svarar — det är en hög.
 * 2. INGEN fråga vars svar redan finns bekräftat. Att fråga om något
 *    hyresvärden redan svarat på är det snabbaste sättet att lära någon att
 *    ignorera inkorgen.
 *
 * Båda är spärrar i den här tjänsten, inte råd i en prompt: en modell som ombeds
 * låta bli frågar ändå ibland, och då är budgeten en förhoppning.
 *
 * ── SVARET BLIR MINNE MED KÄLLA ────────────────────────────────────────────
 *
 * Ett svar skrivs som en `HUMAN_CONFIRMED`-post med `sourceKind: 'ASSIGNMENT'`
 * och frågans id — alltså den enda vägen utöver "Bekräfta" på ett antagande som
 * ger en minnespost en grund. Nästa förslag i samma ärende läser den.
 */
@Injectable()
export class QuestionService {
  private readonly logger = new Logger(QuestionService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finns redan ett bekräftat svar för (källa, fält)?
   *
   * Uppslaget är det som gör frågebudgeten verklig. Tas det bort ställs frågan
   * om varje gång ärendet passerar sveparen — se negativkontrollen.
   */
  async befintligtSvar(
    organizationId: string,
    sourceKind: string,
    sourceId: string,
    fält: string,
  ): Promise<string | null> {
    const rad = await this.prisma.aiMemory.findFirst({
      where: {
        organizationId,
        key: svarsNyckel(sourceKind, sourceId, fält),
        provenanceKind: 'HUMAN_CONFIRMED',
        rejectedAt: null,
      },
      select: { value: true },
    })
    return rad?.value ?? null
  }

  /**
   * Ställ en fråga om ett ärende.
   *
   * @param assignedToUserId mottagaren; frågan är ett uppdrag som väntar på
   *   någon, precis som ett förslag.
   */
  async ställ(
    organizationId: string,
    opts: {
      toolName: string
      sourceKind: string
      sourceId: string
      assignedToUserId: string
      fråga: FragansInnehall
      text: string
      /** Modellens gissning trots frågan — bevarar träffgradens nämnare. */
      prediction?: Record<string, unknown>
      propertyId?: string | null
      unitId?: string | null
      tenantId?: string | null
      /**
       * De lagliga värdena för ett DYNAMISKT frågefält
       * (`assignedContractorId`). Utelämnas den kan en fråga om det fältet inte
       * skapas — fail-closed, se `ärGiltigFråga`.
       */
      dynamisktRegister?: readonly string[]
    },
    nu: Date = new Date(),
  ): Promise<FragaUtfall> {
    if (!ärGiltigFråga(opts.fråga, opts.dynamisktRegister)) {
      // FAIL-CLOSED. En fråga som inte går att svara strukturerat på är inte en
      // fråga — den är fritext, och då kan svaret varken jämföras eller lagras
      // maskinläsbart.
      return { utfall: 'OGILTIG', skäl: 'Frågan saknar fält, giltiga alternativ eller nytta.' }
    }

    const svar = await this.befintligtSvar(
      organizationId,
      opts.sourceKind,
      opts.sourceId,
      opts.fråga.fält,
    )
    if (svar !== null) return { utfall: 'REDAN_BESVARAD', svar }

    // HÖGST EN ÖPPEN FRÅGA PER ÄRENDE — oavsett fält.
    const öppen = await this.prisma.aiAssignment.findFirst({
      where: {
        organizationId,
        kind: 'QUESTION',
        status: 'AWAITING_APPROVAL',
        sourceKind: opts.sourceKind,
        sourceId: opts.sourceId,
      },
      select: { id: true },
    })
    if (öppen) return { utfall: 'REDAN_ÖPPEN' }

    const rad = await this.prisma.aiAssignment.create({
      data: {
        organizationId,
        kind: 'QUESTION',
        // INTE `shadow`: ett svar på en fråga ÄR en effekt — det skriver en
        // minnespost som styr nästa förslag.
        shadow: false,
        toolName: opts.toolName,
        toolInput: { ...opts.fråga },
        ...(opts.prediction && Object.keys(opts.prediction).length > 0
          ? { prediction: opts.prediction as Prisma.InputJsonObject }
          : {}),
        sourceKind: opts.sourceKind,
        sourceId: opts.sourceId,
        title: opts.text,
        reasoning: opts.fråga.användsTill,
        consequence:
          'Ditt svar sparas som en bekräftad uppgift om det här ärendet och används av ' +
          'agentens nästa förslag. Ingenting utförs av att du svarar.',
        undoHint: 'Svaret går att ändra genom att avvisa uppgiften på sidan Delegationer.',
        deadline: new Date(nu.getTime() + FRAGANS_FRIST_DAGAR * 24 * 60 * 60 * 1000),
        assignedToUserId: opts.assignedToUserId,
        ...(opts.propertyId ? { propertyId: opts.propertyId } : {}),
        ...(opts.unitId ? { unitId: opts.unitId } : {}),
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
      select: { id: true },
    })
    this.logger.log(`[ai-fraga] ${organizationId}: ${opts.sourceId}/${opts.fråga.fält} → ${rad.id}`)
    return { utfall: 'STÄLLD', assignmentId: rad.id }
  }

  /**
   * SVARA på en fråga. Skriver minnesposten och stänger uppdraget.
   *
   * Anspråket är atomärt (`updateMany` på `AWAITING_APPROVAL`): ett andra svar
   * på samma fråga ska inte kunna skriva om minnet med en ny tidsstämpel. Samma
   * form som `consumePendingAction` och `bekräfta`.
   */
  async svara(
    organizationId: string,
    assignmentId: string,
    userId: string,
    svar: string,
    nu: Date = new Date(),
  ): Promise<void> {
    const fråga = await this.prisma.aiAssignment.findFirst({
      where: { id: assignmentId, organizationId, kind: 'QUESTION' },
      select: { id: true, toolInput: true, sourceKind: true, sourceId: true },
    })
    if (!fråga) throw new NotFoundException('Frågan hittades inte.')

    const innehåll = fråga.toolInput as unknown
    // ── DEN LAGRADE FRÅGANS EGNA ALTERNATIV ÄR REGISTRET HÄR ──────────────
    //
    // Vid SVARSTILLFÄLLET prövas formen, inte mängden på nytt. Skälet är att
    // det dynamiska registret kan ha ÄNDRATS sedan frågan ställdes — en
    // hantverkare kan ha avaktiverats — och att då avvisa svaret hade straffat
    // hyresvärden för något systemet gjorde. Frågan var giltig när den ställdes,
    // och det är dess egna alternativ som gäller.
    //
    // Mängden prövas ändå, en rad ned: `innehåll.alternativ.includes(svar)` är
    // den bärande grinden, och den läser exakt de värden hyresvärden fick se.
    const lagrade =
      typeof innehåll === 'object' && innehåll !== null
        ? ((innehåll as Record<string, unknown>)['alternativ'] as string[] | undefined)
        : undefined
    if (!ärGiltigFråga(innehåll, lagrade)) {
      throw new BadRequestException('Frågan är felformad och kan inte besvaras.')
    }
    if (!innehåll.alternativ.includes(svar)) {
      // ALTERNATIVEN ÄR MÄNGDEN. Ett svar utanför den kan inte jämföras med
      // nästa förslag, och då är den strukturerade formen bortkastad.
      throw new BadRequestException(`"${svar}" är inte ett av frågans alternativ.`)
    }

    const anspråk = await this.prisma.aiAssignment.updateMany({
      where: { id: assignmentId, organizationId, status: 'AWAITING_APPROVAL' },
      data: { status: 'APPROVED', decidedAt: nu, decidedByUserId: userId, statusReason: svar },
    })
    if (anspråk.count !== 1) throw new BadRequestException('Frågan är redan besvarad.')

    // SVARET BLIR MINNE MED KÄLLA. `HUMAN_CONFIRMED` därför att en människa
    // just tryckte på alternativet — det är den starkaste grund som finns.
    const nyckel = svarsNyckel(
      fråga.sourceKind ?? 'OKÄND',
      fråga.sourceId ?? fråga.id,
      innehåll.fält,
    )
    // GENOM DEN ENDA SKRIVAREN. `check-ai-subjects` kräver det, och skälet är
    // inte formellt: en andra väg skriver minnen utan ämneskoppling, och då
    // slår anonymisering av en hyresgäst inte igenom i minnet.
    await upsertAiMemoryWithSubjects(this.prisma, {
      organizationId,
      userId,
      key: nyckel,
      value: svar,
      type: 'fact',
      provenans: {
        kind: 'HUMAN_CONFIRMED',
        sourceKind: 'ASSIGNMENT',
        sourceId: assignmentId,
        confirmedByUserId: userId,
        confirmedAt: nu,
      },
    })
  }

  /** Fältets etikett och lagliga alternativ — för läsytan. */
  static fält(nyckel: string) {
    return FRAGEBARA_FALT.find((f) => f.nyckel === nyckel)
  }
}
