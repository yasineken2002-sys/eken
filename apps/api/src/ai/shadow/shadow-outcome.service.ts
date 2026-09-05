import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { SKUGGFALT, SKUGGKALLA_FELANMALAN } from './shadow-fields'

import type { Prisma } from '@prisma/client'

/**
 * FACIT — vad som FAKTISKT blev, skrivet bredvid vad agenten trodde.
 *
 * ── VARFÖR EN EGEN TJÄNST OCH INTE EN RAD I MAINTENANCE ─────────────────────
 *
 * `MaintenanceService` ska inte behöva veta att skuggläget finns. Den anropar en
 * tjänst som gör ingenting när det inte finns något förslag — riktningen är
 * densamma som vid skapandet: AI-lagret får bero på maintenance, aldrig tvärtom.
 *
 * ── IDEMPOTENT, OCH DET ÄR EN EGENSKAP HOS SKRIVNINGEN ──────────────────────
 *
 * Ett ärende kan avslutas två gånger — en människa som ändrar status fram och
 * tillbaka, en omkörning, ett dubbelklick. Skrivningen är ett `updateMany` på
 * (org, källa, källid) med hela `outcome` som värde: samma indata ger samma rad,
 * och det finns ingen räknare som kan öka en andra gång.
 *
 * `outcomeAt` sätts vid VARJE skrivning och inte bara den första. Det är ett
 * medvetet val: fältet svarar på "när mättes facit senast", inte "när stängdes
 * ärendet första gången" — den frågan har `MaintenanceTicket.completedAt`, och
 * två fält som svarar på samma sak är en glidning som väntar på att hända.
 *
 * ── VAD DEN HÄR TJÄNSTEN INTE KAN SE ────────────────────────────────────────
 *
 * Om människan ändrade kategori BARA för att agenten föreslog det. Facit är då
 * agentens eget förslag i retur, och träffgraden mäter påverkan i stället för
 * riktighet. Det går inte att avgöra ur databasen — och att inte kunna det ska
 * stå skrivet, för det är den enda kända vägen till ett för högt tal.
 */
@Injectable()
export class ShadowOutcomeService {
  private readonly logger = new Logger(ShadowOutcomeService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Skriv facit för ett avslutat ärende.
   *
   * @returns antal uppdaterade rader — 0 när ärendet inte hade något förslag,
   *          vilket är det normala fallet så länge skuggläget är av.
   */
  async skrivFacitForArende(
    organizationId: string,
    ticket: { id: string; category: string; priority: string; assignedToId?: string | null },
  ): Promise<number> {
    // BARA de fält som JÄMFÖRS. Att skriva hela ärendet hade gjort `outcome` till
    // en andra kopia av raden — en parallell sanningskälla, precis det planens
    // Del 16 förbjuder — och nycklarna hade kunnat glida från `prediction`.
    const outcome: Record<string, string> = {}
    const kalla: Record<string, unknown> = {
      category: ticket.category,
      priority: ticket.priority,
      assignedToId: ticket.assignedToId ?? null,
    }
    for (const { nyckel } of SKUGGFALT) {
      const v = kalla[nyckel]
      // NULL SKRIVS INTE. Ett fält utan värde i facit betyder "vi vet inte vad
      // som var rätt", och `jamforSkuggfalt` räknar då varken träff eller miss.
      // Att skriva null hade gett samma utfall — men bara av en slump i
      // jämförelsen, inte av ett beslut här.
      if (typeof v === 'string' && v !== '') outcome[nyckel] = v
    }

    const { count } = await this.prisma.aiAssignment.updateMany({
      where: {
        organizationId,
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: ticket.id,
      },
      data: {
        outcome: outcome as Prisma.InputJsonObject,
        outcomeAt: new Date(),
      },
    })
    if (count > 0) {
      this.logger.log(
        `[ai-shadow] facit skrivet för ärende ${ticket.id}: ${Object.keys(outcome).join(', ')}`,
      )
    }
    return count
  }
}
