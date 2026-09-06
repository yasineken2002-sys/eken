import { Injectable } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { typenFörFörslaget } from '../delegation/delegation-birth'

/** Vad hyresvärden har beslutat om ett verktyg och en typ. */
export interface Beslutsunderlag {
  toolName: string
  /** Typen ur `prediction` (`SKUGGFALT[0]`), eller null för "alla typer". */
  typ: string | null
  godkända: number
  avvisade: number
  /** Antal AKTIVA delegationer som täcker verktyget. */
  delegerade: number
  senasteBeslut: Date | null
  /**
   * ── GODKÄNNANDEN I EN OBRUTEN SVIT ────────────────────────────────────────
   *
   * Antal godkännanden SEDAN det senaste avslaget. Skilt från `godkända`, som är
   * totalen, och skillnaden är hela poängen: ett mönster som brutits av ett nej
   * är inte ett mönster längre.
   *
   * Totalen duger för "har du gjort det här förut" (delegationens andra
   * godkännande). Sviten krävs för "gör du det här ALLTID" — och det är den
   * frågan ett delegationsFÖRSLAG ställer.
   */
  godkändaISvit: number
}

/**
 * OBSERVATIONSLAGRET — EN FRÅGA, INTE EN LAGRING.
 *
 * ── VARFÖR INGEN TABELL ─────────────────────────────────────────────────────
 *
 * Planens Del 7 kallar lager 2 *"mönster i ditt beslutsfattande"* och säger att
 * det uppstår genom att **systemet räknar ditt beteende**. En lagrad räknare hade
 * kunnat glida isär från de beslut den påstår sig sammanfatta, och avvikelsen
 * hade varit osynlig — samma skäl som att skuld är ett beräknat tillstånd och
 * att träffgraden aldrig lagras.
 *
 * Och viktigare: en tabell hade blivit ett nytt ställe att lita på. Frågan
 * härleds i stället ur beslut som redan finns och som människan själv fattade —
 * inkorgens godkännanden, delegationerna. Ingen ny sanning uppstår här.
 *
 * ── OBSERVATION ÄR INTE BEHÖRIGHET ──────────────────────────────────────────
 *
 * Planens Del 6, ordagrant: *"Eveno får observera … Det får ALDRIG automatiskt
 * bli 'agenten får boka rörmokare upp till 2 000 kr'."* Den här tjänsten
 * RETURNERAR TAL. Den skriver ingenting, den ger ingen rätt, och den har med
 * flit ingen metod som svarar ja/nej — ett `fårAgenten(...)` här hade varit
 * precis den genväg gränsen finns för att stänga.
 *
 * ── EN KÄLLA, TVÅ LÄSARE ────────────────────────────────────────────────────
 *
 * `kanBliDelegation` räknade tidigare tidigare godkännanden själv, inline. Den
 * läser nu härifrån. Två uppräkningar av "vad har hyresvärden godkänt" hade
 * kunnat svara olika om samma historik, och den som styr knappen hade varit den
 * ingen prövat.
 */
@Injectable()
export class ObservationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param typ när satt räknas bara förslag vars `prediction` bär samma typ.
   *   `null` betyder "alla typer av det här verktyget".
   * @param utom ett assignment-id som inte ska räknas — det aktuella fallet.
   *   Utan det räknar frågan in sig själv, och "en gång till" blir "en gång".
   */
  async beslutsunderlag(
    organizationId: string,
    toolName: string,
    typ: string | null = null,
    utom?: string,
  ): Promise<Beslutsunderlag> {
    // TYPAD SÅ ATT `organizationId` INTE KAN FALLA BORT. `check-spread-where`
    // (#703) fäller en spridning vars ursprung inte bevisligen bär org-id:t:
    // `{ ...undefined }` ger `{}`, och uppslaget korsar då org-gränsen tyst.
    // Typen gör det till ett kompileringsfel i stället för ett fynd.
    const bas: { organizationId: string } & Record<string, unknown> = {
      organizationId,
      // ── BARA BESLUT OM VERKTYGET, aldrig om delegationen ────────────────
      //
      // Ett avvisat DELEGATIONSFÖRSLAG är ett nej till att automatisera, inte
      // ett nej till att verktyget var rätt. Utan den här raden räknades det
      // som ett avslag i sviten och nollställde mönstret — alltså kunde ett
      // avvisat förslag ALDRIG komma tillbaka, hur många godkännanden som än
      // följde. Uppmätt: provet "avvisa + 3 nya godkännanden" fick `FOR_FA`
      // där det skulle få ett nytt förslag.
      //
      // Samma familj som "återanvänd inte ett fält som svarar på en annan
      // fråga", en nivå upp: två sorters beslut i samma tabell är inte samma
      // beslut.
      kind: 'TOOL_PROPOSAL',
      toolName,
      // BARA det en MÄNNISKA avgjort. Ett förslag som förföll eller väntar är
      // inget beslut, och att räkna det hade gjort tystnad till ett svar.
      decidedByUserId: { not: null },
      ...(utom ? { id: { not: utom } } : {}),
    }

    const [beslutade, aktivaDelegationer] = await Promise.all([
      this.prisma.aiAssignment.findMany({
        where: { ...bas, status: { in: ['APPROVED', 'REJECTED'] } },
        // ORDNAD, för att sviten alls ska gå att räkna. En osorterad lista
        // ger ett godtyckligt svar på "sedan det senaste avslaget".
        orderBy: { decidedAt: 'desc' },
        select: { status: true, prediction: true, decidedAt: true },
      }),
      // Delegationerna räknas på verktyget, inte på typen: villkoret kan vara
      // snävare än typen och prövas av `assertDelegated` per fall. Talet här
      // svarar "har du gett bort det här alls", inte "täcker det just detta".
      this.prisma.aiDelegation.findMany({
        where: { organizationId, toolName },
        select: { expiresAt: true, events: { select: { type: true, createdAt: true } } },
      }),
    ])

    const passar = (p: unknown) => typ === null || typenFörFörslaget(p) === typ
    const relevanta = beslutade.filter((r) => passar(r.prediction))

    const senaste = relevanta
      .map((r) => r.decidedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1)

    // STATUSEN BERÄKNAS, den läses inte ur en kolumn — importeras lokalt för att
    // hålla modulens toppimporter fria från delegationslagret i en fråga som
    // annars bara rör uppdrag.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { beräknaStatus } = require('../delegation/delegation-status') as {
      beräknaStatus: (h: { type: string; createdAt: Date }[], e: Date) => string
    }

    return {
      toolName,
      typ,
      godkända: relevanta.filter((r) => r.status === 'APPROVED').length,
      // AVVISADE RÄKNAS SEPARAT, aldrig som frånvaro av godkännanden. Planens
      // Del 7: "Att säga nej är också lärande. En agent som bara lär av ja:n
      // lär sig fel."
      avvisade: relevanta.filter((r) => r.status === 'REJECTED').length,
      delegerade: aktivaDelegationer.filter(
        (d) => beräknaStatus(d.events as never, d.expiresAt) === 'AKTIV',
      ).length,
      senasteBeslut: senaste ?? null,
      // SVITEN, räknad bakifrån: de senaste besluten först, och vi slutar
      // räkna vid det första nejet. `relevanta` är redan sorterad fallande.
      godkändaISvit: (() => {
        let n = 0
        for (const r of relevanta) {
          if (r.status !== 'APPROVED') break
          n++
        }
        return n
      })(),
    }
  }
}
