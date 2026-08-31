import { ConflictException } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'

/**
 * CYKELSPÄRREN FÖR BYTESFÖLJDEN.
 *
 * ── VAD DATABASEN INTE KAN GÖRA ─────────────────────────────────────────────
 *
 * `UnitEquipment.replacedById` bär `@unique`, vilket spärrar FÖRGRENING: två
 * föregångare kan inte peka på samma efterträdare. Men en CYKEL (A → B → A)
 * bryter inte mot den: varje rad har fortfarande exakt en föregångare och en
 * efterträdare. Det är precis vad en cykel har.
 *
 * En cykel går heller inte sönder högljutt. Historiken skulle svara
 * EQUIPMENT_REPLACED för varje länk och se rimlig ut; den som följer kedjan
 * bakåt slutar aldrig. Fel utfall, inget fel — samma tysta form som resten av
 * defekterna i det här projektet.
 *
 * `check-equipment-chain.mjs` prövar att SPÄRRARNA STÅR I SCHEMAT. Den här
 * funktionen prövar att kedjan FAKTISKT är acyklisk, och måste anropas i samma
 * transaktion som skrivningen — annars kan två samtidiga länkningar var för sig
 * se acykliska ut och tillsammans sluta cirkeln.
 */

/** Hur långt vi följer kedjan innan vi ger upp och kallar det en cykel. */
const MAX_LÄNKAR = 1000

/**
 * Kastar om `predecessorId → successorId` skulle sluta en cirkel.
 *
 * Går framåt från den TÄNKTA efterträdaren: hittar vi föregångaren igen är
 * länken en cykel. Taket är en andra spärr — en redan trasig kedja i databasen
 * ska ge ett fel, inte en oändlig loop i den här funktionen.
 */
export async function assertNoEquipmentCycle(
  prisma: Pick<PrismaClient, 'unitEquipment'>,
  predecessorId: string,
  successorId: string,
): Promise<void> {
  if (predecessorId === successorId) {
    throw new ConflictException('Utrustning kan inte ersätta sig själv.')
  }

  let nuvarande: string | null = successorId
  for (let steg = 0; steg < MAX_LÄNKAR; steg++) {
    if (nuvarande === null) return // kedjan tar slut — ingen cykel
    if (nuvarande === predecessorId) {
      throw new ConflictException(
        'Bytesföljden skulle bli cirkulär: den tänkta efterträdaren ersätts redan, ' +
          'direkt eller indirekt, av utrustningen som ska bytas ut.',
      )
    }
    const rad: { replacedById: string | null } | null = await prisma.unitEquipment.findUnique({
      where: { id: nuvarande },
      select: { replacedById: true },
    })
    if (!rad) return // efterträdaren finns inte — FK:n avvisar det, inte vi
    nuvarande = rad.replacedById
  }

  throw new ConflictException(
    `Bytesföljden är längre än ${MAX_LÄNKAR} länkar — den är sannolikt redan cirkulär.`,
  )
}
