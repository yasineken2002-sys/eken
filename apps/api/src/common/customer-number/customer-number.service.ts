import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

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
 * att dela ut samma nummer.
 *
 * ── VARFÖR `tx` ÄR OBLIGATORISKT ────────────────────────────────────────────
 *
 * Argumentet var tidigare `tx?` med `?? this.prisma` som reserv. Båda
 * anroparna utelämnade det, så BÅDA allokerade på poolen och skrev
 * `Organization` som en separat sats: föll skrivningen var numret ändå
 * förbrukat. Unikheten höll — upserten är atomär i sig — men numret och raden
 * det hör till kunde inte längre rulla tillbaka tillsammans.
 *
 * Ett hål i just den här serien är ofarligt; kundnumret är ingen räkenskaps-
 * serie. Skälet att ändå kräva `tx` är att en valfri transaktion är den TYSTA
 * varianten av felet: signaturen ser säker ut, och bara den som läser
 * anropsplatsen ser att reserven används. Regel R4 i
 * `check-sequence-allocation.mjs` gör formen omöjlig att återinföra.
 *
 * Service:n är avsiktligt liten och självständig så den kan användas från både
 * AuthService.register (självregistrering) och PlatformOrganizationsService
 * (admin skapar konto) utan extra beroenden.
 */
@Injectable()
export class CustomerNumberService {
  /**
   * Tilldela nästa kundnummer. MÅSTE anropas med transaktionsklienten från den
   * `$transaction` som skriver organisationsraden numret hör till.
   * Returnerar det formaterade numret, t.ex. `K-100042`.
   */
  async allocate(tx: Prisma.TransactionClient): Promise<string> {
    const row = await tx.customerNumberSequence.upsert({
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
