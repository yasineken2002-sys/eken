import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { prövaDelegerbarhet } from '../delegation/delegation-scope'
import { SKUGGFALT } from '../shadow/shadow-fields'
import { ObservationService } from './observation.service'

/**
 * HUR MÅNGA GODKÄNNANDEN I OBRUTEN SVIT SOM GÖR ETT MÖNSTER.
 *
 * ── EGEN KONSTANT, INTE `MÖNSTERTRÖSKEL` ────────────────────────────────────
 *
 * `MÖNSTERTRÖSKEL = 1` svarar på en annan fråga: *får knappen "Gör alltid så
 * här" alls vara aktiv?* Där räcker ett tidigare ja, därför att MÄNNISKAN redan
 * har tagit initiativet — hon står i modalen och vill delegera.
 *
 * Här tar SYSTEMET initiativet, och då är ribban högre: tre godkännanden i rad
 * utan ett nej emellan. Ett enda ja kan vara ett undantag, två kan vara en slump
 * i två liknande ärenden; tre i obruten följd är det minsta tal som rimligen
 * beskriver en vana. Ett högre tal hade gjort funktionen oåtkomlig för en
 * hyresvärd med få ärenden — den som mest behöver den.
 *
 * Att låna `MÖNSTERTRÖSKEL` hade varit precis den betydelseglidning CLAUDE.md
 * varnar för: två gränser som ska kunna ändras var för sig är inte en gräns. En
 * sänkning av knappens tröskel hade då börjat skicka oombedda förslag.
 */
export const DELEGATIONSFORSLAG_TROSKEL = 3

/** Källmärkningen som skiljer ett mönsterfött förslag från ett ärendefött. */
export const DELEGATIONSKALLA_MONSTER = 'DELEGATION_PATTERN'

/** Vad ett pass gjorde för ETT mönster. Loggas alltid — se sveparen. */
export type ForslagUtfall =
  | { utfall: 'SKAPAT'; assignmentId: string; nivå: number }
  | { utfall: 'REDAN_FINNS' }
  | { utfall: 'FOR_FA'; svit: number }
  | { utfall: 'EJ_DELEGERBART'; skäl: string }
  | { utfall: 'REDAN_DELEGERAT' }

/**
 * DELEGATIONSFÖRSLAGET — planens "föreslår i stället för att ta sig rätt".
 *
 * ── DEN KRITISKA GRÄNSEN, I KOD ─────────────────────────────────────────────
 *
 * Planens Del 6: *"Eveno får observera … Det får ALDRIG automatiskt bli 'agenten
 * får boka rörmokare upp till 2 000 kr'."* Den här tjänsten SKRIVER ETT FÖRSLAG.
 * Den importerar inte `DelegationService`, den kan inte skapa en delegation, och
 * den har ingen väg till en. Vägen dit går fortfarande genom hyresvärdens tryck
 * på "Gör alltid så här" — förslaget är bara det som gör att frågan alls ställs.
 *
 * ── FYRA SPÄRRAR, OCH VAR OCH EN HAR SITT SKÄL ──────────────────────────────
 *
 * 1. Skuggagenten måste vara PÅ. Ett förslag om att automatisera något är
 *    meningslöst för en organisation som inte ens låter agenten föreslå.
 * 2. Verktyget måste vara DELEGERBART. Att föreslå en rätt som `assertDelegated`
 *    ändå skulle neka är att be om ett ja på något som inte går att ge.
 * 3. Ingen AKTIV delegation får redan finnas för verktyget — då är frågan
 *    besvarad.
 * 4. Inget ÖPPET förslag för samma mönster. Två kort om samma sak i inkorgen är
 *    inte två frågor, det är samma fråga två gånger.
 *
 * ── OCH IDEMPOTENSEN LIGGER I DATABASEN ─────────────────────────────────────
 *
 * Nyckeln är `<verktyg>|<typ>|<nivå>` under ett PARTIELLT unikt index. Två
 * samtidiga sveppass ger EN rad av databasen, inte av en kontroll som kan
 * förlora kapplöpningen — samma konstruktion som skuggproducenten.
 *
 * Nivån bär dessutom regeln om det avvisade förslaget, se `nivåFörSvit`.
 */
@Injectable()
export class DelegationProposalService {
  private readonly logger = new Logger(DelegationProposalService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly observation: ObservationService,
  ) {}

  /**
   * NIVÅN ETT MÖNSTER NÅTT — och därmed regeln för ett avvisat förslag.
   *
   * `3, 4, 5 → 3` · `6, 7, 8 → 6` · `9 → 9`.
   *
   * Avvisas förslaget på nivå 3 blir nästa nyckel nivå 6, som kräver TRE NYA
   * godkännanden i sviten. Regeln behöver alltså ingen egen kolumn och ingen
   * egen kontroll: den följer av att nyckeln bär nivån, och det unika indexet
   * gör resten. En separat "avvisad sedan"-flagga hade varit ett andra ställe
   * att hålla i synk.
   */
  static nivåFörSvit(svit: number): number {
    return Math.floor(svit / DELEGATIONSFORSLAG_TROSKEL) * DELEGATIONSFORSLAG_TROSKEL
  }

