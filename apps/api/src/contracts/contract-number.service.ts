import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

/**
 * Genererar fortlöpande kontraktsnummer per organisation och år i formatet
 * `KONT-{år}-{löpnummer:5}`. Tilldelas vid DRAFT → ACTIVE-aktivering.
 *
 * Sekvenstabellen (`ContractNumberSequence`) har sammansatt PK på
 * (organizationId, year). Vi använder en UPSERT med atomär increment som
 * pekar Postgres mot row-locket på den specifika raden — två samtidiga
 * aktiveringar i samma org+år hamnar i kö (RowExclusiveLock) istället för
 * att race:a och dela ut samma nummer två gånger. Detta är samma mönster
 * som invoice-numreringen använder.
 *
 * ── VARFÖR `tx` ÄR OBLIGATORISKT ────────────────────────────────────────────
 *
 * Argumentet var tidigare `tx?` med `?? this.prisma` som reserv, och
 * docblocket sa "eller utan, då skapas en intern" — vilket inte stämde: utan
 * `tx` gick upserten på POOLEN, helt utan omslutande transaktion. Tre av fyra
 * anropsplatser skickade `tx`; den fjärde (`import.service.ts`) gjorde det
 * inte, och där kunde `lease.create` falla med numret redan förbrukat.
 *
 * Att kravet nu bärs av TYPEN i stället för av en mening i det här blocket är
 * hela poängen: en valfri transaktion är den tysta varianten av felet.
 * Regel R4 i `check-sequence-allocation.mjs` håller formen borta.
 *
 * Service:n är avsiktligt liten och självständig — den kan användas både
 * från `LeasesService.transitionStatus`, från Bull-aktiveringsjobbet
 * och från ev. backfill-skript utan extra dependencies.
 */
@Injectable()
export class ContractNumberService {
  /**
   * Tilldela ett nytt kontraktsnummer åt en organisation. MÅSTE anropas med
   * transaktionsklienten från den `$transaction` som skriver avtalsraden
   * numret hör till. Skickar tillbaka det formaterade numret, t.ex.
   * `KONT-2026-00042`.
   */
  async allocate(organizationId: string, tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear()

    const row = await tx.contractNumberSequence.upsert({
      where: { organizationId_year: { organizationId, year } },
      create: { organizationId, year, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })

    return formatContractNumber(year, row.lastNumber)
  }
}

export function formatContractNumber(year: number, sequence: number): string {
  return `KONT-${year}-${String(sequence).padStart(5, '0')}`
}
