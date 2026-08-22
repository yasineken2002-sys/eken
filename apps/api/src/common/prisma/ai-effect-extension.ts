import { currentAiOrigin } from '../ai-origin/ai-origin.context'
import { noteEffect } from '../ai-effects/ai-effects.context'
import type { AiEffectOperation } from '../ai-effects/ai-effects.context'

/**
 * MEKANISMEN som ger utfallskopplingen — inte en konvention verktygen ska följa.
 *
 * Extensionen ligger på `$allModels` och ser därför VARJE skrivning i systemet.
 * Den gör något bara när `currentAiOrigin()` är satt, alltså inne i en
 * AI-verktygskörning. Ett nytt verktyg, en ny tjänst eller en ny skrivväg ärver
 * spårbarheten utan att någon tänker på det.
 *
 * ── VILKA OPERATIONER ────────────────────────────────────────────────────────
 *
 * Bara de som ÄNDRAR något. Läsningar (`findFirst`, `findMany`, `count`,
 * `aggregate`) passerar orörda — ett revisionsspår över vad AI:n LÄSTE är en
 * annan fråga (och en integritetsfråga), och att blanda in den här hade gjort
 * "vad orsakade den här körningen" obesvarbar i bruset.
 *
 * `upsert` bokförs som CREATE eller UPDATE beroende på vad som faktiskt hände.
 * Det går att avgöra: Prisma returnerar raden, och en nyskapad rad har
 * `createdAt === updatedAt`. Modeller utan de fälten bokförs som UPSERT-fallet
 * UPDATE — konservativt, eftersom ett felaktigt CREATE hade påstått att AI:n
 * skapade något som redan fanns.
 *
 * ── VARFÖR RESULTATET LÄSES, INTE ARGUMENTEN ─────────────────────────────────
 *
 * För `create` finns id:t bara i RESULTATET (Prisma genererar uuid:t). För
 * `update` finns det i båda, men resultatet är det som faktiskt skrevs. Att läsa
 * `args.where.id` hade dessutom missat varje uppdatering som riktas på en annan
 * unik nyckel (`where: { organizationId_ocrNumber: … }`) — och just de vägarna
 * är vanliga i den här kodbasen.
 *
 * ── VARFÖR DEN INTE SKRIVER SJÄLV ────────────────────────────────────────────
 *
 * `$extends` ser inte anroparens transaktionsklient. En skrivning härifrån hade
 * gått på en egen anslutning, alltså UTANFÖR transaktionen, och en rollback hade
 * lämnat en effektrad som pekar på en entitet som aldrig blev till. Ett
 * revisionsspår som ljuger är värre än inget. Effekterna samlas därför i
 * kollektorn och persisteras en gång, med auditraden.
 */

/** Skrivoperationer vi bokför, och vad de betyder. */
const WRITE_OPS: Record<string, AiEffectOperation> = {
  create: 'CREATE',
  createMany: 'CREATE',
  createManyAndReturn: 'CREATE',
  update: 'UPDATE',
  updateMany: 'UPDATE',
  delete: 'DELETE',
  deleteMany: 'DELETE',
}

/** Modeller som är själva revisionsspåret. Att bokföra dem vore cirkulärt. */
const SJALVA_SPARET = new Set([
  'AiToolExecution',
  'AiToolEffect',
  'AiUsageLog',
  'AiMessage',
  'AiConversation',
  'AiTenantMessage',
  'AiTenantConversation',
])

function idAv(värde: unknown): string | null {
  if (värde && typeof värde === 'object' && 'id' in värde) {
    const id = (värde as { id: unknown }).id
    if (typeof id === 'string') return id
  }
  return null
}

/** Nyskapad rad? `createdAt === updatedAt` är sant exakt vid insert. */
function ärNyskapad(värde: unknown): boolean {
  if (!värde || typeof värde !== 'object') return false
  const r = värde as { createdAt?: unknown; updatedAt?: unknown }
  if (!(r.createdAt instanceof Date) || !(r.updatedAt instanceof Date)) return false
  return r.createdAt.getTime() === r.updatedAt.getTime()
}

function antalAv(resultat: unknown, fallback: number): number {
  if (resultat && typeof resultat === 'object' && 'count' in resultat) {
    const c = (resultat as { count: unknown }).count
    if (typeof c === 'number') return c
  }
  if (Array.isArray(resultat)) return resultat.length
  return fallback
}

export const aiEffectExtension = {
  name: 'ai-effect-tracking',
  query: {
    $allModels: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string
        operation: string
        args: unknown
        query: (args: unknown) => Promise<unknown>
      }) {
        const resultat = await query(args)

        // Utanför AI-vägen: ingenting. Kontrollen ligger EFTER anropet med flit —
        // extensionen får aldrig kunna ändra vad som faktiskt skrivs.
        if (!currentAiOrigin()) return resultat
        if (!model || SJALVA_SPARET.has(model)) return resultat

        if (operation === 'upsert') {
          noteEffect({
            entityType: model,
            entityId: idAv(resultat),
            operation: ärNyskapad(resultat) ? 'CREATE' : 'UPDATE',
            rowCount: 1,
          })
          return resultat
        }

        const op = WRITE_OPS[operation]
        if (!op) return resultat

        const flera = operation.endsWith('Many') || operation === 'createManyAndReturn'
        noteEffect({
          entityType: model,
          entityId: flera ? idAv(resultat) : idAv(resultat),
          operation: op,
          rowCount: antalAv(resultat, 1),
        })
        return resultat
      },
    },
  },
}