  /**
   * Pröva ETT mönster: ett verktyg och en typ i en organisation.
   *
   * @param nu injiceras av proven; ett pass mäter alla mönster mot samma klocka.
   */
  async prövaMönster(
    organizationId: string,
    toolName: string,
    typ: string,
    nu: Date = new Date(),
  ): Promise<ForslagUtfall> {
    // 2. DELEGERBART — prövas FÖRE databasen, det är den billigaste spärren och
    //    den enda som är ren funktion.
    const d = prövaDelegerbarhet(toolName)
    if (!d.delegerbar) return { utfall: 'EJ_DELEGERBART', skäl: d.text }

    const underlag = await this.observation.beslutsunderlag(organizationId, toolName, typ)

    // 3. REDAN DELEGERAT — frågan är besvarad.
    if (underlag.delegerade > 0) return { utfall: 'REDAN_DELEGERAT' }

    if (underlag.godkändaISvit < DELEGATIONSFORSLAG_TROSKEL) {
      return { utfall: 'FOR_FA', svit: underlag.godkändaISvit }
    }

    const nivå = DelegationProposalService.nivåFörSvit(underlag.godkändaISvit)
    const nyckel = `${toolName}|${typ}|${nivå}`

    // 4. INGET ÖPPET FÖRSLAG för samma mönster — oavsett nivå. Två kort om samma
    //    sak i inkorgen är samma fråga två gånger, inte två frågor.
    const öppet = await this.prisma.aiAssignment.findFirst({
      where: {
        organizationId,
        kind: 'DELEGATION_PROPOSAL',
        status: 'AWAITING_APPROVAL',
        sourceKind: DELEGATIONSKALLA_MONSTER,
        sourceId: { startsWith: `${toolName}|${typ}|` },
      },
      select: { id: true },
    })
    if (öppet) return { utfall: 'REDAN_FINNS' }

    try {
      const rad = await this.prisma.aiAssignment.create({
        data: {
          organizationId,
          kind: 'DELEGATION_PROPOSAL',
          // INTE `shadow`: ett ja här SKAPAR en rättighet. Se enumens docblock.
          shadow: false,
          sourceKind: DELEGATIONSKALLA_MONSTER,
          sourceId: nyckel,
          toolName,
          toolInput: {},
          title: `Vill du att agenten sköter ${toolName} för ${typ} själv?`,
          reasoning:
            `Du har godkänt ${toolName} för ${typ} ${underlag.godkändaISvit} gånger i rad ` +
            'utan att avvisa något däremellan. Vill du att agenten gör det själv i ' +
            'fortsättningen?',
          // KONSEKVENSEN SÄGER VAD ETT JA BETYDER, och att det går att ta
          // tillbaka. Utan den läser hyresvärden ett ja som en engångshandling.
          consequence:
            'Ett ja skapar en delegation: agenten får utföra det här utan att fråga varje ' +
            'gång, inom den avgränsning du väljer och i högst 90 dagar. Du kan pausa eller ' +
            'återkalla den när som helst på sidan Delegationer.',
          undoHint: 'Delegationen kan pausas eller återkallas när som helst.',
          // FÖRIFYLLT SCOPE, samma form som "Gör alltid så här": typen är det
          // mönstret handlar om. Objektet är det INTE — mönstret sträcker sig
          // över flera ärenden och därmed över flera lägenheter.
          prediction: { [SKUGGFALT[0]!.nyckel]: typ },
          deadline: new Date(nu.getTime() + 14 * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      })
      this.logger.log(`[ai-delegationsforslag] ${organizationId}: ${nyckel} → assignment ${rad.id}`)
      return { utfall: 'SKAPAT', assignmentId: rad.id, nivå }
    } catch (err: unknown) {
      // KAPPLÖPNINGENS RÄTTA UTFALL. Det partiella unika indexet avvisade en
      // andra rad för samma nyckel — det är precis vad det finns för, och inte
      // ett fel. Disambigueras på kolumnMÄNGDEN och inte på en delsträng: samma
      // regel som #649.
      if (ärDubblettPåMönstret(err)) return { utfall: 'REDAN_FINNS' }
      throw err
    }
  }
}

/**
 * Är felet en krock på just delegationsförslagets unika index?
 *
 * `AiAssignment` har FLERA unika villkor — skuggkällan och det här. En
 * `includes('sourceId')` hade svarat sant om fel krock, och utfallet vore att en
 * riktig dubblett på skuggkällan tystades som "förslaget fanns redan".
 */
function ärDubblettPåMönstret(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: string; meta?: { target?: unknown } }
  if (e.code !== 'P2002') return false
  const mål = e.meta?.target
  // Postgres rapporterar det partiella indexet vid NAMN, inte som kolumnlista.
  if (typeof mål === 'string') return mål === 'AiAssignment_delegation_proposal_unique'
  if (!Array.isArray(mål)) return false
  const fält = mål.map(String).sort()
  return (
    fält.length === 3 &&
    fält[0] === 'organizationId' &&
    fält[1] === 'sourceId' &&
    fält[2] === 'sourceKind'
  )
}
