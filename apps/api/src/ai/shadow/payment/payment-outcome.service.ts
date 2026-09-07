import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { INGEN_AVI, OKAND_MOTPART, SKUGGKALLA_BANKRAD } from './payment-fields'
import { beloppsutfall } from './payment-candidates'

// VÄRDEIMPORT, inte `import type`: `Prisma.JsonNull` är ett VÄRDE och försvinner
// i runtime med en typimport. Samma familj som DTO-regeln i CLAUDE.md.
import { Prisma } from '@prisma/client'

/**
 * FACIT FÖR AGENT 2 — vad bankraden VISADE SIG höra till.
 *
 * ── FACIT ÄR MÄNNISKANS HANDLING, INTE AGENTENS ─────────────────────────────
 *
 * Skrivs när en människa avgjort raden i avstämningen:
 *
 *     matchade raden        outcome = { avi, belopp, motpart }
 *     lade den åt sidan     outcome = { avi: INGEN, … }
 *     hävde en matchning    outcome NOLLSTÄLLS — se nedan
 *
 * ── VARFÖR EN HÄVNING NOLLSTÄLLER I STÄLLET FÖR ATT SKRIVA `INGEN` ──────────
 *
 * En hävning säger att den FÖRRA matchningen var fel. Den säger ingenting om
 * vad som var rätt. Att skriva `INGEN` hade varit att påstå att raden inte hör
 * till någon avi — ett påstående ingen gjort — och träffgraden hade då räknat
 * ett okänt svar som ett facit. Nollställningen sätter tillbaka raden till
 * "vet inte", vilket är sant, och nästa matchning fyller i det riktiga svaret.
 *
 * ── KONTAMINERINGEN GÅR INTE ATT MÄTA BORT ──────────────────────────────────
 *
 * Förslaget står bredvid raden när människan väljer. Godkänner hen agentens
 * förslag är facit agentens eget svar i retur, och träffgraden mäter påverkan i
 * stället för riktighet. Det går inte att avgöra ur databasen — samma förbehåll
 * som `shadow-outcome.service.ts` bär, och här väger det tyngre eftersom
 * inkorgens Godkänn-knapp UTFÖR matchningen. Den som läser ett högt tal ska
 * veta att det delvis mäter hur övertygande knappen är.
 *
 * ── FIRE-AND-FORGET, MED SVÄLJD FÅNGST ──────────────────────────────────────
 *
 * Facitskrivningen får ALDRIG fälla avstämningen. En matchning som rullas
 * tillbaka för att en mätrad inte kunde skrivas vore att låta observationen
 * äta det den observerar. Anroparna kallar därför utan `await` på utfallet och
 * loggar felet.
 */
@Injectable()
export class PaymentOutcomeService {
  private readonly logger = new Logger(PaymentOutcomeService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Raden matchades mot en avi eller faktura. */
  async skrivFacitMatchad(
    organizationId: string,
    bankTransactionId: string,
    träffad: { id: string; utestaende: number; motpartId: string | null },
    inbetalt: number,
  ): Promise<void> {
    await this.skriv(organizationId, bankTransactionId, {
      avi: träffad.id,
      belopp: beloppsutfall(inbetalt, träffad.utestaende),
      motpart: träffad.motpartId ?? OKAND_MOTPART,
    })
  }

  /** Raden lades åt sidan — den hörde inte till någon avi. */
  async skrivFacitIngen(organizationId: string, bankTransactionId: string): Promise<void> {
    await this.skriv(organizationId, bankTransactionId, {
      avi: INGEN_AVI,
      belopp: 'FULL',
      motpart: OKAND_MOTPART,
    })
  }

  /** En matchning hävdes: facit är åter okänt. Se noten överst. */
  async nollstallFacit(organizationId: string, bankTransactionId: string): Promise<void> {
    const n = await this.prisma.aiAssignment.updateMany({
      where: {
        organizationId,
        shadow: true,
        sourceKind: SKUGGKALLA_BANKRAD,
        sourceId: bankTransactionId,
      },
      data: { outcome: Prisma.JsonNull, outcomeAt: null },
    })
    if (n.count > 0) {
      this.logger.log(
        `[ai-payment-shadow] facit nollställt för tx ${bankTransactionId} — matchningen hävdes.`,
      )
    }
  }

  /**
   * IDEMPOTENT: hela objektet skrivs som ett värde med `updateMany`, så samma
   * handling två gånger ger samma facit. Ingen rad → `count: 0`, vilket är det
   * normala fallet (skuggläget är av för nästan alla organisationer) och inte
   * ett fel.
   */
  private async skriv(
    organizationId: string,
    bankTransactionId: string,
    outcome: Record<string, string>,
  ): Promise<void> {
    const n = await this.prisma.aiAssignment.updateMany({
      where: {
        organizationId,
        shadow: true,
        sourceKind: SKUGGKALLA_BANKRAD,
        sourceId: bankTransactionId,
      },
      data: { outcome: outcome as Prisma.InputJsonObject, outcomeAt: new Date() },
    })
    if (n.count > 0) {
      this.logger.log(
        `[ai-payment-shadow] facit skrivet för tx ${bankTransactionId}: avi=${outcome['avi']}.`,
      )
    }
  }
}
