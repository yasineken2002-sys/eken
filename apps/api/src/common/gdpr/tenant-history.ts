import type { Prisma } from '@prisma/client'

/**
 * HISTORIK SOM GÖR EN HYRESGÄST OMÖJLIG ATT HÅRDRADERA.
 *
 * ── VARFÖR DEN HÄR LISTAN FINNS ─────────────────────────────────────────────
 *
 * Grinden i `TenantsService.remove` mätte tidigare fel egenskap. Den räknade
 * avtal med `status IN ('ACTIVE','DRAFT')` och fakturor med
 * `status NOT IN ('VOID','DRAFT')` — alltså STATUS. Men FK-villkoret i Postgres
 * bryr sig inte om status, det bryr sig om EXISTENS:
 *
 *     ERROR: update or delete on table "Tenant" violates foreign key constraint
 *            "Lease_tenantId_fkey" on table "Lease"
 *
 * Uppmätt: en hyresgäst med avslutat avtal och betalda avier gav 0 på båda
 * grindarna och föll sedan på ett rått FK-fel. `P2003` hanteras ingenstans i
 * kodbasen, så utfallet blev **500 Internal Server Error** — inte ett svar som
 * säger vad användaren ska göra i stället. 99,1 % av hyresgästerna i dev
 * (527 av 532) hamnade i det läget.
 *
 * Listan nedan är därför en spegling av VAD DATABASEN FAKTISKT ERFORDRAR: varje
 * relation som pekar på `Tenant` utan `onDelete`, och som därmed får Prismas
 * default `Restrict`.
 *
 * ── DEN HÄR LISTAN KAN GÅ BLIND ─────────────────────────────────────────────
 *
 * Lägger någon till en tolfte modell med FK mot `Tenant` utan att uppdatera
 * listan, börjar 500-felet om — tyst, och bara för hyresgäster som råkar ha just
 * den sortens historik. En uppräkning som ska spegla schemat är exakt den sorts
 * vakt som slutar mäta utan att sluta vara grön.
 *
 * Därför läser `tenant-history.spec.ts` `schema.prisma` och kräver att listan
 * är EXAKT lika med schemats Restrict-relationer mot `Tenant` — inte en
 * delmängd. Den har en kanariefågel som injicerar en påhittad relation och
 * kräver att kontrollen faller.
 */
export interface TenantHistoryRelation {
  /** Prisma-modellens namn, som det står i schema.prisma. */
  readonly model: string
  /** FK-kolumnen på den modellen som pekar på Tenant.id. */
  readonly column: string
  /** Svensk etikett för felmeddelandet till användaren. */
  readonly label: string
}

export const TENANT_HISTORY_RELATIONS: readonly TenantHistoryRelation[] = [
  { model: 'Lease', column: 'tenantId', label: 'hyresavtal' },
  { model: 'Invoice', column: 'tenantId', label: 'fakturor' },
  { model: 'Document', column: 'tenantId', label: 'dokument' },
  { model: 'Document', column: 'signedByTenantId', label: 'signerade dokument' },
  { model: 'MaintenanceTicket', column: 'tenantId', label: 'felanmälningar' },
  { model: 'RentNotice', column: 'tenantId', label: 'hyresavier' },
  { model: 'Inspection', column: 'tenantId', label: 'besiktningar' },
  { model: 'SentMessage', column: 'tenantId', label: 'skickade meddelanden' },
  { model: 'Deposit', column: 'tenantId', label: 'depositioner' },
  { model: 'KeyHandover', column: 'tenantId', label: 'nyckelkvittenser' },
  { model: 'ConsumptionCharge', column: 'tenantId', label: 'förbrukningsdebiteringar' },
  { model: 'MiscCharge', column: 'tenantId', label: 'övriga debiteringar' },
  // Revisionsspåret blockerar också, och står här av ärlighet snarare än av
  // nödvändighet: `remove` grindar på `anonymizedAt` FÖRE historiken, och en
  // loggrad finns bara om `anonymizedAt` är satt — så den här posten kan i
  // praktiken aldrig bli det som fäller en radering.
  //
  // Den utelämnas ändå inte. Listans kontrakt är "relationer som gör
  // hårdradering omöjlig", och den gör det. Utelämnas den blir listan beroende
  // av att en annan grind råkar ligga före — och den dagen någon flyttar den
  // grinden är 500-felet tillbaka.
  { model: 'TenantAnonymizationLog', column: 'tenantId', label: 'GDPR-revisionsspår' },
] as const

/** Prisma-delegatens namn för en modell: `RentNotice` → `rentNotice`. */
function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

/**
 * Returnerar etiketterna för den historik som faktiskt finns — tom lista betyder
 * att hyresgästen går att hårdradera.
 *
 * Räknar inte upp antal. Frågan grinden ställer är "finns det något", exakt som
 * FK-villkoret, och ett antal skulle antyda en gräns som inte finns.
 */
export async function findTenantHistory(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<string[]> {
  const found: string[] = []
  for (const rel of TENANT_HISTORY_RELATIONS) {
    // Delegaten slås upp dynamiskt eftersom listan är data, inte kod. Skulle en
    // modell försvinna ur schemat faller specen som håller listan mot schemat.
    const delegate = (tx as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[
      delegateName(rel.model)
    ]
    if (!delegate) {
      throw new Error(
        `[gdpr] TENANT_HISTORY_RELATIONS pekar på modellen ${rel.model}, som inte finns i ` +
          'Prisma-klienten. Listan och schemat har divergerat.',
      )
    }
    const n = await delegate.count({ where: { [rel.column]: tenantId }, take: 1 })
    if (n > 0 && !found.includes(rel.label)) found.push(rel.label)
  }
  return found
}
