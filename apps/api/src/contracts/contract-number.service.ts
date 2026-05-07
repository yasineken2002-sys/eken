import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

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
 * Service:n är avsiktligt liten och självständig — den kan användas både
 * från `LeasesService.transitionStatus`, från Bull-aktiveringsjobbet
 * och från ev. backfill-skript utan extra dependencies.
 */
@Injectable()
export class ContractNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tilldela ett nytt kontraktsnummer åt en organisation. Måste anropas
   * inom en pågående Prisma-transaktion (eller utan, då skapas en intern).
   * Skickar tillbaka det formaterade numret, t.ex. `KONT-2026-00042`.
   */
  async allocate(organizationId: string, tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.prisma
    const year = new Date().getFullYear()

    const row = await client.contractNumberSequence.upsert({
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
