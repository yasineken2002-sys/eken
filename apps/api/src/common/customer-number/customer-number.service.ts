import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Allokerar plattformsglobala, läsbara kundnummer i formatet `K-100001`,
 * `K-100002` … — en stabil, permanent identifierare per organisation att
 * söka/slå upp på i admin-portalen (till skillnad från det interna UUID:t
 * och det optionella orgNumber som saknas för privatpersoner/trial).
 *
 * Till skillnad från ContractNumberService (per org + år) är denna sekvens
 * GLOBAL — en enda rad i `CustomerNumberSequence`, vaktad av ett konstant id
 * ("GLOBAL"). Samma race-säkra UPSERT + atomär increment-mönster: Postgres
 * tar row-lock på raden så att två samtidiga org-skapanden köas i stället för
 * att dela ut samma nummer. Ett hål i serien (t.ex. om org-skapandet failar
 * efter allokering) är ofarligt — kundnumret är ingen BFL-reglerad serie — så
 * vi behöver ingen omslutande transaktion.
 *
 * Service:n är avsiktligt liten och självständig så den kan användas från både
 * AuthService.register (självregistrering) och PlatformOrganizationsService
 * (admin skapar konto) utan extra beroenden.
 */
@Injectable()
export class CustomerNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tilldela nästa kundnummer. Kan köras med eller utan pågående transaktion.
   * Returnerar det formaterade numret, t.ex. `K-100042`.
   */
  async allocate(tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.prisma

    const row = await client.customerNumberSequence.upsert({
      where: { id: 'GLOBAL' },
      create: { id: 'GLOBAL', lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })

    return formatCustomerNumber(row.lastNumber)
  }
}

/**
 * Formatterar ett löpnummer till kundnummer. Basoffset 100000 + sekvens ⇒
 * första kunden (sekvens 1) blir `K-100001`, sekvens 42 blir `K-100042`.
 * 6-siffrig bredd räcker till ~900 000 kunder innan formatet växer.
 */
export function formatCustomerNumber(sequence: number): string {
  return `K-${100000 + sequence}`
}
