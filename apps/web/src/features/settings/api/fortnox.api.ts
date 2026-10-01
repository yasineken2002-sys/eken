import { z } from 'zod'
import { get, post } from '@/lib/api'

const count = z.number().int().safe().nonnegative()
const ore = z.number().int().safe()
const dimension = z.enum(['COST_CENTER', 'PROJECT'])
const readSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    'RUNNING',
    'COMPLETE',
    'COMPLETE_WITH_UNCERTAINTY',
    'PARTIAL',
    'FAILED',
    'AUTH_LOST',
    'WRONG_COMPANY',
  ]),
  financialYearId: z.number().int().positive(),
  periodFrom: z.string(),
  periodTo: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  reason: z.string().nullable(),
  uncertainties: z.array(z.string()),
  coverage: z.record(
    z.object({ pages: count, totalPages: count, totalResources: count, itemsSeen: count }),
  ),
  summary: z
    .object({
      currency: z.literal('SEK'),
      totalOre: ore,
      byProperty: z.array(
        z.object({ propertyId: z.string(), propertyName: z.string(), amountOre: ore }),
      ),
      unmappedDimensions: z.array(
        z.object({ dimensionType: dimension, code: z.string(), amountOre: ore }),
      ),
      unallocatedOre: ore,
      uncertainRemovedOre: ore,
      evenoExportOre: ore,
    })
    .nullable(),
})

export const fortnoxStatusSchema = z.object({
  enabled: z.boolean(),
  connection: z
    .object({
      status: z.enum(['ACTIVE', 'AUTH_LOST', 'DISCONNECTED']),
      company: z.object({
        name: z.string().nullable(),
        orgNumber: z.string().nullable(),
        databaseNumber: z.number().int(),
      }),
      connectedAt: z.string(),
      disconnectedAt: z.string().nullable(),
      lastErrorClass: z.string().nullable(),
      lastErrorAt: z.string().nullable(),
    })
    .nullable(),
  mappings: z.array(
    z.object({
      id: z.string(),
      dimensionType: dimension,
      code: z.string(),
      propertyId: z.string(),
      propertyName: z.string(),
    }),
  ),
  latestRead: readSchema.nullable(),
  latestCompleteRead: readSchema.nullable(),
  exports: z.object({
    counts: z.object({ DRY_RUN_READY: count, BLOCKED: count, UNKNOWN: count, CONFIRMED: count }),
    needsReconciliation: count,
    sendingEnabled: z.literal(false),
    sendingDisabledReason: z.literal('IDEMPOTENCY_UNRESOLVED'),
  }),
})
export type FortnoxStatusResponse = z.infer<typeof fortnoxStatusSchema>
export type FortnoxReadView = z.infer<typeof readSchema>

const PREFIX = '/integrations/fortnox'

export async function getFortnoxStatus(): Promise<FortnoxStatusResponse> {
  return fortnoxStatusSchema.parse(await get<unknown>(`${PREFIX}/status`))
}

/** Server owns state/PKCE. Only the provider's authorization destination may be opened. */
export function validateFortnoxAuthUrl(value: unknown): string {
  const { authUrl } = z.object({ authUrl: z.string().url() }).parse(value)
  const url = new URL(authUrl)
  if (
    url.origin !== 'https://apps.fortnox.se' ||
    url.pathname !== '/oauth-v1/auth' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Ogiltig anslutningsadress')
  }
  return url.href
}

export async function connectFortnox(): Promise<string> {
  return validateFortnoxAuthUrl(await post<unknown>(`${PREFIX}/connect`))
}

export async function disconnectFortnox(): Promise<void> {
  z.object({ disconnected: z.literal(true) }).parse(await post<unknown>(`${PREFIX}/disconnect`))
}
