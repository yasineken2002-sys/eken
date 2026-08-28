import * as crypto from 'crypto'

/**
 * INNEHÅLLSHASHEN FÖR EN BEKRÄFTAD ÅTGÄRD — en definition, två användningar.
 *
 * Hashen band ursprungligen bara en `confirm` till exakt den åtgärd AI:n
 * föreslog (SECURITY RISK 1): klienten skickar `toolName` + `toolInput`, servern
 * slår upp `AiPendingAction.toolInputHash` och vägrar utföra något som inte
 * föreslagits.
 *
 * Den bär nu en andra roll: den är också idempotensnyckeln för AI-skapade
 * verifikat (`ai-journal-source.ts`). Att det är SAMMA hash är poängen — se
 * nedan.
 *
 * ── VARFÖR DEN FLYTTADES HIT ────────────────────────────────────────────────
 *
 * `ai-assistant.service.ts` injicerar `ToolExecutorService`. Skulle exekveraren
 * importera hashen därifrån blir det en importcykel. Alternativet — en andra
 * kanonisering i exekveraren — är precis den sorts kopia som divergerar: två
 * kanoniseringar som sorterar olika ger två olika hashar för samma åtgärd, och
 * då slutar idempotensnyckeln vara idempotent utan att något blir rött.
 *
 * Modulen har därför inga beroenden alls utanför `node:crypto`.
 * `ai-assistant.service.ts` re-exporterar `hashPendingAction` så att befintliga
 * anropare (tenant-ai.service.ts, specar) är oförändrade.
 */

/**
 * Kanonisk (nyckel-sorterad) JSON så att hashen blir deterministisk oavsett
 * fältordning. Rekursiv — annars skulle ett nästlat objekt med omkastade
 * nycklar ge en annan hash för samma åtgärd.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return value
}

export function hashPendingAction(toolName: string, toolInput: Record<string, unknown>): string {
  const payload = JSON.stringify({ toolName, toolInput: canonicalize(toolInput) })
  return crypto.createHash('sha256').update(payload).digest('hex')
}
